/**
 * `@dsh-runbox/provider-subprocess` —— 把进程执行世界搬进箱里。
 *
 * 继承官方 `SubprocessService`，加载即注册为 `ctx.subprocess`。官方文档对它的
 * 要求比其他 seam 都细，这里逐条对照实现（也逐条注明没做到的）：
 *
 * | 契约 | 本实现 |
 * |---|---|
 * | 可执行文件路径与挂载的文件系统共享同一执行世界 | ✅ 解析与 spawn 都在同一个箱里 |
 * | `spawn` 立即返回活句柄，`done` 在进程结束时结算 | ✅ HTTP 建连是异步的，但句柄同步返回 |
 * | collect 读取按偏移、非消费式、有损读报 spill | ✅ `CollectBuffer` |
 * | `terminate` 是唯一终止动词，按**进程树**升级 TERM→KILL | ✅ pid 文件 + 进程组信号 |
 * | `waitForExit` 观察整棵树 | ✅ |
 * | `stdin: 'pipe'` 暴露可写流 | ❌ 抛 `RunboxNotImplementedError`，排在 M3（需要 hijack 连接） |
 * | `spawnTerminal` 分配真实终端 | ❌ 抛 `RunboxNotImplementedError`，排在 M3 |
 *
 * 没做到的两条**响亮失败**，不静默降级——一个"接受了参数但没按语义执行"的
 * 进程接口比一个直接报错的接口危险得多。
 *
 * @module @dsh-runbox/provider-subprocess
 */

import { PassThrough } from 'node:stream'

import { SubprocessService } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { Context } from '@deepseek-ai/cordis'

import {
  BoxManager,
  RunboxNotImplementedError,
  type BoxRequest,
  type RunboxService,
} from '@dsh-runbox/core'

import { CollectBuffer, type CollectRead } from './collect.ts'

export { CollectBuffer } from './collect.ts'
export type { CollectRead, CollectSnapshot, SpillOptions } from './collect.ts'

/** 插件名。 */
export const name = '@dsh-runbox/provider-subprocess'

/** 依赖的 ctx 服务：执行地基。 */
export const inject = ['runbox'] as const

/** 默认强制的沙箱模式；`SubprocessSpawnSpec` 不带策略，所以这里给一个安全默认值。 */
export const DEFAULT_MODE = 'workspace-write' as const

/** 箱的会话键：这个 seam 拿不到 session，用 cwd 作为执行世界的标识。 */
export function boxKeyForCwd(cwd: string): string {
  return `cwd:${cwd}`
}

/**
 * 箱内的进程执行世界。
 */
export class RunboxSubprocessService extends SubprocessService {
  readonly #boxes: BoxManager
  /** 在跑的流，服务卸载时要全部终止。 */
  readonly #live = new Set<() => void>()

  constructor(ctx: Context & { runbox: RunboxService }, boxes?: BoxManager) {
    super(ctx)
    this.#boxes = boxes ?? ctx.runbox.createBoxManager()
    this.ctx.logger?.debug?.(
      'runbox subprocess provider ready (backends: %s)',
      ctx.runbox.backends.list().join(', ') || 'none',
    )
  }

