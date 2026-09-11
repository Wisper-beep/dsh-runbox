/**
 * shell 执行器的纯逻辑测试。
 *
 * 这里测的三个函数决定了上层看到的**事实是否诚实**：截断是否保留了尾部、
 * 拒绝是否被识别、上限是否真的封顶。它们都不需要 Docker。
 *
 * @module @dsh-runbox/provider-shell/index.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  clamp,
  DEFAULT_SANDBOX_MODE,
  DEFAULT_TIMEOUT_MS,
  isDenial,
  keepTail,
  MAX_TIMEOUT_MS,
} from './index.ts'

describe('keepTail', () => {
  it('未超限时原样返回且标记未截断', () => {
    assert.deepEqual(keepTail('hello', 100), { text: 'hello', truncated: false })
  })

  it('超限时保留尾部而不是头部——诊断信息在最后面', () => {
    const result = keepTail('HEAD-middle-TAIL', 4)
    assert.equal(result.truncated, true)
    assert.equal(result.text, 'TAIL')
  })

  it('多字节字符不会被劈开', () => {
    const result = keepTail('中文测试内容', 6) // 每个汉字 3 字节
    assert.equal(result.text, '内容')
    assert.equal(result.truncated, true)
    assert.equal(Buffer.byteLength(result.text, 'utf8'), 6)
  })

  it('上限为 0 时返回空串而不是抛错', () => {
    assert.equal(keepTail('anything', 0).text, '')
  })
})

describe('isDenial', () => {
  it('只读文件系统的报错算拒绝', () => {
    assert.equal(isDenial('bash: /etc/x: Read-only file system'), true)
  })

  it('权限不足算拒绝', () => {
    assert.equal(isDenial('touch: cannot touch: Permission denied'), true)
  })

  it('能力缺失算拒绝', () => {
    assert.equal(isDenial('mount: Operation not permitted'), true)
  })

  it('普通业务报错不算拒绝', () => {
    assert.equal(isDenial('ls: cannot access /nope: No such file or directory'), false)
  })

  it('空 stderr 不算拒绝', () => {
    assert.equal(isDenial(''), false)
  })
})

describe('clamp', () => {
  it('落在区间内时不变', () => {
    assert.equal(clamp(500, 1, 1000), 500)
  })

  it('低于下界时抬到下界', () => {
    assert.equal(clamp(-5, 1, 1000), 1)
  })

  it('高于上界时压到上界——上限必须真的封顶', () => {
    assert.equal(clamp(1e12, 1, 1000), 1000)
  })

  it('NaN / Infinity 回落到下界', () => {
    assert.equal(clamp(Number.NaN, 1, 1000), 1)
    assert.equal(clamp(Number.POSITIVE_INFINITY, 1, 1000), 1000)
  })
})

describe('默认值契约', () => {
  it('超时上限不低于默认值', () => {
    assert.ok(MAX_TIMEOUT_MS >= DEFAULT_TIMEOUT_MS)
  })

  it('默认沙箱模式是受限的，不是 full-access', () => {
    assert.notEqual(DEFAULT_SANDBOX_MODE, 'danger-full-access')
  })
})
