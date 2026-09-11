/**
 * `@dsh-runbox/backend-docker` —— Docker / Podman 引擎后端。
 *
 * 走 **Engine API**（npipe / unix socket / tcp），不 shell out 到 `docker` CLI：
 * CLI 的可用性、PATH、输出文本格式都是易碎依赖，而我们要的是稳定的 HTTP 契约。
 *
 * 当前状态：`probe()` 是**真实可用**的（M0），箱生命周期的其余方法排在 M1。
 * 这样设计是因为 `probe()` 是 fail-closed 的入口——它必须先是真的，其余能力
 * 才谈得上安全。
 *
 * @module @dsh-runbox/backend-docker
 */

import { request } from 'node:http'
import { platform } from 'node:process'

import {
  RunboxNotImplementedError,
  type BoxBackend,
  type BoxExecRequest,
  type BoxExecResult,
  type BoxHandle,
  type BoxSpec,
} from '@dsh-runbox/core'
import type { Context } from '@deepseek-ai/cordis'

/** 插件名。 */
export const name = '@dsh-runbox/backend-docker'

/** 依赖的 ctx 服务：执行地基。 */
export const inject = ['runbox'] as const

/** 后端名，用于 `BackendRegistry.select(preferred)` 与日志归因。 */
export const BACKEND_NAME = 'docker'

/** 引擎端点：一个 socket 路径，或一个 `host:port`。 */
export interface EngineEndpoint {
  /** 传输方式，决定 `socketPath` 还是 `host`/`port` 生效。 */
  readonly kind: 'socket' | 'tcp'
  /** npipe 或 unix socket 路径（`kind === 'socket'` 时存在）。 */
  readonly socketPath?: string
  /** TCP 主机（`kind === 'tcp'` 时存在）。 */
  readonly host?: string
  /** TCP 端口（`kind === 'tcp'` 时存在）。 */
  readonly port?: number
}

/**
 * 解析引擎端点。纯函数，便于测试——端点解析错了，`probe()` 会一路错到底。
 *
 * 优先级：
 * 1. `DOCKER_HOST` 环境变量（`unix://`、`npipe://`、`tcp://`、`http://`）
 * 2. 平台默认值：Windows 是 `\\.\pipe\docker_engine`，其余是 `/var/run/docker.sock`
 *
 * @param env - 环境变量表；缺省用当前进程环境。
 * @returns 解析出的端点。
 */
export function resolveEngineEndpoint(env: NodeJS.ProcessEnv = process.env): EngineEndpoint {
  const raw = env['DOCKER_HOST']?.trim()
  if (raw) {
    if (raw.startsWith('npipe://')) {
      // Docker 的 npipe URI 形如 npipe:////./pipe/docker_engine
      return { kind: 'socket', socketPath: `//./pipe/${raw.slice('npipe:////./pipe/'.length)}` }
    }
    if (raw.startsWith('unix://')) {
      return { kind: 'socket', socketPath: raw.slice('unix://'.length) }
    }
    if (raw.startsWith('tcp://') || raw.startsWith('http://')) {
      const rest = raw.replace(/^(tcp|http):\/\//, '')
      const [host, port] = rest.split(':')
      return { kind: 'tcp', host: host ?? '127.0.0.1', port: Number(port ?? 2375) }
    }
  }
  if (platform === 'win32') {
    return { kind: 'socket', socketPath: '//./pipe/docker_engine' }
  }
  return { kind: 'socket', socketPath: '/var/run/docker.sock' }
}

/** `/ _ping` 的结果。 */
export interface PingResult {
  /** 引擎是否应答成功。 */
  readonly ok: boolean
  /** 失败原因，成功时为空。 */
  readonly detail: string
  /** 引擎报告的 API 版本，成功时存在。 */
  readonly apiVersion?: string
}

/**
 * 向引擎发一次 `_ping`。
 *
 * 刻意**从不抛错**：探测失败的语义是"这个后端不可用"，而不是"程序坏了"。
 * 抛错会把一条正常的降级路径变成异常路径。
 *
 * @param endpoint - 要探测的端点。
 * @param timeoutMs - 超时（毫秒）。
 * @returns ping 结果。
 */
export function pingEngine(endpoint: EngineEndpoint, timeoutMs = 3000): Promise<PingResult> {
  return new Promise<PingResult>((resolve) => {
    const options =
      endpoint.kind === 'socket'
        ? { socketPath: endpoint.socketPath ?? '', path: '/_ping', method: 'GET' as const }
        : {
            host: endpoint.host ?? '127.0.0.1',
            port: endpoint.port ?? 2375,
            path: '/_ping',
            method: 'GET' as const,
          }

    const req = request(options, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => {
        const apiVersion = res.headers['api-version']
        resolve({
          ok: res.statusCode === 200,
          detail: res.statusCode === 200 ? '' : `unexpected status ${String(res.statusCode)}`,
          ...(typeof apiVersion === 'string' ? { apiVersion } : {}),
        })
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`ping timed out after ${timeoutMs}ms`))
    })
    req.on('error', (error: Error) => {
      resolve({ ok: false, detail: error.message })
    })
    req.end()
  })
}

/**
 * Docker 引擎后端。
 *
 * `probe()` 已实现；箱生命周期方法在 M1 落地。未实现的方法**抛错而不是返回空**，
 * 因为一个静默空转的后端会让上层误以为隔离已经生效。
 */
export class DockerBackend implements BoxBackend {
  readonly name = BACKEND_NAME

  readonly #endpoint: EngineEndpoint
  readonly #timeoutMs: number

  constructor(endpoint: EngineEndpoint = resolveEngineEndpoint(), timeoutMs = 3000) {
    this.#endpoint = endpoint
    this.#timeoutMs = timeoutMs
  }

  /** 本后端使用的引擎端点。 */
  get endpoint(): EngineEndpoint {
    return this.#endpoint
  }

  /**
   * 探测引擎此刻是否可用。
   * @param signal - 取消信号（当前实现只在调用前检查一次）。
   * @returns 可用 `true` / 不可用 `false`。
   */
  async probe(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
      return false
    }
    const result = await pingEngine(this.#endpoint, this.#timeoutMs)
    return result.ok
  }

  /** @throws RunboxNotImplementedError - 排在 M1。 */
  create(_spec: BoxSpec): Promise<BoxHandle> {
    return Promise.reject(new RunboxNotImplementedError('DockerBackend.create', 'M1'))
  }

  /** @throws RunboxNotImplementedError - 排在 M1。 */
  exec(_box: BoxHandle, _request: BoxExecRequest): Promise<BoxExecResult> {
    return Promise.reject(new RunboxNotImplementedError('DockerBackend.exec', 'M1'))
  }

  /** @throws RunboxNotImplementedError - 排在 M1。 */
  stop(_box: BoxHandle): Promise<void> {
    return Promise.reject(new RunboxNotImplementedError('DockerBackend.stop', 'M1'))
  }

  /** @throws RunboxNotImplementedError - 排在 M1。 */
  remove(_box: BoxHandle): Promise<void> {
    return Promise.reject(new RunboxNotImplementedError('DockerBackend.remove', 'M1'))
  }

  /** @throws RunboxNotImplementedError - 排在 M1。 */
  list(): Promise<BoxHandle[]> {
    return Promise.reject(new RunboxNotImplementedError('DockerBackend.list', 'M1'))
  }
}

/**
 * Cordis 插件入口：把后端注册进执行地基。
 * @param ctx - 所属上下文，`ctx.runbox` 已由 `@dsh-runbox/core` 提供。
 */
export function apply(ctx: Context): void {
  ctx.runbox.use(new DockerBackend())
}
