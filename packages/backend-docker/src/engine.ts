/**
 * Docker / Podman Engine API 的最小客户端。
 *
 * 刻意的设计选择：**不 shell out 到 `docker` CLI**。CLI 的 PATH、输出文本格式、
 * 版本差异都是易碎依赖，而 Engine API 是稳定的 HTTP 契约。
 *
 * @module @dsh-runbox/backend-docker/engine
 */

import { request } from 'node:http'
import { platform } from 'node:process'

/** 一个引擎端点。 */
export type EngineEndpoint =
  | { readonly kind: 'socket'; readonly socketPath: string }
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number }

/** 一次 API 调用的结果。 */
export interface EngineResponse {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: Buffer
}

/** 引擎返回了非 2xx。 */
export class EngineError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string) {
    super(`docker engine returned ${status}: ${detail}`)
    this.name = 'EngineError'
    this.status = status
    this.detail = detail
  }
}

/**
 * Windows 上 Docker Desktop 可能挂在多个命名管道上，且随版本变化
 * （`docker_engine` 是旧名，4.x 起 Linux 引擎叫 `dockerDesktopLinuxEngine`）。
 * 因此端点解析的产物是**候选列表**，由 `selectEndpoint()` 逐个探测。
 */
export function candidateEndpoints(env: NodeJS.ProcessEnv = process.env): EngineEndpoint[] {
  const host = env['DOCKER_HOST']?.trim()
  if (host) {
    const parsed = parseDockerHost(host)
    if (parsed) {
      return [parsed]
    }
  }
  if (platform === 'win32') {
    return [
      { kind: 'socket', socketPath: '//./pipe/dockerDesktopLinuxEngine' },
      { kind: 'socket', socketPath: '//./pipe/dockerDesktopWindowsEngine' },
      { kind: 'socket', socketPath: '//./pipe/docker_engine' },
    ]
  }
  return [
    { kind: 'socket', socketPath: '/var/run/docker.sock' },
    { kind: 'socket', socketPath: `${env['HOME'] ?? '/root'}/.docker/run/docker.sock` },
  ]
}

/** 解析 `DOCKER_HOST`。无法识别时返回 `undefined`，由调用方回落到平台默认。 */
export function parseDockerHost(raw: string): EngineEndpoint | undefined {
  if (raw.startsWith('npipe://')) {
    const suffix = raw.replace(/^npipe:\/\//, '').replace(/^\/+/, '')
    return { kind: 'socket', socketPath: `//./pipe/${suffix.replace(/^\.\/pipe\//, '')}` }
  }
  if (raw.startsWith('unix://')) {
    return { kind: 'socket', socketPath: raw.slice('unix://'.length) }
  }
  const tcp = raw.match(/^(?:tcp|https?):\/\/([^:/]+)(?::(\d+))?/)
  if (tcp?.[1]) {
    return { kind: 'tcp', host: tcp[1], port: Number(tcp[2] ?? 2375) }
  }
  return undefined
}

/** 端点的人类可读描述，用于日志与错误信息。 */
export function describeEndpoint(endpoint: EngineEndpoint): string {
  return endpoint.kind === 'socket'
    ? endpoint.socketPath
    : `${endpoint.host}:${String(endpoint.port)}`
}

/**
 * 发一次 Engine API 调用。
 *
 * 只管传输与状态码；非 2xx 抛 `EngineError`。**从不吞错**——调用方需要区分
 * "引擎说不行"与"网络断了"，因为前者是配置问题，后者是可用性问题。
 */
export function engineRequest(
  endpoint: EngineEndpoint,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<EngineResponse> {
  return new Promise<EngineResponse>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = {}
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
    }
    const base =
      endpoint.kind === 'socket'
        ? { socketPath: endpoint.socketPath }
        : { host: endpoint.host, port: endpoint.port }

    const req = request({ ...base, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const response: EngineResponse = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }
        if (response.status >= 200 && response.status < 300) {
          resolve(response)
          return
        }
        reject(new EngineError(response.status, response.body.toString('utf8').slice(0, 400)))
      })
    })

    const abort = (): void => {
      req.destroy(new Error('request aborted'))
    }
    if (signal) {
      if (signal.aborted) {
        abort()
      } else {
        signal.addEventListener('abort', abort, { once: true })
      }
    }
    if (timeoutMs !== undefined && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        resolve({
          status: 0,
          headers: {},
          body: Buffer.from(`request timed out after ${String(timeoutMs)}ms`, 'utf8'),
        })
      })
    }
    req.on('error', reject)
    req.end(payload)
  })
}

