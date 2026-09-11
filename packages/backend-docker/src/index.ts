/**
 * `@dsh-runbox/backend-docker` —— Docker / Podman 引擎后端。
 *
 * 走 **Engine API**（npipe / unix socket / tcp），不 shell out 到 `docker` CLI：
 * CLI 的可用性、PATH、输出文本格式都是易碎依赖，而 Engine API 是稳定的 HTTP 契约。
 *
 * 箱的形状（安全默认，全部在 `create()` 里一次性定死）：
 * 只读 rootfs + `/tmp`、`/run` 走 tmpfs · 工作区按围栏配置挂载 · 丢弃全部
 * capabilities · `no-new-privileges` · 默认无网络 · cgroup 限额。
 *
 * @module @dsh-runbox/backend-docker
 */

import type { Context } from '@deepseek-ai/cordis'

import {
  BackendUnavailableError,
  UnsupportedModeError,
  type BoxBackend,
  type BoxExecRequest,
  type BoxExecResult,
  type BoxHandle,
  type BoxSpec,
} from '@dsh-runbox/core'

import {
  candidateEndpoints,
  containerName,
  demuxStream,
  describeEndpoint,
  effectiveTmpfsPaths,
  engineRequest,
  LABELS,
  selectEndpoint,
  type EngineEndpoint,
} from './engine.ts'

export {
  candidateEndpoints,
  containerName,
  demuxStream,
  describeEndpoint,
  effectiveTmpfsPaths,
  EngineError,
  isAtOrUnder,
  parseDockerHost,
  pingEndpoint,
  selectEndpoint,
} from './engine.ts'
export type { DemuxedOutput, EngineEndpoint, EngineResponse } from './engine.ts'

/** 插件名。 */
export const name = '@dsh-runbox/backend-docker'

/** 依赖的 ctx 服务：执行地基。 */
export const inject = ['runbox'] as const

/** 后端名，用于 `BackendRegistry.select(preferred)` 与日志归因。 */
export const BACKEND_NAME = 'docker'

/**
 * 默认镜像。可用 `DSH_RUNBOX_IMAGE` 覆盖。
 *
 * 选 `bash:5.2` 而非 `alpine` 是因为官方 shell seam 是 **bash** 执行器，
 * 而 alpine 只有 `sh`——镜像里没有解释器，链路的最后一环就是断的。
 */
export const DEFAULT_IMAGE = 'bash:5.2'

/** 容器内的保活命令；箱靠它活着，等我们把命令 exec 进去。 */
const KEEPALIVE = ['sleep', 'infinity'] as const

/** 箱内进程数上限的默认值：防止 fork 炸弹拖垮宿主。 */
const DEFAULT_PIDS_LIMIT = 512

/** 箱内存上限的默认值（字节）。 */
const DEFAULT_MEMORY_BYTES = 1024 * 1024 * 1024

/** 默认 CPU 核数。 */
const DEFAULT_CPUS = 1

/** Windows 容器引擎拒绝建箱时的说明。 */
const THIS_MUST_BE_LINUX_MESSAGE =
  'dsh-runbox requires a Linux-container engine: Windows containers do not support a ' +
  'read-only root filesystem, so the promised file-effect confinement cannot be enforced. ' +
  'Switch Docker Desktop to Linux containers (or point DOCKER_HOST at a Linux engine).'

interface ContainerSummary {
  Id: string
  Created?: number
  Labels?: Record<string, string>
  State?: string
}

interface ExecInspect {
  ExitCode?: number | null
  Running?: boolean
}

function parseJson<T>(buffer: Buffer, what: string): T {
  try {
    return JSON.parse(buffer.toString('utf8')) as T
  } catch {
    throw new Error(`docker engine returned non-JSON for ${what}`)
  }
}

/**
 * Docker 引擎后端。
 *
 * 端点解析是**惰性且带候选列表**的：Windows 上 Docker Desktop 的管道名随版本
 * 变过（`docker_engine` → `dockerDesktopLinuxEngine`），写死一个必然在别人机器上
 * 失效，而失效的表现是"明明装了 Docker 却说不支持"。
 */
export class DockerBackend implements BoxBackend {
  readonly name = BACKEND_NAME

  readonly #candidates: EngineEndpoint[]
  readonly #timeoutMs: number
  readonly #image: string
  #endpoint: EngineEndpoint | undefined
  #engineOs: string | undefined
  #lastProbeDetail = 'not probed yet'

  constructor(options: {
    endpoints?: EngineEndpoint[]
    timeoutMs?: number
    image?: string
    env?: NodeJS.ProcessEnv
  } = {}) {
    this.#candidates = options.endpoints ?? candidateEndpoints(options.env)
    this.#timeoutMs = options.timeoutMs ?? 3000
    this.#image = options.image ?? options.env?.['DSH_RUNBOX_IMAGE'] ?? DEFAULT_IMAGE
  }

