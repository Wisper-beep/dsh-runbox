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

import { PassThrough } from 'node:stream'

import type { Context } from '@deepseek-ai/cordis'

import {
  BackendUnavailableError,
  UnsupportedModeError,
  type BoxBackend,
  type BoxExecRequest,
  type BoxExecResult,
  type BoxExecStream,
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
  engineHijack,
  engineStream,
  FrameDemuxer,
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
  FrameDemuxer,
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

/**
 * 我方运行时目录：pid 文件与 stdin 暂存都放这里。
 *
 * 刻意**不在工作区里**——内部状态写进用户仓库是不可接受的；也刻意放在 tmpfs
 * 上，因为 rootfs 是只读的，只有 tmpfs 可写。
 */
export const RUNBOX_RUNTIME_DIR = '/runbox'

/**
 * 推导箱内可写的运行时目录。
 *
 * 正常情况下就是 `/runbox`；只有当它与工作区发生重叠而被 `effectiveTmpfsPaths`
 * 剔除时（比如工作区就是 `/`），才回落到 `/tmp` 或 `/run`。
 *
 * @param spec - 建箱时的规格。
 * @returns 本次箱内可用的运行时目录。
 */
export function runtimeDirFor(spec: BoxSpec): string {
  const effective = effectiveTmpfsPaths(
    [...spec.confinement.tmpfsPaths, RUNBOX_RUNTIME_DIR],
    spec.workspaceMountPath,
  )
  if (effective.includes(RUNBOX_RUNTIME_DIR)) {
    return RUNBOX_RUNTIME_DIR
  }
  return effective.find((path) => path === '/tmp' || path === '/run') ?? '/tmp'
}

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
  readonly #specs = new Map<string, BoxSpec>()
  #endpoint: EngineEndpoint | undefined
  #engineOs: string | undefined
  #lastProbeDetail = 'not probed yet'
  /** 最近一次终止尝试的结论，供诊断；空白表示还没终止过。 */
  lastTerminateDetail = ''

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
    //
    // RUNBOX_RUNTIME_DIR 是我们自己的运行时目录（pid 文件、stdin 暂存），
    // 必须可写且**不能落在工作区里**——否则会把内部状态写进用户的仓库。
    const tmpfsPaths = effectiveTmpfsPaths(
      [...confinement.tmpfsPaths, RUNBOX_RUNTIME_DIR],
      spec.workspaceMountPath,
    )
    const tmpfs: Record<string, string> = {}
    for (const path of tmpfsPaths) {
      tmpfs[path] = path === RUNBOX_RUNTIME_DIR ? 'rw,size=16m,mode=1777' : 'rw,size=256m'
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
          // 只补回 DAC_OVERRIDE：容器内的 root 需要它才能写入宿主用户拥有的目录。
          // 工作区挂载通常属于宿主用户（模式 0700 的临时目录、受权限保护的仓库
          // 比比皆是），丢掉这个能力会让**工作区写入静默失败**——CI 抓到过。
          //
          // 安全性不受影响：真正要守的两条边界（只读 rootfs、只读工作区）由
          // **挂载标志**在挂载命名空间层面强制，报的是 EROFS，与文件权限位无关，
          // DAC_OVERRIDE 绕不过去。这里换来的只是"箱内 root 等价于普通 Docker
          // 容器里的 root"。
          CapAdd: ['DAC_OVERRIDE'],
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
      this.#specs.set(id, spec)
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
    if (request.stdin === 'pipe') {
      // 批式路径没有可写流可给，静默忽略会让调用方以为自己在交互。
      throw new Error("batch exec cannot use stdin: 'pipe' — use startExec() instead")
    }
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

  /**
   * 启动一次**流式**执行并立即返回活句柄。
   *
   * 与批式 `exec()` 的区别是语义上的，不是性能上的：`spawn` 的契约要求
   * "立即返回一个活句柄"，所以不能等进程结束。
   *
   * 进程树终止靠 pid 文件：argv 被包了一层，真实进程的 pid 落在我方运行时
   * 目录里（tmpfs，且刻意不在工作区内）。`exec` 后 shell 被替换掉，因此记下的
   * pid 就是目标进程本身的 pid。终止时再从那个 pid 出发扫整棵进程树。
   */
  async startExec(box: BoxHandle, request: BoxExecRequest): Promise<BoxExecStream> {
    const spec = this.#specs.get(box.id)
    const runtimeDir = spec ? runtimeDirFor(spec) : RUNBOX_RUNTIME_DIR
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const pidFile = `${runtimeDir}/${nonce}.pid`

    const wantsStdinPipe = request.stdin === 'pipe'

    // 批式 stdin：把内容先落到箱内的临时文件，再用重定向喂给命令。这样不需要
    // hijack 连接，而语义与"写入这些字节后关闭 stdin"完全一致。交互式 stdin
    // （`'pipe'`）走另一条路——那条必须劫持连接，见下面的分支。
    let stdinPath: string | undefined
    if (typeof request.stdin === 'object') {
      stdinPath = `${runtimeDir}/${nonce}.stdin`
      const payload = Buffer.from(request.stdin.data, 'utf8').toString('base64')
      const seeded = await this.exec(box, {
        argv: [
          'bash',
          '-c',
          'printf %s "$1" | base64 -d > "$2"',
          'dsh-runbox',
          payload,
          stdinPath,
        ],
        cwd: runtimeDir,
      })
      if (seeded.exitCode !== 0) {
        throw new Error(`failed to stage stdin inside the box: ${seeded.stderr}`)
      }
    }

    // 重定向：交互式 stdin **不能加任何重定向**，否则会把劫持来的输入整条丢掉。
    // 第一版正是漏了这条——包装脚本把 stdin 指向 /dev/null，劫持白做，CI 抓出来了。
    const redirect = wantsStdinPipe ? '' : stdinPath ? `< ${stdinPath}` : '< /dev/null'
    const wrapped = [
      'bash',
      '-c',
      `echo $$ > ${pidFile}; exec "$@" ${redirect}`,
      'dsh-runbox',
      ...request.argv,
    ]
    const env = request.env
      ? Object.entries(request.env).map(([key, value]) => `${key}=${value}`)
      : undefined

    const created = await this.#call('POST', `/containers/${box.id}/exec`, {
      AttachStdin: wantsStdinPipe,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: wrapped,
      WorkingDir: request.cwd,
      ...(env ? { Env: env } : {}),
    })
    const execId = parseJson<{ Id?: string }>(created.body, 'exec/create').Id
    if (!execId) {
      throw new Error('docker engine did not return an exec id')
    }

    const endpoint = await this.#engine()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const demuxer = new FrameDemuxer(
      (chunk) => stdout.write(chunk),
      (chunk) => stderr.write(chunk),
    )

    // 交互式 stdin 必须劫持连接：普通响应只能单向读，而 `'pipe'` 要求调用方在
    // 进程运行期间持续写入。劫持之后整条连接是裸字节流，stdin 不参与多路复用，
    // 读到的部分仍然带帧头，所以还是喂给同一个拆帧器。
    let stdinPipe: PassThrough | undefined
    let onData: (chunk: Buffer) => void
    let completion: Promise<void>

    if (wantsStdinPipe) {
      const hijacked = await engineHijack(
        endpoint,
        'POST',
        `/exec/${execId}/start`,
        { Detach: false, Tty: false },
        request.signal,
      )
      if (hijacked.head.length > 0) {
        demuxer.push(hijacked.head)
      }
      hijacked.socket.on('data', (chunk: Buffer) => {
        demuxer.push(chunk)
      })
      stdinPipe = new PassThrough()
      stdinPipe.on('data', (chunk: Buffer) => {
        hijacked.socket.write(chunk)
      })
      // 半关闭：告诉箱里"输入到此为止"，而不是杀进程。
      stdinPipe.on('end', () => {
        hijacked.socket.end()
      })
      onData = () => undefined
      completion = new Promise<void>((resolve) => {
        hijacked.socket.on('end', () => resolve())
        hijacked.socket.on('close', () => resolve())
        hijacked.socket.on('error', () => resolve())
      })
    } else {
      const response = await engineStream(
        endpoint,
        'POST',
        `/exec/${execId}/start`,
        { Detach: false, Tty: false },
        request.signal,
      )
      if (response.statusCode !== 200) {
        throw new Error(`docker engine refused exec start: HTTP ${String(response.statusCode)}`)
      }
      onData = (chunk: Buffer) => {
        demuxer.push(chunk)
      }
      response.on('data', onData)
      completion = new Promise<void>((resolve) => {
        response.on('end', () => resolve())
        response.on('close', () => resolve())
        response.on('error', () => resolve())
      })
    }
    void onData

    const done = new Promise<{ exitCode: number | null }>((resolve) => {
      const settle = async (): Promise<void> => {
        let exitCode: number | null = null
        try {
          const inspected = await this.#call('GET', `/exec/${execId}/json`)
          exitCode = parseJson<ExecInspect>(inspected.body, 'exec/inspect').ExitCode ?? null
        } catch {
          // 连接断了就取不到退出码；如实报 null 而不是编一个
        }
        stdout.end()
        stderr.end()
        stdinPipe?.end()
        resolve({ exitCode })
      }
      void completion.then(() => settle())
    })

    return {
      stdout,
      stderr,
      ...(stdinPipe ? { stdin: stdinPipe } : {}),
      done,
      terminate: (): void => {
        void this.#terminateTree(box, pidFile, request.timeoutMs ?? 5000)
      },
      waitForExit: async (signal?: AbortSignal): Promise<boolean> => {
        if (!signal) {
          await done
          return true
        }
        return Promise.race([
          done.then(() => true),
          new Promise<boolean>((resolve) => {
            if (signal.aborted) {
              resolve(false)
              return
            }
            signal.addEventListener('abort', () => resolve(false), { once: true })
          }),
        ])
      },
    }
  }

  /** 按进程树终止：先 SIGTERM，宽限期后 SIGKILL。 */
  async #terminateTree(box: BoxHandle, pidFile: string, graceMs: number): Promise<void> {
    const pid = await this.#readPidFile(box, pidFile)
    if (pid === undefined) {
      // 连 pid 都拿不到：要么进程早已退出（无事可做，正确），要么包装脚本还没跑到
      // 写 pid 那一步。后者曾经被静默吞掉——调用方以为叫停了，进程却继续跑到底。
      // 这里如实记下结论而不是假装成功，便于上层与日志归因。
      this.lastTerminateDetail = `box ${box.id}: no pid resolvable within budget`
      return
    }
    this.lastTerminateDetail = `box ${box.id}: signalling ${String(pid)}`
    await this.#signalTree(box, pid, 'TERM')
    setTimeout(() => {
      void this.#signalTree(box, pid, 'KILL')
    }, graceMs)
  }

  /**
   * 读取包装脚本写下的 pid，**轮询而不是单次读取**。
   *
   * 单次读取有过真实的失败模式（CI 上两次运行结果不同）：调用方在 pid 文件就绪前
   * 触发终止，于是它静默什么都不做。轮询把这个窗口收窄到"进程确实没起来"，
   * 而那本来就无事可做。
   *
   * @param box - 目标箱。
   * @param pidFile - 包装脚本写入 pid 的路径。
   * @param budgetMs - 等待预算。
   * @returns 目标进程的 pid；预算内始终拿不到时返回 `undefined`。
   */
  async #readPidFile(
    box: BoxHandle,
    pidFile: string,
    budgetMs = 3000,
  ): Promise<number | undefined> {
    const deadline = Date.now() + budgetMs
    for (;;) {
      const read = await this.exec(box, {
        argv: ['bash', '-c', `cat ${pidFile} 2>/dev/null || true`],
        cwd: RUNBOX_RUNTIME_DIR,
      })
      const pid = Number.parseInt(read.stdout.trim(), 10)
      if (Number.isFinite(pid) && pid > 0) {
        return pid
      }
      if (Date.now() >= deadline) {
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  /**
   * 向**整棵进程树**发信号。
   *
   * 为什么不能只 `kill -TERM -<pid>`：那依赖"exec 出来的进程是进程组首进程"，
   * 而 Docker 的 exec 并不保证这一点。CI 上实测到的后果很典型——直接子进程被杀，
   * 孙进程被 reparent 到 1 之后继续跑，而 `waitForExit` 已经返回"已退出"，
   * 于是调用方以为清理干净了。
   *
   * 因此改为扫 `/proc`：**先自底向上收集后代，再逐个发信号**。顺序是关键，
   * 先杀父会让子进程 reparent，之后就再也找不到它们。只用 `/proc` 与 shell
   * 内建，不假设镜像里装了 `pgrep` / `ps`。
   */
  async #signalTree(box: BoxHandle, pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
    const script = [
      'sig="$1"; root="$2"',
      'children() {',
      '  for d in /proc/[0-9]*; do',
      '    p="${d#/proc/}"',
      '    while read -r k v _; do',
      '      if [ "$k" = "PPid:" ] && [ "$v" = "$1" ]; then printf "%s\\n" "$p"; break; fi',
      '    done < "$d/status" 2>/dev/null',
      '  done',
      '}',
      'sweep() {',
      '  for c in $(children "$1"); do sweep "$c"; done',
      '  kill -"$sig" "$1" 2>/dev/null || true',
      '}',
      'sweep "$root"',
    ].join('\n')
    await this.exec(box, {
      argv: ['bash', '-c', script, 'dsh-runbox', signal, String(pid)],
      cwd: RUNBOX_RUNTIME_DIR,
    })
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
    } finally {
      this.#specs.delete(box.id)
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
