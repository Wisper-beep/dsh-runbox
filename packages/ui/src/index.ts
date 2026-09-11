/**
 * @dsh-runbox/ui
 *
 * 设置卡（镜像 / 资源 / 网络）、箱状态面板、执行审计时间线。
 *
 * 将来接管：web client（sidebar / settings / conversation node）
 * 当前状态：**M0 占位**，实现排在 M4。
 *
 * 这里刻意不假装可用：被调用时抛 `RunboxNotImplementedError`。一个"什么都不做
 * 也不报错"的 provider，比一个报错的 provider 危险得多——上层会以为自己被隔离了。
 *
 * @module @dsh-runbox/ui
 */

import { RunboxNotImplementedError, type RunboxService } from '@dsh-runbox/core'
import type { Context } from '@deepseek-ai/cordis'

/** 插件名。 */
export const name = '@dsh-runbox/ui'

/** 依赖的 ctx 服务：执行地基。 */
export const inject = ['runbox'] as const

/** 本包在 M0 的定位说明，供 host 启动日志与插件市场展示。 */
export const summary = '设置卡（镜像 / 资源 / 网络）、箱状态面板、执行审计时间线'

/** 计划落地的里程碑。 */
export const milestone = 'M4'

/**
 * Cordis 插件入口。
 * @param ctx - 所属上下文，ctx.runbox 已由 @dsh-runbox/core 提供。
 * @throws RunboxNotImplementedError - 实现尚未落地（M4）。
 */
export function apply(_ctx: Context & { runbox: RunboxService }): never {
  throw new RunboxNotImplementedError('web client（sidebar / settings / conversation node）', 'M4')
}
