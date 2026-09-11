/**
 * 策略翻译的单测。
 *
 * 这些断言存在的理由很直接：如果 `confinementFor` 把 `read-only` 翻成可写工作区，
 * 整个项目的隔离承诺就是假的，而且不会有任何运行时报错。这种错误只能靠测试抓。
 *
 * @module @dsh-runbox/core/policy.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { UnsupportedModeError } from './errors.ts'
import { confinementFor, withinWorkspace } from './policy.ts'

describe('confinementFor', () => {
  it('read-only：rootfs 与工作区都只读', () => {
    const c = confinementFor('read-only')
    assert.equal(c.rootfsReadOnly, true)
    assert.equal(c.workspaceReadOnly, true)
  })

  it('workspace-write：rootfs 仍只读，工作区放开', () => {
    const c = confinementFor('workspace-write')
    assert.equal(c.rootfsReadOnly, true, '可写 rootfs 会让隔离形同虚设')
    assert.equal(c.workspaceReadOnly, false)
  })

  it('两种受限模式都报 full 强制执行', () => {
    assert.equal(confinementFor('read-only').enforcement, 'full')
    assert.equal(confinementFor('workspace-write').enforcement, 'full')
  })

  it('都提供 /tmp 与 /run 作为可写临时区', () => {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      assert.deepEqual(confinementFor(mode).tmpfsPaths, ['/tmp', '/run'])
    }
  })

  it('danger-full-access 必须抛错——它根本不该到达隔离后端', () => {
    assert.throws(
      () => confinementFor('danger-full-access' as never),
      UnsupportedModeError,
    )
  })
})

describe('withinWorkspace', () => {
  it('根目录自身算在内', () => {
    assert.equal(withinWorkspace('/w', '/w'), true)
  })

  it('子路径算在内', () => {
    assert.equal(withinWorkspace('/w', '/w/a/b.txt'), true)
  })

  it('前缀相同但不是子路径的不算', () => {
    assert.equal(withinWorkspace('/w', '/w-other/a.txt'), false)
  })

  it('父级与越级路径不算', () => {
    assert.equal(withinWorkspace('/w', '/'), false)
    assert.equal(withinWorkspace('/w', '/etc/passwd'), false)
  })

  it('根目录以斜杠结尾时也正确', () => {
    assert.equal(withinWorkspace('/w/', '/w/a.txt'), true)
    assert.equal(withinWorkspace('/w/', '/w-other'), false)
  })
})
