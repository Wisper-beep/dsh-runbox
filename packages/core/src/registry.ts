/**
 * 后端注册表。
 *
 * 两个不可让步的性质：
 * 1. **注册即可逆**——`register()` 返回注销函数，符合官方 Cordis "可逆效果"
 *    的设计，插件热卸载时不留残余注册。
 * 2. **fail-closed 选择**——`select()` 逐个探测，谁都不可用就抛
 *    `BackendUnavailableError`。这里没有"退化为不隔离"的分支，永远不会有。
 *
 * @module @dsh-runbox/core/registry
 */

import { BackendUnavailableError } from './errors.ts'
import type { BoxBackend } from './types.ts'

/** 后端注册表。实例级状态，不依赖任何框架。 */
export class BackendRegistry {
  readonly #backends = new Map<string, BoxBackend>()

  /**
   * 注册一个后端。
   * @param backend - 要注册的后端实现。
   * @returns 注销函数；重复调用是安全的空操作。
   * @throws 同名后端已注册时抛出——静默覆盖会让"到底在用哪个后端"变得不可知。
   */
  register(backend: BoxBackend): () => void {
    if (this.#backends.has(backend.name)) {
      throw new Error(`runbox backend already registered: ${backend.name}`)
    }
    this.#backends.set(backend.name, backend)
    let disposed = false
    return () => {
      if (disposed) {
        return
      }
      disposed = true
      this.#backends.delete(backend.name)
    }
  }

  /** 已注册的后端名，按注册顺序。 */
  list(): readonly string[] {
    return [...this.#backends.keys()]
  }

  /** 按名取后端，不存在返回 `undefined`。 */
  get(name: string): BoxBackend | undefined {
    return this.#backends.get(name)
  }

  /**
   * 按注册顺序探测并返回第一个可用后端。
   *
   * @param preferred - 优先尝试的后端名；不可用则继续往后找。
   * @param signal - 探测的取消信号。
   * @returns 第一个探测通过的后端。
   * @throws BackendUnavailableError - 注册表为空或全部探测失败时抛出。
   *   绝不在这种情况下返回 `undefined` 让调用方自己想办法——那是静默回落的入口。
   */
  async select(preferred?: string, signal?: AbortSignal): Promise<BoxBackend> {
    const names = [...this.#backends.keys()]
    if (names.length === 0) {
      throw new BackendUnavailableError('no backend registered')
    }
    const ordered = preferred
      ? [preferred, ...names.filter((n) => n !== preferred)]
      : names

    const reasons: string[] = []
    for (const name of ordered) {
      const backend = this.#backends.get(name)
      if (!backend) {
        reasons.push(`${name}: not registered`)
        continue
      }
      try {
        if (await backend.probe(signal)) {
          return backend
        }
        reasons.push(`${name}: probe returned false`)
      } catch (cause) {
        reasons.push(`${name}: probe threw (${String(cause)})`)
      }
    }
    throw new BackendUnavailableError(`all backends failed probe — ${reasons.join('; ')}`)
  }
}
