/**
 * 执行世界的绑定与箱的生命周期。
 *
 * 归 core 而不是某个 provider：所有 provider（shell / fs / subprocess / jobs）都必须
 * 看到**同一个**执行世界。绑定以**解析出的世界根**为键，而不是以调用方自报的
 * session 或 cwd 为键——后者正是"同一会话两个箱"的来源。
 *
 * @module @dsh-runbox/core/box-manager
 */

import type { ConfinedSandboxMode } from '@deepseek-ai/dsh-sandbox'

import { BackendUnavailableError } from './errors.ts'
import { confinementFor } from './policy.ts'
import { hostPlatform, toBoxPath } from './paths.ts'
import type { BackendRegistry } from './registry.ts'
import type {
  BoxBackend,
  BoxExecRequest,
  BoxExecResult,
  BoxExecStream,
  BoxHandle,
  BoxTerminal,
  BoxTerminalRequest,
  BoxLimits,
  BoxNetworkMode,
  BoxSpec,
} from './types.ts'
import { resolveWorldRoot } from './world.ts'

/** 建箱时的默认值；逐世界可以按策略覆盖。 */
export interface BoxDefaults {
  /** 镜像引用。 */
  readonly image: string
  /** 网络模式。 */
  readonly network: BoxNetworkMode
  /** 资源限额。 */
  readonly limits: BoxLimits
}

/**
 * 一次"给我这个执行世界的箱"的请求。
 *
 * 注意这里**没有** `sessionId` 作为绑定依据：会话标识只用于标签与归因，
 * 世界的身份由工作区根决定。
 */
export interface BoxRequest {
  /** 执行发生的目录（绝对路径）。 */
  readonly cwd: string
  /**
   * 调用方**确知**的工作区根。
   *
   * 只有 `ctx.sandboxPolicy` 这一层能给出权威值（它带着会话的工作区）。拿不到时
   * 留空，让 `resolveWorldRoot` 走继承规则——不要在这里填 `cwd` 去"凑一个"，
   * 那会把本该收敛的两个世界拆开。
   */
  readonly workspaceRoot?: string | undefined
  /** 归属会话；仅用于标签与日志归因。 */
  readonly sessionId?: string | undefined
  /** 沙箱模式；决定围栏配置。 */
  readonly mode: ConfinedSandboxMode
}

/** 一个世界的绑定：箱本身，创建它的后端，以及人类可读的会话标签。 */
interface Binding {
  readonly box: BoxHandle
  readonly backend: BoxBackend
  readonly worldRoot: string
  readonly sessionId: string | undefined
}

/** 执行世界的箱管理器。 */
export class BoxManager {
  private readonly registry: BackendRegistry
  private readonly defaults: BoxDefaults
  private readonly bindings = new Map<string, Binding>()
  /** 已经挂载过的世界根——继承规则的数据来源。 */
  private readonly knownRoots: string[] = []

  constructor(registry: BackendRegistry, defaults: BoxDefaults) {
    this.registry = registry
    this.defaults = defaults
  }

  /** 当前已绑定的箱（只读快照）。 */
  list(): BoxHandle[] {
    return [...this.bindings.values()].map((binding) => binding.box)
  }

  /** 已挂载过的世界根。 */
  worlds(): readonly string[] {
    return [...this.knownRoots]
  }

  /**
   * 解析某次请求会落在哪个执行世界——**不建箱**，纯解析。
   *
   * 供诊断与测试使用；也让"这两次调用会不会共用同一个箱"变成可断言的。
   */
  async worldOf(request: Pick<BoxRequest, 'cwd' | 'workspaceRoot'>): Promise<string> {
    return resolveWorldRoot(request.cwd, request.workspaceRoot, this.knownRoots)
  }

  /**
   * 取得该执行世界的箱，没有就建一个。
   *
   * 选后端走 `registry.select()`；没有可用后端时抛 `BackendUnavailableError`——
   * 这里**没有**"那就直接在宿主上跑"的分支，也永远不会有。
   */
  async boxFor(request: BoxRequest): Promise<BoxHandle> {
    return (await this.bindingFor(request)).box
  }

