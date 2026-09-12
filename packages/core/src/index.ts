/**
 * `@dsh-runbox/core` —— 后端无关的执行地基。
 *
 * 它自己不做隔离，只负责三件事：
 * 1. 持有后端注册表（`BackendRegistry`）；
 * 2. 把官方的逐调用沙箱模式翻译成箱的围栏配置（`confinementFor`）；
 * 3. 在没有任何可用后端时**响亮失败**，绝不静默回落。
 *
 * 服务以 `ctx.runbox` 暴露；provider 包（`@dsh-runbox/provider-*`）消费它。
 *
 * @module @dsh-runbox/core
 */

import { Service, type Context } from '@deepseek-ai/cordis'

import { BackendRegistry } from './registry.ts'
import { BoxManager, type BoxDefaults } from './box-manager.ts'
import type { BoxBackend } from './types.ts'

export {
  BackendUnavailableError,
  RunboxError,
  RunboxNotImplementedError,
  UnsupportedModeError,
} from './errors.ts'
export { BackendRegistry } from './registry.ts'
export { BoxManager, type BoxDefaults, type BoxRequest } from './box-manager.ts'
export { canonicalWorldRoot, pickWorldRoot, resolveWorldRoot } from './world.ts'
export { confinementFor, withinWorkspace, type BoxConfinement } from './policy.ts'
export {
  fromBoxPath,
  hostPlatform,
  isAtOrUnder,
  toBoxPath,
  type HostPlatform,
} from './paths.ts'
export type {
  BoxBackend,
  BoxExecRequest,
  BoxExecResult,
  BoxExecStream,
  BoxHandle,
  BoxId,
  BoxLimits,
  BoxNetworkMode,
  BoxSpec,
  BoxState,
  BoxStdinMode,
} from './types.ts'

/** 建箱默认值：镜像 / 网络 / 资源。 */
export const DEFAULT_BOX_DEFAULTS: BoxDefaults = {
  image: process.env['DSH_RUNBOX_IMAGE'] ?? 'bash:5.2',
  network: 'none',
  limits: { cpus: 1, memoryBytes: 1024 * 1024 * 1024, pidsLimit: 512 },
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-runbox 的执行地基服务。 */
    runbox: RunboxService
  }
}

/**
 * 执行地基服务。
 *
 * `Service` 的构造器会立即把实例注册为 `ctx.runbox`，并在所属 fiber 卸载时
 * 自动注销——这正是 Cordis "可逆注册"的机制，我们不需要自己写卸载逻辑。
 */
export class RunboxService extends Service {
  /** 已注册的执行后端。 */
  readonly backends = new BackendRegistry()

  constructor(ctx: Context) {
    super(ctx, 'runbox')
  }

  /**
   * 注册一个执行后端。
   * @param backend - 后端实现。
   * @returns 注销函数（来自注册表，幂等）。
   */
  use(backend: BoxBackend): () => void {
    this.ctx.logger?.info?.('runbox backend registered: %s', backend.name)
    return this.backends.register(backend)
  }

  /**
   * 建一个会话级的箱管理器。
   *
   * 刻意由调用方持有而不是服务内部单例：provider 各自需要自己的默认值
   * （镜像、资源），而"会话 → 箱"的映射必须共享同一个 `BoxManager` 实例。
   * 一个 host 里通常只建一个，传给所有 provider。
   *
   * @param defaults - 建箱默认值，缺省用 `DEFAULT_BOX_DEFAULTS`。
   * @returns 绑定到本服务后端注册表的箱管理器。
   */
  createBoxManager(defaults: BoxDefaults = DEFAULT_BOX_DEFAULTS): BoxManager {
    return new BoxManager(this.backends, defaults)
  }
}

/** 插件名，用于 Cordis 归因与日志。 */
export const name = 'runbox-core'

/** 依赖的 ctx 服务：无——core 提供能力，不消费能力。 */
export const inject: string[] = []

/**
 * Cordis 插件入口。
 * @param ctx - 所属上下文。
 */
export function apply(ctx: Context): void {
  new RunboxService(ctx)
}
