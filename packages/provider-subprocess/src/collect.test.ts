/**
 * collect 缓冲的语义测试。
 *
 * 这些断言锁的是官方契约里最容易做错的三件事：**保留尾部而不是头部**、
 * **偏移是非消费式的**、**滑出窗口要标记有损**。做错了不会报错，只会让上层
 * 拿到不完整的输出还以为一切正常。
 *
 * @module @dsh-runbox/provider-subprocess/collect.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { pickWorldRoot } from '@dsh-runbox/core'

import { CollectBuffer, DEFAULT_MODE } from './index.ts'

describe('CollectBuffer 基础语义', () => {
  it('未超限时快照就是全文', () => {
    const buffer = new CollectBuffer(1024)
    buffer.push('hello ')
    buffer.push('world')
    assert.deepEqual(buffer.snapshot(), { text: 'hello world', truncated: false })
  })

  it('超限后保留的是尾部——诊断信息总在最后面', () => {
    const buffer = new CollectBuffer(4)
    buffer.push('HEADmiddleTAIL')
    const snapshot = buffer.snapshot()
    assert.equal(snapshot.truncated, true)
    assert.equal(snapshot.text, 'TAIL')
  })

  it('保留量严格不超过上限（多字节字符按字节计）', () => {
    const buffer = new CollectBuffer(5)
    buffer.push('HEADmiddleTAIL')
    assert.equal(buffer.retainedBytes, 5)
    assert.equal(buffer.snapshot().text, 'eTAIL')
  })

  it('totalBytes 统计的是全流，不是保留量', () => {
    const buffer = new CollectBuffer(4)
    buffer.push('1234567890')
    assert.equal(buffer.totalBytes, 10)
    assert.equal(buffer.retainedBytes, 4)
  })

  it('上限为 0 时全部丢弃但总数仍然准确', () => {
    const buffer = new CollectBuffer(0)
    buffer.push('abc')
    assert.equal(buffer.snapshot().text, '')
    assert.equal(buffer.totalBytes, 3)
  })
})

describe('CollectBuffer 偏移读取', () => {
  it('从 0 读全文，nextOffset 指向全流末尾', () => {
    const buffer = new CollectBuffer(1024)
    buffer.push('abc')
    const read = buffer.readFrom(0)
    assert.equal(read.text, 'abc')
    assert.equal(read.nextOffset, 3)
    assert.equal(read.lossy, false)
  })

  it('连续读不重复输出（非消费式）', () => {
    const buffer = new CollectBuffer(1024)
    buffer.push('abc')
    const first = buffer.readFrom(0)
    buffer.push('def')
    const second = buffer.readFrom(first.nextOffset)
    assert.equal(second.text, 'def')
    assert.equal(second.nextOffset, 6)
  })

  it('两个独立读者互不抢输出', () => {
    const buffer = new CollectBuffer(1024)
    buffer.push('shared')
    assert.equal(buffer.readFrom(0).text, 'shared')
    assert.equal(buffer.readFrom(0).text, 'shared')
  })

  it('请求的偏移仍在窗口内时不算有损', () => {
    const buffer = new CollectBuffer(4)
    buffer.push('0123456789') // 窗口 = '6789'，起始偏移 6
    const read = buffer.readFrom(6)
    assert.equal(read.lossy, false)
    assert.equal(read.text, '6789')
  })

  it('请求的偏移滑出窗口时标记有损，并返回整个保留尾部', () => {
    const buffer = new CollectBuffer(4)
    buffer.push('0123456789')
    const read = buffer.readFrom(0)
    assert.equal(read.lossy, true)
    assert.equal(read.text, '6789')
    assert.equal(read.nextOffset, 10)
  })

  it('偏移超出全流长度时被夹住，不抛错', () => {
    const buffer = new CollectBuffer(64)
    buffer.push('abc')
    const read = buffer.readFrom(999)
    assert.equal(read.text, '')
    assert.equal(read.nextOffset, 3)
  })
})

describe('CollectBuffer spill 文件', () => {
  it('配置了 spill 时完整流可恢复', () => {
    const buffer = new CollectBuffer(4, { maxBytes: 1024 })
    buffer.push('0123456789')
    const read = buffer.readFrom(0)
    assert.ok(read.lossy)
    assert.ok(read.spillPath, '截断时应当给出去哪儿捞完整内容')
    assert.equal(readFileSync(read.spillPath, 'utf8'), '0123456789')
    buffer.dispose()
  })

  it('超过 spill 上限时丢弃 spill——不完整的文件比没有更危险', () => {
    const buffer = new CollectBuffer(4, { maxBytes: 3 })
    buffer.push('0123456789')
    assert.equal(buffer.readFrom(0).spillPath, undefined)
    buffer.dispose()
  })

  it('未配置 spill 时截断就是彻底丢了，且如实汇报', () => {
    const buffer = new CollectBuffer(4)
    buffer.push('0123456789')
    const read = buffer.readFrom(0)
    assert.equal(read.spillPath, undefined)
    assert.equal(read.lossy, true)
  })

  it('dispose 之后不再给 spill 路径', () => {
    const buffer = new CollectBuffer(4, { maxBytes: 1024 })
    buffer.push('0123456789')
    const path = buffer.readFrom(0).spillPath
    assert.ok(path)
    buffer.dispose()
    assert.equal(buffer.readFrom(0).spillPath, undefined)
  })
})

describe('执行世界解析（这个 seam 拿不到 session，靠继承收敛）', () => {
  it('cwd 落在已挂载的世界之下时，复用那个世界', () => {
    assert.equal(pickWorldRoot('/repo/sub', ['/repo']), '/repo')
  })

  it('嵌套时取最深的那层', () => {
    assert.equal(pickWorldRoot('/repo/inner/src', ['/repo', '/repo/inner']), '/repo/inner')
  })

  it('cwd 不在任何已知世界之下时不猜', () => {
    assert.equal(pickWorldRoot('/elsewhere', ['/repo']), undefined)
  })

  it('前缀相同但不是子路径的不算命中', () => {
    assert.equal(pickWorldRoot('/repo-other/src', ['/repo']), undefined)
  })

  it('默认模式是受限的', () => {
    assert.notEqual(DEFAULT_MODE, 'danger-full-access')
  })
})
