/**
 * collect 模式的输出缓冲。
 *
 * 官方契约对它的要求很具体，而且**很容易做错**：
 * - `text` 是流的**尾部**（截断时），不是头部——诊断信息总在最后面。
 * - 读取按**整字节偏移**进行，`readFrom(fromByte)` 非消费式：两个独立读者互不
 *   抢输出。
 * - 请求的偏移已经滑出内存窗口时，读要标记 `lossy`，而完整内容只能从 spill
 *   文件里捞。
 *
 * 单独成文件是因为这些语义可以用纯函数测死，不需要 Docker。
 *
 * @module @dsh-runbox/provider-subprocess/collect
 */

import { mkdtempSync, rmSync, writeSync, closeSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一次增量读取的结果。 */
export interface CollectRead {
  /** 从请求偏移开始的文本；请求偏移已滑出窗口时是整个保留尾部。 */
  readonly text: string
  /** 下一次读取应使用的整字节偏移。 */
  readonly nextOffset: number
  /** 请求的偏移是否已滑出内存窗口。 */
  readonly lossy: boolean
  /** 完整流的 spill 文件路径（存在且完好时）。 */
  readonly spillPath?: string
}

/** 缓冲的当前快照，对应官方 `CollectedOutput`。 */
export interface CollectSnapshot {
  /** 保留的尾部文本。 */
  readonly text: string
  /** 是否丢弃过字节。 */
  readonly truncated: boolean
  /** 完整流的 spill 文件路径。 */
  readonly spillPath?: string
}

/** spill 文件的可选配置。 */
export interface SpillOptions {
  /** 全流字节上限；超过则丢弃 spill（保留一个不完整的文件比没有更危险）。 */
  readonly maxBytes: number
}

/**
 * 有界的内存缓冲 + 可选的全流 spill。
 *
 * @example
 * ```ts
 * const buffer = new CollectBuffer(1024, { maxBytes: 1024 * 1024 })
 * buffer.push('hello')
 * buffer.readFrom(0) // { text: 'hello', nextOffset: 5, lossy: false }
 * ```
 */
export class CollectBuffer {
  readonly #maxBytes: number
  readonly #spill: SpillOptions | undefined
  #retained: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  /** 已从头部丢弃的字节数——也是"内存窗口起点"的整字节偏移。 */
  #droppedHead = 0
  /** 全流总字节数，即下一个写入位置的偏移。 */
  #total = 0
  #spillPath: string | undefined
  #spillFd: number | undefined
  #spillBytes = 0
  #spillBroken = false

  constructor(maxBytes: number, spill?: SpillOptions) {
    this.#maxBytes = Math.max(0, maxBytes)
    this.#spill = spill
  }

  /** 全流累计字节数（不是当前保留量）。 */
  get totalBytes(): number {
    return this.#total
  }

  /** 当前保留在内存里的字节数。 */
  get retainedBytes(): number {
    return this.#retained.length
  }

  /** 是否已经丢过字节。 */
  get truncated(): boolean {
    return this.#droppedHead > 0
  }

  /** 写入一段文本。 */
  push(text: string): void {
    if (text.length === 0) {
      return
    }
    const chunk = Buffer.from(text, 'utf8')
    this.#total += chunk.length
    this.#writeSpill(chunk)

    if (this.#maxBytes === 0) {
      this.#droppedHead = this.#total
      this.#retained = Buffer.alloc(0)
      return
    }
    this.#retained = this.#retained.length === 0 ? chunk : Buffer.concat([this.#retained, chunk])
    if (this.#retained.length > this.#maxBytes) {
      const drop = this.#retained.length - this.#maxBytes
      this.#retained = this.#retained.subarray(drop)
      this.#droppedHead += drop
    }
  }

  /**
   * 从整字节偏移读取增量。
   * @param fromByte - 起始偏移（上一次读的 `nextOffset`，首次为 0）。
   * @returns 增量文本、下一偏移与有损标记。
   */
  readFrom(fromByte: number): CollectRead {
    const offset = Math.max(0, Math.min(fromByte, this.#total))
    const spillPath = this.#usableSpillPath()
    if (offset < this.#droppedHead) {
      return {
        text: this.#retained.toString('utf8'),
        nextOffset: this.#total,
        lossy: true,
        ...(spillPath ? { spillPath } : {}),
      }
    }
    const start = offset - this.#droppedHead
    return {
      text: this.#retained.subarray(start).toString('utf8'),
      nextOffset: this.#total,
      lossy: false,
      ...(spillPath ? { spillPath } : {}),
    }
  }

  /** 当前快照，用于批式结果。 */
  snapshot(): CollectSnapshot {
    const spillPath = this.#usableSpillPath()
    return {
      text: this.#retained.toString('utf8'),
      truncated: this.truncated,
      ...(spillPath ? { spillPath } : {}),
    }
  }

  /** 关闭并删除 spill 文件。 */
  dispose(): void {
    if (this.#spillFd !== undefined) {
      try {
        closeSync(this.#spillFd)
      } catch {
        // 已经关了就算了
      }
      this.#spillFd = undefined
    }
    if (this.#spillPath) {
      try {
        rmSync(this.#spillPath, { force: true })
      } catch {
        // 清理失败不该让上层流程失败
      }
      this.#spillPath = undefined
    }
  }

  /** 只有存在、未被超限、且写入没出错时，spill 路径才算可用。 */
  #usableSpillPath(): string | undefined {
    if (this.#spillBroken || this.#spillPath === undefined) {
      return undefined
    }
    return this.#spillPath
  }

  #writeSpill(chunk: Buffer): void {
    if (!this.#spill || this.#spillBroken) {
      return
    }
    if (this.#spillBytes + chunk.length > this.#spill.maxBytes) {
      this.#spillBroken = true
      this.dispose()
      return
    }
    try {
      if (this.#spillPath === undefined) {
        const dir = mkdtempSync(join(tmpdir(), 'runbox-spill-'))
        this.#spillPath = join(dir, 'stream.log')
        this.#spillFd = openSync(this.#spillPath, 'w')
      }
      if (this.#spillFd !== undefined) {
        writeSync(this.#spillFd, chunk)
        this.#spillBytes += chunk.length
      }
    } catch {
      this.#spillBroken = true
    }
  }
}