  /** 最近一次探测的结论，用于错误信息。 */
  get lastProbeDetail(): string {
    return this.#lastProbeDetail
  }

  /**
   * 探测引擎此刻是否可用。
   * @returns 可用 `true`；不可用 `false`，原因见 `lastProbeDetail`。
   */
  async probe(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
      this.#lastProbeDetail = 'aborted before probe'
      return false
    }
    const { endpoint, tried } = await selectEndpoint(this.#candidates, this.#timeoutMs)
    if (!endpoint) {
      this.#lastProbeDetail = `no reachable engine endpoint — tried: ${tried.join('; ') || 'none'}`
      return false
    }
    this.#endpoint = endpoint
    this.#lastProbeDetail = `ok (${describeEndpoint(endpoint)})`
    return true
  }

  /** 取得已解析的端点；没有就再探一次，仍失败则抛错。 */
  async #engine(): Promise<EngineEndpoint> {
    if (this.#endpoint) {
      return this.#endpoint
    }
    const { endpoint, tried } = await selectEndpoint(this.#candidates, this.#timeoutMs)
    if (!endpoint) {
      this.#lastProbeDetail = `no reachable engine endpoint — tried: ${tried.join('; ') || 'none'}`
      throw new BackendUnavailableError(this.#lastProbeDetail)
    }
    this.#endpoint = endpoint
    this.#lastProbeDetail = `ok (${describeEndpoint(endpoint)})`
    return endpoint
  }

  async #call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof engineRequest>> {
    const endpoint = await this.#engine()
    return engineRequest(endpoint, method, path, body, timeoutMs, signal)
  }