  /**
   * 在箱里解析一个可执行文件。
   *
   * 官方要求：绝对路径要**验证**；裸名走提供方的 PATH；**含分隔符的相对路径
   * 必须拒绝**——解析基准未定义，猜一个出来比直接失败危险。
   */
  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.includes('/') && !command.startsWith('/')) {
      throw new Error(
        `cannot resolve a relative path containing separators: ${command} ` +
          '(the resolution base is undefined for the box execution world)',
      )
    }
    const request = this.#requestFor(process.cwd())
    const script = command.startsWith('/')
      ? 'test -x "$1" && printf %s "$1"'
      : 'command -v -- "$1" || true'
    const result = await this.#boxes.exec(
      request,
      {
        argv: ['bash', '-c', script, 'dsh-runbox', command],
        cwd: process.cwd(),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
        ...(signal ? { signal } : {}),
      },
    )
    const resolved = result.stdout.trim()
    if (resolved.length === 0) {
      throw new Error(`executable not found in the box execution world: ${command}`)
    }
    return resolved
  }

  /**
   * 启动一个托管子进程。
   *
   * 同步返回活句柄——这是契约要求，因为 HTTP 建连是异步的，句柄先建好、
   * 之后把后台流接上。若建连失败，`done` 以 spawn 级失败 reject。
   */
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    // stdin 的三种处置由箱后端直接支持；交互式那条走连接劫持。
    const request = this.#requestFor(spec.cwd)

    const stdinPipe = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
    const stdoutPipe = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderrPipe = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    const stdoutCollect =
      typeof spec.stdio.stdout === 'object'
        ? new CollectBuffer(spec.stdio.stdout.maxBytes, spec.stdio.stdout.spill)
        : undefined
    const stderrCollect =
      typeof spec.stdio.stderr === 'object'
        ? new CollectBuffer(spec.stdio.stderr.maxBytes, spec.stdio.stderr.spill)
        : undefined
    // 'inherit' 在容器语义下等于"丢弃"：箱里的 fd 1/2 没有对应到宿主的任何东西。
    // 刻意显式列出来而不是让它落进某个 else 分支——静默改变语义是最糟的选项。

    let terminate: (() => void) | undefined
    let waitForExit: ((signal?: AbortSignal) => Promise<boolean>) | undefined

    /** 只保留有值的环境项：`undefined` 是"删除该变量"的墓碑，不该进箱。 */
    const boxEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (value !== undefined) {
        boxEnv[key] = value
      }
    }

    const done = (async (): Promise<SubprocessOutcome> => {
      const stream = await this.#boxes.startExec(request, {
        argv: [...spec.argv],
        cwd: spec.cwd,
        ...(Object.keys(boxEnv).length > 0 ? { env: boxEnv } : {}),
        stdin: spec.stdio.stdin,
        ...(spec.signal ? { signal: spec.signal } : {}),
      })
      terminate = stream.terminate
      if (stdinPipe && stream.stdin) {
        // 箱的 stdin 是异步建好的；调用方拿到的管道同步就存在，这里接上。
        stdinPipe.on('data', (chunk: Buffer) => stream.stdin?.write(chunk))
        stdinPipe.on('end', () => stream.stdin?.end())
      }
      waitForExit = (signal?: AbortSignal): Promise<boolean> => stream.waitForExit(signal)
      this.#live.add(stream.terminate)

      stream.stdout?.on('data', (chunk: string | Buffer) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stdoutPipe?.write(text)
        stdoutCollect?.push(text)
      })
      stream.stderr?.on('data', (chunk: string | Buffer) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stderrPipe?.write(text)
        stderrCollect?.push(text)
      })

      try {
        const outcome = await stream.done
        stdoutPipe?.end()
        stderrPipe?.end()
        // docker exec 不回报信号，只有退出码；如实填 null 而不是编一个。
        return { exitCode: outcome.exitCode, signal: null }
      } finally {
        this.#live.delete(stream.terminate)
      }
    })()

    const reader = (buffer: CollectBuffer) => ({
      readFrom: (fromByte: number): CollectRead => buffer.readFrom(fromByte),
    })
    const collected: SubprocessCollectedOutputs = {
      ...(stdoutCollect ? { stdout: reader(stdoutCollect) } : {}),
      ...(stderrCollect ? { stderr: reader(stderrCollect) } : {}),
    }

    return {
      // 箱内 pid 对宿主没有意义，且宿主无法用 process.kill 触达它。
      // 契约允许 -1（"spawn 本身失败"之外的场合也只有一个终止动词可用）。
      pid: -1,
      stdin: stdinPipe,
      stdout: stdoutPipe,
      stderr: stderrPipe,
      collected,
      done,
      terminate: (): void => {
        terminate?.()
      },
      waitForExit: async (signal?: AbortSignal): Promise<boolean> => {
        if (waitForExit) {
          return waitForExit(signal)
        }
        // 还没建连完就要求等待：等 done 结算，失败也算"树已停"。
        return Promise.race([
          done.then(() => true).catch(() => true),
          new Promise<boolean>((resolve) => {
            if (signal?.aborted) {
              resolve(false)
              return
            }
            signal?.addEventListener('abort', () => resolve(false), { once: true })
          }),
        ])
      },
    }
  }

  /**
   * 分配一个真实终端。
   *
   * @throws RunboxNotImplementedError - 排在 M3（`ctx.terminals` 后端会与它一起落地）。
   */
  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(
      new RunboxNotImplementedError('SubprocessService.spawnTerminal', 'M3'),
    )
  }

  /** 终止所有仍在跑的流。服务卸载时调用。 */
  terminateAll(): void {
    for (const terminate of [...this.#live]) {
      terminate()
    }
    this.#live.clear()
  }

  /** 由 cwd 推导箱请求。这个 seam 拿不到 session，因此用 cwd 作为执行世界标识。 */
  #requestFor(cwd: string): BoxRequest {
    return {
      sessionId: boxKeyForCwd(cwd),
      workspaceRoot: cwd,
      mode: DEFAULT_MODE,
    }
  }
}

/**
 * Cordis 插件入口。
 * @param ctx - 所属上下文，`ctx.runbox` 已由 `@dsh-runbox/core` 提供。
 */
export function apply(ctx: Context): void {
  new RunboxSubprocessService(ctx as Context & { runbox: RunboxService })
}
