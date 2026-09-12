/**
 * 路径语义的测试。
 *
 * 这些断言锁的是两类**静默失效**：包含判断因分隔符不同而永远返回 false，
 * 以及 Windows 宿主的路径在箱里根本打不开。两者都不会报错。
 *
 * @module @dsh-runbox/core/paths.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fromBoxPath, isAtOrUnder, toBoxPath } from './paths.ts'

describe('isAtOrUnder', () => {
  it('相等算包含', () => {
    assert.equal(isAtOrUnder('/w', '/w'), true)
  })

  it('子路径算包含', () => {
    assert.equal(isAtOrUnder('/w', '/w/a/b.txt'), true)
  })

  it('前缀相同但不是子路径的不算', () => {
    assert.equal(isAtOrUnder('/w', '/w-other/a.txt'), false)
  })

  it('父级与越级不算', () => {
    assert.equal(isAtOrUnder('/w', '/'), false)
    assert.equal(isAtOrUnder('/w', '/etc/passwd'), false)
  })

  it('尾斜杠不影响判断', () => {
    assert.equal(isAtOrUnder('/w/', '/w/a.txt'), true)
    assert.equal(isAtOrUnder('/w/', '/w-other'), false)
  })

  it('Windows 反斜杠路径同样成立——否则围栏会静默失效', () => {
    assert.equal(isAtOrUnder('C:\\repo', 'C:\\repo\\a.txt'), true)
    assert.equal(isAtOrUnder('C:\\repo', 'C:\\repo-other\\a.txt'), false)
    assert.equal(isAtOrUnder('C:\\repo\\', 'C:\\repo\\sub\\a.txt'), true)
  })

  it('混合分隔符也能判对', () => {
    assert.equal(isAtOrUnder('C:\\repo', 'C:/repo/a.txt'), true)
  })

  it('根目录是万物的父级', () => {
    assert.equal(isAtOrUnder('/', '/anything'), true)
    assert.equal(isAtOrUnder('/', '/'), true)
  })
})

describe('toBoxPath', () => {
  it('POSIX 宿主恒等映射', () => {
    assert.equal(toBoxPath('/repo/a.txt', 'posix'), '/repo/a.txt')
  })

  it('Windows 盘符降为路径段', () => {
    assert.equal(toBoxPath('E:\\repo\\a.txt', 'win32'), '/e/repo/a.txt')
    assert.equal(toBoxPath('C:/Users/x', 'win32'), '/c/Users/x')
  })

  it('裸盘符映射到根', () => {
    assert.equal(toBoxPath('D:\\', 'win32'), '/d')
    assert.equal(toBoxPath('D:', 'win32'), '/d')
  })

  it('UNC 路径不假装能映射', () => {
    const mapped = toBoxPath('\\\\server\\share\\a', 'win32')
    assert.ok(mapped.startsWith('/'), '至少要给出一个绝对 POSIX 路径')
  })
})

describe('fromBoxPath', () => {
  it('POSIX 恒等', () => {
    assert.equal(fromBoxPath('/repo/a.txt', 'posix'), '/repo/a.txt')
  })

  it('Windows 还原盘符', () => {
    assert.equal(fromBoxPath('/e/repo/a.txt', 'win32'), 'E:\\repo\\a.txt')
  })

  it('与 toBoxPath 互逆（Windows）', () => {
    const host = 'E:\\dsh开发\\packages\\core'
    assert.equal(fromBoxPath(toBoxPath(host, 'win32'), 'win32'), host)
  })
})
