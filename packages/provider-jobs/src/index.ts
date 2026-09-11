/**
 * @dsh-runbox/provider-jobs
 *
 * 后台任务在箱内登记，箱销毁时不留孤儿进程。
 *
 * 将来接管：`ctx.jobs`（官方 seam 包 `@deepseek-ai/dsh-jobs`）
 * 当前状态：**M0 占位**，实现排在 M3。
 *
 * 这里刻意不假装可用：被调用时抛 `RunboxNotImplementedError`。一个"什么都不做
 * 也不报错"的 provider，比一个报错的 provider 危险得多——上层会以为自己被隔离了。
 *
 * @module @dsh-runbox/provider-jobs
 */

import { RunboxNotImplementedError, type RunboxService } from '@dsh-runbox/core'
import type { Context } from '@deepseek-ai/cordis'

/** 插件名。 */
export const name = '@dsh-runbox/provider-jobs'

/** 依赖的 ctx 服务：执行地基。 */
export const inject = ['runbox'] as const

/** 本包在 M0 的定位说明，供 host 启动日志与插件市场展示。 */
export const summary = '后台任务在箱内登记，箱销毁时不留孤儿进程'

/** 计划落地的里程碑。 */
export const milestone = 'M3'

/**
 * Cordis 插件入口。
 * @param ctx - 所属上下文，ctx.runbox 已由 @dsh-runbox/core 提供。
 * @throws RunboxNotImplementedError - 实现尚未落地（M3）。
 */
export function apply(_ctx: Context & { runbox: RunboxService }): never {
  throw new RunboxNotImplementedError('ctx.jobs', 'M3')
}