/** 一次 exec 的分路输出。 */
export interface DemuxedOutput {
  readonly stdout: string
  readonly stderr: string
}

/**
 * 拆开 Docker 的非 TTY 多路复用流。
 *
 * 帧格式：`[streamType(1), 0, 0, 0, size(4, BE), payload(size)]`。
 * `streamType` 1 = stdout，2 = stderr。**必须按帧长切分**，否则多字节字符
 * 会被拦腰截断——这是这类客户端最常见的静默 bug。
 */
export function demuxStream(buffer: Buffer): DemuxedOutput {
  let stdout = ''
  let stderr = ''
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset]
    const size = buffer.readUInt32BE(offset + 4)
    if (offset + 8 + size > buffer.length) {
      break
    }
    const payload = buffer.subarray(offset + 8, offset + 8 + size).toString('utf8')
    if (streamType === 1) {
      stdout += payload
    } else if (streamType === 2) {
      stderr += payload
    }
    offset += 8 + size
  }
  return { stdout, stderr }
}

/** 探测一个端点是否可用。从不抛错：探测失败的语义是"这个端点不可用"。 */
export async function pingEndpoint(
  endpoint: EngineEndpoint,
  timeoutMs = 3000,
): Promise<{ ok: boolean; detail: string; apiVersion?: string }> {
  try {
    const res = await engineRequest(endpoint, 'GET', '/_ping', undefined, timeoutMs)
    if (res.status !== 200) {
      return { ok: false, detail: `unexpected status ${String(res.status)}` }
    }
    const apiVersion = res.headers['api-version']
    return {
      ok: true,
      detail: '',
      ...(typeof apiVersion === 'string' ? { apiVersion } : {}),
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 依次探测候选端点，返回第一个可用的。
 * @returns 可用端点与探测过程说明；全部不可用时 `endpoint` 为 `undefined`。
 */
export async function selectEndpoint(
  candidates: EngineEndpoint[] = candidateEndpoints(),
  timeoutMs = 3000,
): Promise<{ endpoint?: EngineEndpoint; tried: string[] }> {
  const tried: string[] = []
  for (const endpoint of candidates) {
    const result = await pingEndpoint(endpoint, timeoutMs)
    if (result.ok) {
      return { endpoint, tried }
    }
    tried.push(`${describeEndpoint(endpoint)} (${result.detail})`)
  }
  return { tried }
}

/** 容器名只允许 `[a-zA-Z0-9][a-zA-Z0-9_.-]*`，会话 id 需要清洗。 */
export function containerName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '')
  return `dsh-runbox-${safe.slice(0, 48) || 'session'}`
}

/** 容器标签：孤儿回收与归属追溯的依据。 */
export const LABELS = {
  /** 标记"这个容器归 runbox 管"，回收时按它筛选。 */
  managed: 'dsh.runbox.managed',
  /** 归属会话。 */
  session: 'dsh.runbox.session',
} as const

/** 判断 `child` 是否等于 `parent` 或位于其下（纯词法，路径已规范化）。 */
export function isAtOrUnder(parent: string, child: string): boolean {
  if (parent === child) {
    return true
  }
  const base = parent.endsWith('/') ? parent : `${parent}/`
  return child.startsWith(base)
}

/**
 * 计算真正可用的 tmpfs 路径。
 *
 * **为什么需要这个函数**：容器里后挂的挂载点会**遮盖**先挂的。我们把工作区
 * bind mount 到宿主同路径，如果工作区恰好位于 `/tmp` 之下（比如宿主临时目录），
 * 而 `/tmp` 又被挂成 tmpfs，那么工作区就被 tmpfs 盖住了——容器里看到的是一个
 * 空目录，写进去的东西宿主上永远看不到，而且**不会有任何报错**。
 *
 * 这是 CI 抓出来的真实缺陷，不是理论风险。因此这里把与工作区有重叠的 tmpfs
 * 路径剔除：宁可少一个可写临时区，也不能让工作区静默失联。
 *
 * @param tmpfsPaths - 策略声明的 tmpfs 路径。
 * @param workspaceMountPath - 工作区在箱内的挂载路径。
 * @returns 剔除重叠项后的 tmpfs 路径。
 */
export function effectiveTmpfsPaths(
  tmpfsPaths: readonly string[],
  workspaceMountPath: string,
): string[] {
  return tmpfsPaths.filter(
    (path) =>
      !isAtOrUnder(path, workspaceMountPath) && !isAtOrUnder(workspaceMountPath, path),
  )
}