  /**
   * 确认引擎跑的是 **Linux 容器**。
   *
   * Windows 容器引擎不支持只读 rootfs（`invalid option: read-only mode is not
   * supported for Windows containers`），也就是说我们在那儿**兑现不了**承诺的
   * 文件效果围栏。此时唯一诚实的做法是拒绝建箱，而不是降级成一个可写 rootfs
   * 的"隔离"——后者会让上层以为有边界，而边界根本不存在。
   *
   * 这是 CI 的 windows-latest runner 抓出来的：它跑的是 Windows 容器引擎。
   */
  async #assertLinuxEngine(): Promise<void> {
    if (this.#engineOs !== undefined) {
      if (this.#engineOs !== 'linux') {
        throw new UnsupportedModeError(THIS_MUST_BE_LINUX_MESSAGE)
      }
      return
    }
    const info = await this.#call('GET', '/info', undefined, this.#timeoutMs * 5)
    const osType = parseJson<{ OSType?: string }>(info.body, 'info').OSType ?? 'unknown'
    this.#engineOs = osType
    if (osType !== 'linux') {
      throw new UnsupportedModeError(THIS_MUST_BE_LINUX_MESSAGE)
    }
  }

  /** 确保镜像在本地；不在则拉取。 */
  async ensureImage(image = this.#image): Promise<void> {
    try {
      await this.#call('GET', `/images/${encodeURIComponent(image)}/json`)
      return
    } catch {
      // 404 就走拉取；其它错误留给拉取再暴露一次
    }
    await this.#call(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(image)}`,
      undefined,
      600_000,
    )
  }

  /**
   * 创建一个箱。
   *
   * 失败时**必须清理**已创建的局部资源——否则失败一次就在宿主上留一个容器，
   * 而用户不会知道。
   */
  async create(spec: BoxSpec): Promise<BoxHandle> {
    await this.#assertLinuxEngine()
    await this.ensureImage(spec.image)

    const { confinement } = spec
    const mountSuffix = confinement.workspaceReadOnly ? ':ro' : ':rw'
    // 与工作区重叠的 tmpfs 路径必须剔除，否则后挂的 tmpfs 会盖住工作区，
    // 而且不报错。详见 effectiveTmpfsPaths 的说明。
    const tmpfsPaths = effectiveTmpfsPaths(confinement.tmpfsPaths, spec.workspaceMountPath)
    const tmpfs: Record<string, string> = {}
    for (const path of tmpfsPaths) {
      tmpfs[path] = 'rw,size=256m'
    }

    const created = await this.#call(
      'POST',
      `/containers/create?name=${encodeURIComponent(containerName(spec.sessionId))}`,
      {
        Image: spec.image,
        Cmd: [...KEEPALIVE],
        Tty: false,
        Labels: { [LABELS.managed]: '1', [LABELS.session]: spec.sessionId },
        WorkingDir: spec.workspaceMountPath,
        HostConfig: {
          NetworkMode: spec.network,
          ReadonlyRootfs: confinement.rootfsReadOnly,
          Tmpfs: tmpfs,
          Binds: [`${spec.workspaceRoot}:${spec.workspaceMountPath}${mountSuffix}`],
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: spec.limits.pidsLimit ?? DEFAULT_PIDS_LIMIT,
          Memory: spec.limits.memoryBytes ?? DEFAULT_MEMORY_BYTES,
          NanoCpus: Math.round((spec.limits.cpus ?? DEFAULT_CPUS) * 1_000_000_000),
        },
      },
    )

    const id = parseJson<{ Id?: string }>(created.body, 'containers/create').Id
    if (!id) {
      throw new Error('docker engine did not return a container id')
    }
    const handle: BoxHandle = {
      id,
      sessionId: spec.sessionId,
      state: 'created',
      createdAt: Date.now(),
    }

    try {
      await this.#call('POST', `/containers/${id}/start`, undefined, this.#timeoutMs * 5)
      return { ...handle, state: 'running' }
    } catch (error) {
      await this.#call('DELETE', `/containers/${id}?force=1&v=1`).catch(() => undefined)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * 在箱内执行一次命令。
   *
   * 超时通过中断 HTTP 等待实现，返回 `timedOut: true`。**注意**：箱内进程此时
   * 未必立刻消失——按进程树终止它需要独立的 kill 通道，排在 M3。在 M1 里，
   * 一个超时命令最迟会随箱的销毁而结束。
   */
  async exec(box: BoxHandle, request: BoxExecRequest): Promise<BoxExecResult> {
    const env = request.env
      ? Object.entries(request.env).map(([k, v]) => `${k}=${v}`)
      : undefined

    const created = await this.#call(
      'POST',
      `/containers/${box.id}/exec`,
      {
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: [...request.argv],
        WorkingDir: request.cwd,
        ...(env ? { Env: env } : {}),
      },
      this.#timeoutMs * 5,
      request.signal,
    )
    const execId = parseJson<{ Id?: string }>(created.body, 'exec/create').Id
    if (!execId) {
      throw new Error('docker engine did not return an exec id')
    }

    const startedAt = Date.now()
    const started = await this.#call(
      'POST',
      `/exec/${execId}/start`,
      { Detach: false, Tty: false },
      request.timeoutMs,
      request.signal,
    )
    const durationMs = Date.now() - startedAt
    const timedOut = started.status === 0
    const { stdout, stderr } = demuxStream(started.body)

    let exitCode: number | null = null
    try {
      const inspected = await this.#call('GET', `/exec/${execId}/json`)
      exitCode = parseJson<ExecInspect>(inspected.body, 'exec/inspect').ExitCode ?? null
    } catch {
      // 超时路径下 exec 状态可能还不可读；保持 exitCode 为 null 并如实上报 timedOut
    }

    return {
      exitCode,
      stdout,
      stderr: timedOut
        ? `${stderr}\n[runbox] command timed out after ${String(request.timeoutMs ?? 0)}ms`
        : stderr,
      durationMs,
      timedOut,
    }
  }

  /** 停止箱。箱子可能已经停了——这不是错误。 */
  async stop(box: BoxHandle): Promise<void> {
    try {
      await this.#call('POST', `/containers/${box.id}/stop?t=5`, undefined, 30_000)
    } catch (error) {
      if (await this.#exists(box)) {
        throw error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  async #exists(box: BoxHandle): Promise<boolean> {
    try {
      await this.#call('GET', `/containers/${box.id}/json`)
      return true
    } catch {
      return false
    }
  }

  /** 移除箱及其匿名卷。幂等：箱不存在也返回成功。 */
  async remove(box: BoxHandle): Promise<void> {
    try {
      await this.#call('DELETE', `/containers/${box.id}?force=1&v=1`, undefined, 60_000)
    } catch (error) {
      if (await this.#exists(box)) {
        throw error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  /**
   * 列出本后端持有的箱——孤儿回收的依据。
   *
   * 按标签筛选而不是按名字前缀：名字可以被用户改，标签不能。
   */
  async list(): Promise<BoxHandle[]> {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`${LABELS.managed}=1`] }),
    )
    const response = await this.#call('GET', `/containers/json?all=1&filters=${filters}`)
    const containers = parseJson<ContainerSummary[]>(response.body, 'containers/json')
    return containers.map((c) => ({
      id: c.Id,
      sessionId: c.Labels?.[LABELS.session] ?? '',
      state: c.State === 'running' ? 'running' : 'stopped',
      createdAt: (c.Created ?? 0) * 1000,
    }))
  }
}

/**
 * Cordis 插件入口：把后端注册进执行地基。
 * @param ctx - 所属上下文，`ctx.runbox` 已由 `@dsh-runbox/core` 提供。
 */
export function apply(ctx: Context): void {
  ctx.runbox.use(new DockerBackend())
}
