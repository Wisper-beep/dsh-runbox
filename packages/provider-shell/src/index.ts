/**
 * `@dsh-runbox/provider-shell` —— 把 bash 执行搬进箱里。
 *
 * 继承官方 `ShellExecutor`，因此加载即注册为 `ctx.shell`。本包同时承担
 * **契约门禁**：官方 rc 版本一旦改签名，编译就会失败，而不是等运行时才炸。
 *
 * 官方契约要点（`docs/subsystems/shell.zh.md`）：
 * - `run` **只在基础设施故障时 reject**；非零退出、超时、abort 都要以
 *   `ShellRunResult` resolve 回来。
 * - `start` 立即返回，后台进程不适用超时。
 *
 * M1 的边界（如实声明，不是"暂未实现所以随便"）：
 * - `run` 已实现并走真实容器。
 * - `start`（后台进程）仍抛 `RunboxNotImplementedError`，排在 M3——它会响亮失败，
 *   不会静默降级。
 * - `danger-full-access` 会抛 `UnsupportedModeError`：箱永远是受限的，我们
 *   宁可报错也不假装自己没隔离。
 *
 * @module @dsh-runbox/provider-shell
 */

import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
// 空类型导入：官方用模块增强声明 ctx.sandboxPolicy，必须加载该模块才能生效。
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import {
  ShellExecutor,
  type CollectedOutput,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { Context } from '@deepseek-ai/cordis'

import {
  BoxManager,
  RunboxNotImplementedError,
  UnsupportedModeError,
  type BoxRequest,
  type RunboxService,
} from '@dsh-runbox/core'

/** 插件名。 */
export const name = '@dsh-runbox/provider-shell'

/** 依赖的 ctx 服务：执行地基。 */
export const inject = ['runbox'] as const

/** 未显式指定超时时的默认值。 */
export const DEFAULT_TIMEOUT_MS = 120_000

/** 本执行器愿意接受的超时上限。 */
export const MAX_TIMEOUT_MS = 900_000

/** 单流默认保留的字节数（超限保留**尾部**，与官方 `CollectedOutput` 语义一致）。 */
export const DEFAULT_STDOUT_MAX_BYTES = 256 * 1024

/** 单流字节上限的天花板。 */
const MAX_STDOUT_MAX_BYTES = 8 * 1024 * 1024

/**
 * 容器后端的拒绝签名。
 *
 * 官方 `ConfinedArgv` 要求每个后端上报**自己的**方言而不是跨后端并集——
 * 容器里 manifest 为只读时内核报 `Read-only file system`，权限不足报
 * `Permission denied`，能力缺失报 `Operation not permitted`。
 */
const CONTAINER_DENIAL_SIGNATURES = [
  'read-only file system',
  'permission denied',
  'operation not permitted',
] as const

/** 本执行器默认施加的沙箱模式。 */
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write'

/** 把字符串裁到上限，保留**尾部**——诊断信息总在最后面。 */
export function keepTail(text: string, maxBytes: number): CollectedOutput {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) {
    return { text, truncated: false }
  }
  // 按字节裁会劈开多字节字符，因此从后往前扫，保证边界落在字符上。
  let sliced = ''
  let size = 0
  const chars = [...text]
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i] ?? ''
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (size + chBytes > maxBytes) {
      break
    }
    sliced = ch + sliced
    size += chBytes
  }
  return { text: sliced, truncated: true }
}

/** 判断一次 stderr 是否表明沙箱**正常工作并拦住了**操作。 */
export function isDenial(stderr: string): boolean {
  const lowered = stderr.toLowerCase()
  return CONTAINER_DENIAL_SIGNATURES.some((signature) => lowered.includes(signature))
}

/**
 * 箱内 bash 执行器。
 *
 * 继承官方 `ShellExecutor` → 加载即注册为 `ctx.shell`。每个 context 只能有一个
 * 实现，这正是"整层替换"的机制：挂上本包，官方的 `bash-local` 就不该再挂。
 */
export class RunboxShellExecutor extends ShellExecutor {
  readonly #boxes: BoxManager