  /**
   * 在该执行世界里执行一次命令。
   *
   * provider 不应自己去 `select()` 后端——那样会绕过世界绑定，出现同一个执行世界
   * 的命令落在两个箱里的情况。
   */
  async exec(request: BoxRequest, exec: BoxExecRequest): Promise<BoxExecResult> {
    const binding = await this.bindingFor(request)
    return binding.backend.exec(binding.box, exec)
  }

  /**
   * 在该执行世界里启动一次流式执行。
   *
   * 后端不支持流式时抛错而不是退化成批式——退化成批式会静默改变
   * "立即返回活句柄"的语义，调用方会以为自己在流式消费。
   */
  async startExec(request: BoxRequest, exec: BoxExecRequest): Promise<BoxExecStream> {
    const binding = await this.bindingFor(request)
    if (!binding.backend.startExec) {
      throw new BackendUnavailableError(
        `backend '${binding.backend.name}' does not support streaming exec`,
      )
    }
    return binding.backend.startExec(binding.box, exec)
  }

  /**
   * 在该执行世界里分配一个终端。
   *
   * 后端不支持 pty 时抛错而不是退化成管道——退化成管道会让交互式程序立刻
   * 表现出错误行为，而调用方只会看到"程序自己退出了"，排查方向完全是错的。
   */
  async startTerminal(request: BoxRequest, terminal: BoxTerminalRequest): Promise<BoxTerminal> {
    const binding = await this.bindingFor(request)
    if (!binding.backend.startTerminal) {
      throw new BackendUnavailableError(
        `backend '${binding.backend.name}' does not support terminal (pty) allocation`,
      )
    }
    return binding.backend.startTerminal(binding.box, terminal)
  }

  /** 取绑定，不存在则创建。 */
  private async bindingFor(request: BoxRequest): Promise<Binding> {
    const worldRoot = await this.worldOf(request)
    const existing = this.bindings.get(worldRoot)
    if (existing) {
      return existing
    }

    const backend = await this.registry.select()
    const spec: BoxSpec = {
      // 容器名与标签都挂在世界根上：一个世界一个箱，名字也就该由世界决定。
      sessionId: worldRoot,
      workspaceRoot: worldRoot,
      workspaceMountPath: toBoxPath(worldRoot, hostPlatform()),
      image: this.defaults.image,
      network: this.defaults.network,
      limits: this.defaults.limits,
      confinement: confinementFor(request.mode),
    }

    const box = await backend.create(spec)
    const binding: Binding = {
      box,
      backend,
      worldRoot,
      sessionId: request.sessionId,
    }
    this.bindings.set(worldRoot, binding)
    // 记住这个根：后续任何 cwd 落在它下面的调用都会复用同一个箱。
    if (!this.knownRoots.includes(worldRoot)) {
      this.knownRoots.push(worldRoot)
    }
    return binding
  }

  /**
   * 释放一个世界的箱。幂等——箱已不在也返回 `false` 而不抛错。
   *
   * @param selector - 世界根或当初传入的会话标识，两者都能定位。
   * @returns 是否确实释放了一个箱。
   */
  async release(selector?: string): Promise<boolean> {
    let key: string | undefined
    if (selector !== undefined && this.bindings.has(selector)) {
      key = selector
    } else if (selector !== undefined) {
      for (const [worldKey, binding] of this.bindings) {
        if (binding.sessionId === selector) {
          key = worldKey
          break
        }
      }
    }
    if (key === undefined) {
      return false
    }
    const binding = this.bindings.get(key)
    this.bindings.delete(key)
    if (binding) {
      await binding.backend.remove(binding.box)
    }
    return true
  }

  /**
   * 释放全部箱。用于服务卸载——不留孤儿容器。
   * @throws BackendUnavailableError - 有箱要回收却联系不上任何后端时抛出。
   *   这种情况必须被看见：静默跳过等于在宿主上留垃圾。
   */
  async releaseAll(): Promise<void> {
    const bindings = [...this.bindings.values()]
    this.bindings.clear()
    this.knownRoots.length = 0
    if (bindings.length === 0) {
      return
    }
    const failures: string[] = []
    for (const binding of bindings) {
      try {
        await binding.backend.remove(binding.box)
      } catch (error) {
        failures.push(
          `${binding.box.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (failures.length > 0) {
      throw new BackendUnavailableError(
        `failed to release ${String(failures.length)} box(es) — ${failures.join('; ')}`,
      )
    }
  }
}
