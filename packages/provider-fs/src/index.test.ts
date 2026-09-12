/**
 * 文件能力的测试。
 *
 * 好消息是这个 provider **不需要容器**——围栏判定在进程内完成，因此这些用例
 * 在本地和 CI 上都能真跑，不必等 Docker。
 *
 * @module @dsh-runbox/provider-fs/index.test
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

import { toBoxPath } from '@dsh-runbox/core'

import {
  decodeText,
  detectEol,
  effectiveMode,
  fromLf,
  RunboxFileSystem,
  toLf,
  versionOf,
} from './index.ts'

describe('文本判定', () => {
  it('合法 UTF-8 通过', () => {
    assert.equal(decodeText(Buffer.from('你好 world', 'utf8')), '你好 world')
  })

  it('含 NUL 的字节判为二进制', () => {
    assert.equal(decodeText(Buffer.from([0x61, 0x00, 0x62])), undefined)
  })

  it('非法 UTF-8 判为二进制，而不是悄悄替换成 U+FFFD', () => {
    // 0xff 在 UTF-8 里永远非法；toString('utf8') 会把它变成 U+FFFD，
    // 那样"拒绝二进制"就成了"损坏二进制"。
    assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x61])), undefined)
  })

  it('空文件算文本', () => {
    assert.equal(decodeText(Buffer.alloc(0)), '')
  })
})

describe('换行风格', () => {
  it('识别 CRLF 与 LF', () => {
    assert.equal(detectEol('a\r\nb'), '\r\n')
    assert.equal(detectEol('a\nb'), '\n')
  })

  it('统一到 LF 再还原，能保持原风格', () => {
    const crlf = 'a\r\nb\r\n'
    assert.equal(fromLf(toLf(crlf), '\r\n'), crlf)
    assert.equal(fromLf(toLf('a\nb'), '\n'), 'a\nb')
  })
})

describe('模式判定', () => {
  it('缺策略时用安全默认值', () => {
    assert.equal(effectiveMode(undefined), 'workspace-write')
  })

  it('danger-full-access 被收窄，而不是照单全收', () => {
    const policy: SandboxExecutionPolicy = {
      mode: 'danger-full-access',
      workspaceRoot: '/w',
    }
    assert.equal(effectiveMode(policy), 'workspace-write')
  })

  it('受限模式原样传递', () => {
    assert.equal(effectiveMode({ mode: 'read-only', workspaceRoot: '/w' }), 'read-only')
  })
})

describe('新鲜度令牌', () => {
  it('同一 mtime 与大小得到同一版本', () => {
    assert.equal(versionOf(1234, 56), versionOf(1234, 56))
  })

  it('大小或时间变化即版本变化', () => {
    assert.notEqual(versionOf(1234, 56), versionOf(1234, 57))
    assert.notEqual(versionOf(1234, 56), versionOf(1235, 56))
  })
})

describe('路径映射（箱内与宿主不同）', () => {
  it('POSIX 宿主恒等', () => {
    assert.equal(toBoxPath('/repo/a.txt', 'posix'), '/repo/a.txt')
  })

  it('Windows 宿主盘符降为路径段', () => {
    assert.equal(toBoxPath('E:\\repo\\a.txt', 'win32'), '/e/repo/a.txt')
    assert.equal(toBoxPath('C:/Users/x', 'win32'), '/c/Users/x')
  })

  it('裸盘符也能映射', () => {
    assert.equal(toBoxPath('D:\\', 'win32'), '/d')
  })
})

// —— 以下用例在真实文件系统上跑，不需要容器 ——

const sandbox = mkdtempSync(join(tmpdir(), 'runbox-fs-'))
const policy = (mode: SandboxExecutionPolicy['mode'], root = sandbox): SandboxExecutionPolicy => ({
  mode,
  workspaceRoot: root,
})

let fsService: RunboxFileSystem

before(async () => {
  const ctx = new Context()
  await ctx.plugin({ name: 'fs-under-test', apply: (c) => void new RunboxFileSystem(c) })
  fsService = (ctx as unknown as { fs: RunboxFileSystem }).fs
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('真实文件系统：读写', () => {
  it('创建文件并返回 create 与版本', async () => {
    const target = await fsService.resolve(join(sandbox, 'a.txt'))
    const outcome = await fsService.writeText(target, 'hello\n', undefined, undefined, policy('workspace-write'))
    assert.equal(outcome.operation, 'create')
    assert.equal(outcome.before, null)
    assert.equal(outcome.after, 'hello\n')
    assert.equal(readFileSync(join(sandbox, 'a.txt'), 'utf8'), 'hello\n')
  })

  it('读回内容与写入一致', async () => {
    const target = await fsService.resolve(join(sandbox, 'a.txt'))
    assert.equal(await fsService.readText(target), 'hello\n')
  })

  it('覆盖已有文件返回 update 并带出 before', async () => {
    const target = await fsService.resolve(join(sandbox, 'a.txt'))
    const outcome = await fsService.writeText(target, 'world\n', undefined, undefined, policy('workspace-write'))
    assert.equal(outcome.operation, 'update')
    assert.equal(outcome.before, 'hello\n')
    assert.equal(outcome.after, 'world\n')
  })

  it('createIfAbsent 对已存在的文件必须失败', async () => {
    const target = await fsService.resolve(join(sandbox, 'a.txt'))
    await assert.rejects(
      () =>
        fsService.writeText(
          target,
          'nope',
          { kind: 'createIfAbsent' },
          undefined,
          policy('workspace-write'),
        ),
      /already exists/,
    )
  })

  it('replaceIfVersion 的陈旧版本被拒绝', async () => {
    const target = await fsService.resolve(join(sandbox, 'a.txt'))
    const stale = versionOf(1, 1)
    await assert.rejects(
      () =>
        fsService.writeText(
          target,
          'x',
          { kind: 'replaceIfVersion', version: stale },
          undefined,
          policy('workspace-write'),
        ),
      /stale content/,
    )
  })

  it('stat 对不存在的目标返回 undefined 而不是抛错', async () => {
    const target = await fsService.resolve(join(sandbox, 'nope.txt'))
    assert.equal(await fsService.stat(target), undefined)
  })

  it('CRLF 文件被编辑后仍是 CRLF', async () => {
    writeFileSync(join(sandbox, 'crlf.txt'), 'a\r\nb\r\n', 'utf8')
    const target = await fsService.resolve(join(sandbox, 'crlf.txt'))
    const outcome = await fsService.editText(
      target,
      { oldString: 'b', newString: 'B', replaceAll: false },
      undefined,
      undefined,
      policy('workspace-write'),
    )
    assert.equal(outcome.after, 'a\nB\n', 'outcome 里的内容是 LF 归一化的')
    assert.equal(readFileSync(join(sandbox, 'crlf.txt'), 'utf8'), 'a\r\nB\r\n', '磁盘上必须保持 CRLF')
  })
})

describe('真实文件系统：编辑的三种结局', () => {
  it('唯一匹配正常替换', async () => {
    const target = await fsService.resolve(join(sandbox, 'edit.txt'))
    await fsService.writeText(target, 'one two three\n', undefined, undefined, policy('workspace-write'))
    const outcome = await fsService.editText(
      target,
      { oldString: 'two', newString: 'TWO', replaceAll: false },
      undefined,
      undefined,
      policy('workspace-write'),
    )
    assert.equal(outcome.after, 'one TWO three\n')
  })

  it('多处匹配且未指定 replaceAll → 报歧义', async () => {
    const target = await fsService.resolve(join(sandbox, 'edit2.txt'))
    await fsService.writeText(target, 'x x x\n', undefined, undefined, policy('workspace-write'))
    await assert.rejects(
      () =>
        fsService.editText(
          target,
          { oldString: 'x', newString: 'y', replaceAll: false },
          undefined,
          undefined,
          policy('workspace-write'),
        ),
      /appears 3 times/,
    )
  })

  it('replaceAll 全替换', async () => {
    const target = await fsService.resolve(join(sandbox, 'edit2.txt'))
    const outcome = await fsService.editText(
      target,
      { oldString: 'x', newString: 'y', replaceAll: true },
      undefined,
      undefined,
      policy('workspace-write'),
    )
    assert.equal(outcome.after, 'y y y\n')
  })

  it('找不到匹配 → 报 not found', async () => {
    const target = await fsService.resolve(join(sandbox, 'edit2.txt'))
    await assert.rejects(
      () =>
        fsService.editText(
          target,
          { oldString: 'zzz', newString: 'q', replaceAll: false },
          undefined,
          undefined,
          policy('workspace-write'),
        ),
      /not found/,
    )
  })

  it('空 oldString 直接拒绝', async () => {
    const target = await fsService.resolve(join(sandbox, 'edit2.txt'))
    await assert.rejects(
      () =>
        fsService.editText(
          target,
          { oldString: '', newString: 'q', replaceAll: false },
          undefined,
          undefined,
          policy('workspace-write'),
        ),
      /non-empty/,
    )
  })
})

describe('真实文件系统：围栏（这是本 provider 存在的理由）', () => {
  it('read-only 模式下拒绝一切变更', async () => {
    const target = await fsService.resolve(join(sandbox, 'ro.txt'))
    await assert.rejects(
      () => fsService.writeText(target, 'nope', undefined, undefined, policy('read-only')),
      (error: unknown) => {
        assert.match(String(error), /read-only/)
        assert.equal((error as { code?: string }).code, 'FS_SANDBOX_DENIED')
        return true
      },
    )
    assert.equal(await fsService.stat(target), undefined, '被拒绝的写入不该留下文件')
  })

  it('工作区之外的写入被拒绝', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'runbox-outside-'))
    try {
      const target = await fsService.resolve(join(outside, 'escaped.txt'))
      await assert.rejects(
        () => fsService.writeText(target, 'nope', undefined, undefined, policy('workspace-write')),
        (error: unknown) => {
          assert.match(String(error), /outside the workspace/)
          assert.equal((error as { code?: string }).code, 'FS_SANDBOX_DENIED')
          return true
        },
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('工作区内的子目录写入放行（目录不存在时如实报 IO 错误）', async () => {
    const target = await fsService.resolve(join(sandbox, 'sub', 'inside.txt'))
    await assert.rejects(
      () =>
        fsService.writeText(target, 'x', undefined, undefined, policy('workspace-write')),
      /ENOENT|no such file/,
      '目录不存在应当是 IO 错误，而不是被围栏拒绝',
    )
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(sandbox, 'sub'), { recursive: true })
    const outcome = await fsService.writeText(
      target,
      'ok\n',
      undefined,
      undefined,
      policy('workspace-write'),
    )
    assert.equal(outcome.operation, 'create')
  })

  it('没有工作区边界时新建文件被拒绝——不猜边界', async () => {
    const target = await fsService.resolve(join(sandbox, 'no-boundary.txt'))
    await assert.rejects(
      () => fsService.writeText(target, 'x'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'FS_SANDBOX_DENIED')
        return true
      },
    )
  })
})

describe('真实文件系统：列举与目标身份', () => {
  it('listDir 按名稳定排序且标注类型', async () => {
    const dir = mkdtempSync(join(sandbox, 'list-'))
    const target = await fsService.resolve(dir)
    writeFileSync(join(dir, 'b.txt'), 'b')
    writeFileSync(join(dir, 'a.txt'), 'a')
    const entries = await fsService.listDir(target)
    assert.deepEqual(
      entries.map((e) => e.name),
      ['a.txt', 'b.txt'],
    )
    assert.equal(entries[0]?.type, 'file')
  })

  it('resolve 让同一文件的不同别名得到同一身份', async () => {
    const direct = await fsService.resolve(join(sandbox, 'a.txt'))
    const viaDot = await fsService.resolve(join(sandbox, '.', 'a.txt'))
    assert.equal(direct.targetKey, viaDot.targetKey)
  })

  it('contains 判断词法包含', async () => {
    const root = await fsService.resolve(sandbox)
    const child = await fsService.resolve(join(sandbox, 'a.txt'))
    assert.equal(fsService.contains(root, child), true)
    assert.equal(fsService.contains(child, root), false)
  })

  it('processPath 返回箱内路径而不是宿主路径', async () => {
    const target = await fsService.resolve(join(sandbox, 'a.txt'))
    const boxPath = fsService.processPath(target)
    assert.ok(boxPath.startsWith('/'), '箱内路径必须是绝对 POSIX 路径')
    assert.equal(fsService.fileUrl(target).startsWith('file://'), true)
  })
})

describe('真实文件系统：二进制拒绝', () => {
  it('读二进制文件报 FS_NOT_TEXT', async () => {
    const binary = join(sandbox, 'blob.bin')
    writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
    const target = await fsService.resolve(binary)
    await assert.rejects(
      () => fsService.readText(target),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'FS_NOT_TEXT')
        return true
      },
    )
  })

  it('不存在文件报 FS_NOT_FOUND', async () => {
    const target = await fsService.resolve(join(sandbox, 'ghost.txt'))
    await assert.rejects(
      () => fsService.readText(target),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'FS_NOT_FOUND')
        return true
      },
    )
  })
})
