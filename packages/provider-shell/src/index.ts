/**
 * `@dsh-runbox/provider-shell` —— 把 bash 执行搬进箱里。
 *
 * 这是第一个真正**继承官方抽象类**的包，所以它同时承担一个额外职责：
 * **契约门禁**。官方 `ShellExecutor` 一旦在 rc 版本里改了签名，本包会编译失败，
 * 而不是等到运行时才炸。dsh 处于 developer preview 且明说会有破坏性变更，
 * 这个门禁是整个仓库最重要的一根安全绳。
 *
 * 官方契约原文（`docs/subsystems/shell.zh.md` 摘要）：
 * - `run` **只在基础设施故障时 reject**；非零退出、超时被杀、abort 被杀都要以
 *   `ShellRunResult` resolve 回来。
 * - `start` 立即返回，后台进程**不适用超时**；`done` 永不 reject。
 * - 后台进程的存活边界是 `ctx.subprocess` 的释放，所以它能活过执行器单独重载。
 *
 * 当前状态：**M0 契约已定型**，`run` / `start` 的实现排在 M1。
 *
 * @module @dsh-runbox/provider-shell
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import {
  ShellExecutor,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { Context } from '@deepseek-ai/cordis'

import { RunboxNotImplementedError, type RunboxService } from '@dsh-runbox/core'

/** 插件名。 */
export const name = '@dsh-runbox/provider-shell'

/** 依赖的 ctx 服务：执行地基。 */
export const inject = ['runbox'] as const

/**
 * 本执行器**默认**施加的沙箱模式。
 *
 * 契约要求这个 getter 诚实反映"后端默认围栏到什么程度"，工具层据它来
 * 决定要不要暴露提权字段。我们的箱默认就是工作区可写、其余只读，所以报
 * `workspace-write`。
 *
 * TODO(M1)：接入 `ctx.settings`，让部署方能改这个默认值。M0 阶段先固定，
 * 因为此时 `run` 还没落地，不存在"默认值被真正使用"的情形。
 */
const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write'

/**
 * 箱内 bash 执行器。
 *
 * 继承官方 `ShellExecutor` → 加载即注册为 `ctx.shell`。每个 context 只能有一个
 * 实现，这正是"整层替换"的机制：挂上本包，官方的 `bash-local` 就不该再挂。
 */
export class RunboxShellExecutor extends ShellExecutor {
  readonly #runbox: RunboxService

  constructor(ctx: Context & { runbox: RunboxService }) {
    super(ctx)
    this.#runbox = ctx.runbox
    this.ctx.logger?.debug?.(
      'runbox shell executor ready (backends: %s)',
      this.#runbox.backends.list().join(', ') || 'none',
    )
  }

  /** 本执行器默认施加的沙箱模式。 */
  override get sandboxMode(): SandboxMode | undefined {
    return DEFAULT_SANDBOX_MODE
  }

  /**
   * 施加本实现自己的默认值与上限，产出完全指定的 spec。
   *
   * M0 暂未实现——但**不返回伪造的 spec**：返回一个看起来合理的 spec 会让
   * 上层以为链路的下一环已经就绪。
   *
   * @throws RunboxNotImplementedError - 排在 M1。
   */
  override resolve(_request: ShellExecRequest): ShellExecSpec {
    throw new RunboxNotImplementedError('ShellExecutor.resolve', 'M1')
  }

  /**
   * 前台执行一条命令，在箱内跑完为止。
   *
   * 实现时须遵守：非零退出 / 超时 / abort 都以结果对象 resolve，只有基础设施
   * 故障才 reject（容器不可用时正是这类故障，必须在这里 fail-closed）。
   *
   * @throws RunboxNotImplementedError - 排在 M1。
   */
  override run(_spec: ShellExecSpec): Promise<ShellRunResult> {
    return Promise.reject(new RunboxNotImplementedError('ShellExecutor.run', 'M1'))
  }

  /**
   * 启动一个后台进程并立即返回句柄。
   *
   * @throws RunboxNotImplementedError - 排在 M1。
   */
  override start(_spec: ShellExecSpec): ShellProcess {
    throw new RunboxNotImplementedError('ShellExecutor.start', 'M1')
  }
}

/**
 * Cordis 插件入口。
 * @param ctx - 所属上下文，`ctx.runbox` 已由 `@dsh-runbox/core` 提供。
 */
export function apply(ctx: Context): void {
  new RunboxShellExecutor(ctx as Context & { runbox: RunboxService })
}
