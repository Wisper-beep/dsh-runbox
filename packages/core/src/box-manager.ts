/**
 * 会话 ↔ 箱 的绑定与生命周期。
 *
 * 归 core 而不是某个 provider：所有 provider（shell / fs / subprocess / jobs）都必须
 * 看到**同一个**会话对应的**同一个**箱，否则它们在两个不同的执行世界里各干各的。
 *
 * @module @dsh-runbox/core/box-manager
 */

import type { ConfinedSandboxMode } from '@deepseek-ai/dsh-sandbox'

import { BackendUnavailableError } from './errors.ts'
import { confinementFor } from './policy.ts'
import type { BackendRegistry } from './registry.ts'
import type {
  BoxBackend,
  BoxExecRequest,
  BoxExecResult,
  BoxExecStream,
  BoxHandle,
  BoxLimits,
  BoxNetworkMode,
  BoxSpec,
} from './types.ts'

/** 建箱时的默认值；逐会话可以按策略覆盖。 */
export interface BoxDefaults {
  /** 镜像引用。 */
  readonly image: string
  /** 网络模式。 */
  readonly network: BoxNetworkMode
  /** 资源限额。 */
  readonly limits: BoxLimits
}

/** 一次"给我这个会话的箱"的请求。 */
export interface BoxRequest {
  /** 归属会话；`undefined` 归到 `default` 桶（无 agent 的调用）。 */
  readonly sessionId?: string | undefined
  /** 宿主上的工作区根——`workspace-write` 的边界。 */
  readonly workspaceRoot: string
  /** 沙箱模式；决定围栏配置。 */
  readonly mode: ConfinedSandboxMode
}

/** 会话标识归一化：无会话的调用共享一个桶。 */
export function sessionKey(sessionId?: string): string {
  return sessionId && sessionId.length > 0 ? sessionId : 'default'
}

/** 一个会话的绑定：箱本身，以及创建它的后端。 */
interface Binding {
  readonly box: BoxHandle
  readonly backend: BoxBackend
}

/** 会话级的箱管理器。 */
export class BoxManager {
  readonly #registry: BackendRegistry
  readonly #defaults: BoxDefaults
  readonly #bindings = new Map<string, Binding>()

  constructor(registry: BackendRegistry, defaults: BoxDefaults) {
    this.#registry = registry
    this.#defaults = defaults
  }

  /** 当前已绑定的箱（只读快照）。 */
  list(): BoxHandle[] {
    return [...this.#bindings.values()].map((b) => b.box)
  }

  /** 某个会话是否已有箱。 */
  has(sessionId?: string): boolean {
    return this.#bindings.has(sessionKey(sessionId))
  }

  /**
   * 取得该会话的箱，没有就建一个。
   *
   * 选后端走 `registry.select()`；没有可用后端时抛 `BackendUnavailableError`——
   * 这里**没有**"那就直接在宿主上跑"的分支，也永远不会有。
   */
  async boxFor(request: BoxRequest): Promise<BoxHandle> {
    return (await this.#bindingFor(request)).box
  }

  /**
   * 在该会话的箱里执行一次命令。
   *
   * provider 不应自己去 `select()` 后端——那样会绕过会话绑定，出现同一个会话
   * 的命令落在两个箱里的情况。
   */
  async exec(request: BoxRequest, exec: BoxExecRequest): Promise<BoxExecResult> {
    const binding = await this.#bindingFor(request)
    return binding.backend.exec(binding.box, exec)
  }

  /**
   * 在该会话的箱里启动一次流式执行。
   *
   * 后端不支持流式时抛错而不是退化成批式——退化成批式会静默改变
   * "立即返回活句柄"的语义，调用方会以为自己在流式消费。
   */
  async startExec(request: BoxRequest, exec: BoxExecRequest): Promise<BoxExecStream> {
    const binding = await this.#bindingFor(request)
    if (!binding.backend.startExec) {
      throw new BackendUnavailableError(
        `backend '${binding.backend.name}' does not support streaming exec`,
      )
    }
    return binding.backend.startExec(binding.box, exec)
  }

  /** 取绑定，不存在则创建。 */
  async #bindingFor(request: BoxRequest): Promise<Binding> {
    const key = sessionKey(request.sessionId)
    const existing = this.#bindings.get(key)
    if (existing) {
      return existing
    }

    const backend = await this.#registry.select()
    const spec: BoxSpec = {
      sessionId: key,
      workspaceRoot: request.workspaceRoot,
      workspaceMountPath: request.workspaceRoot,
      image: this.#defaults.image,
      network: this.#defaults.network,
      limits: this.#defaults.limits,
      confinement: confinementFor(request.mode),
    }

    const box = await backend.create(spec)
    const binding: Binding = { box, backend }
    this.#bindings.set(key, binding)
    return binding
  }

  /**
   * 释放一个会话的箱。幂等——箱已不在也返回 `false` 而不抛错。
   * @returns 该会话原本是否有箱。
   */
  async release(sessionId?: string): Promise<boolean> {
    const key = sessionKey(sessionId)
    const binding = this.#bindings.get(key)
    if (!binding) {
      return false
    }
    this.#bindings.delete(key)
    await binding.backend.remove(binding.box)
    return true
  }

  /**
   * 释放全部箱。用于服务卸载——不留孤儿容器。
   * @throws BackendUnavailableError - 有箱要回收却联系不上任何后端时抛出。
   *   这种情况必须被看见：静默跳过等于在宿主上留垃圾。
   */
  async releaseAll(): Promise<void> {
    const bindings = [...this.#bindings.values()]
    this.#bindings.clear()
    if (bindings.length === 0) {
      return
    }
    const failures: string[] = []
    for (const binding of bindings) {
      try {
        await binding.backend.remove(binding.box)
      } catch (error) {
        failures.push(`${binding.box.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length > 0) {
      throw new BackendUnavailableError(
        `failed to release ${String(failures.length)} box(es) — ${failures.join('; ')}`,
      )
    }
  }
}