  constructor(ctx: Context & { runbox: RunboxService }, boxes?: BoxManager) {
    super(ctx)
    this.#boxes = boxes ?? ctx.runbox.createBoxManager()
    this.ctx.logger?.debug?.(
      'runbox shell executor ready (backends: %s)',
      ctx.runbox.backends.list().join(', ') || 'none',
    )
  }

  /** 本执行器默认施加的沙箱模式。 */
  override get sandboxMode(): SandboxMode | undefined {
    return DEFAULT_SANDBOX_MODE
  }

  /**
   * 施加本实现自己的默认值与上限，产出完全指定的 spec。
   *
   * 官方要求实现自己拥有默认值与上限，并**封顶**调用方给的值——否则一个
   * 写错的上限就能把整台机器的内存吃掉。
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const policy = request.sandboxPolicy ?? this.ctx.sandboxPolicy?.resolve()
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: clamp(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
      stdoutMaxBytes: clamp(
        request.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES,
        1,
        MAX_STDOUT_MAX_BYTES,
      ),
      signal: request.signal,
      stdin: request.stdin,
      env: request.env,
      dshEnv: request.dshEnv,
      sandboxPolicy: policy,
    }
  }

  /**
   * 前台执行一条命令——真实在容器里跑。
   *
   * 非零退出 / 超时 / abort 都以结果 resolve 回去；只有基础设施故障
   * （容器不可用）才 reject，且此时抛的是 `BackendUnavailableError`。
   */
  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const request = this.#boxRequest(spec)
    const env = { ...spec.env, ...spec.dshEnv }

    const result = await this.#boxes.exec(request, {
      argv: ['bash', '-lc', spec.command],
      cwd: spec.workdir,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(spec.stdin === undefined ? {} : { stdin: { data: spec.stdin } }),
      timeoutMs: spec.timeoutMs,
      signal: spec.signal,
    })

    const mode = spec.sandboxPolicy?.mode ?? DEFAULT_SANDBOX_MODE
    return {
      exitCode: result.exitCode,
      // docker exec 不回报信号，只有退出码；如实填 null 而不是编一个。
      signal: null,
      timedOut: result.timedOut,
      aborted: spec.signal?.aborted ?? false,
      timeoutMs: spec.timeoutMs,
      stdout: keepTail(result.stdout, spec.stdoutMaxBytes),
      stderr: keepTail(result.stderr, spec.stdoutMaxBytes),
      sandbox:
        mode === 'danger-full-access'
          ? undefined
          : {
              mode,
              denied: isDenial(result.stderr),
              enforcement: 'full',
            },
    }
  }

  /**
   * 启动后台进程。
   *
   * @throws RunboxNotImplementedError - 排在 M3。刻意响亮失败：后台进程若在这里
   *   静默变成前台空转，用户会以为任务在跑。
   */
  override start(_spec: ShellExecSpec): ShellProcess {
    throw new RunboxNotImplementedError('ShellExecutor.start', 'M3')
  }

  /** 从 spec 推导出箱的请求：会话、工作区根、围栏模式。 */
  #boxRequest(spec: ShellExecSpec): BoxRequest {
    const policy: SandboxExecutionPolicy | undefined = spec.sandboxPolicy
    const mode = policy?.mode ?? DEFAULT_SANDBOX_MODE
    if (mode === 'danger-full-access') {
      throw new UnsupportedModeError(
        'dsh-runbox always confines execution: danger-full-access cannot be honored. ' +
          'Use the host-local bash executor if unconfined execution is required.',
      )
    }
    return {
      sessionId: policy?.sessionId,
      workspaceRoot: policy?.workspaceRoot ?? spec.workdir,
      mode,
    }
  }
}

/**
 * 把值夹在 `[min, max]` 内。
 *
 * 两个非有限值的语义刻意不同：`NaN` 是调用方给了垃圾，回落到下界（最保守）；
 * `Infinity` 是调用方说"不设限"，必须**压到上界**——否则一个
 * `timeoutMs: Infinity` 就能绕过所有上限，而这正是"封顶"要防的事。
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min
  }
  return Math.min(Math.max(value, min), max)
}

/**
 * Cordis 插件入口。
 * @param ctx - 所属上下文，`ctx.runbox` 已由 `@dsh-runbox/core` 提供。
 */
export function apply(ctx: Context): void {
  new RunboxShellExecutor(ctx as Context & { runbox: RunboxService })
}
