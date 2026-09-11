/**
 * dsh-runbox 的错误词汇。
 *
 * 设计原则来自官方 `ctx.sandbox` 契约里的一句硬约束：**受限策略下静默的无隔离
 * 透传永远不合法**。因此 runbox 在所有"本该隔离却隔离不了"的路径上都必须
 * fail-closed——抛出错误，而不是悄悄退回宿主执行。
 *
 * @module @dsh-runbox/core/errors
 */

/** 所有 runbox 错误的基类：带可机读的 `code`，便于上层做归因与展示。 */
export class RunboxError extends Error {
  /** 可机读的错误码，稳定不变，供上层分支判断。 */
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = new.target.name
    this.code = code
  }
}

/**
 * 没有任何可用后端——这是 runbox 唯一允许的"拒绝执行"方式。
 *
 * 错误码刻意沿用官方 `SANDBOX_UNAVAILABLE` 的语义：让上层的归因逻辑
 * 不必区分"官方本地沙箱不可用"与"我们的容器后端不可用"。
 */
export class BackendUnavailableError extends RunboxError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super('SANDBOX_UNAVAILABLE', `runbox backend unavailable: ${detail}`, options)
  }
}

/** 请求的沙箱模式不在本后端能力范围内。 */
export class UnsupportedModeError extends RunboxError {
  constructor(detail: string) {
    super('RUNBOX_UNSUPPORTED_MODE', detail)
  }
}

/**
 * 里程碑占位：接口已按官方契约定型，实现尚未落地。
 *
 * 刻意做成响亮失败而不是静默空转——一个"什么都没做但没报错"的 provider
 * 比一个报错的 provider 危险得多。
 */
export class RunboxNotImplementedError extends RunboxError {
  constructor(what: string, milestone: string) {
    super(
      'RUNBOX_NOT_IMPLEMENTED',
      `${what} is not implemented yet (planned milestone: ${milestone})`,
    )
  }
}
