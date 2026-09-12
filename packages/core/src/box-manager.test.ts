/**
 * 执行世界绑定的测试。
 *
 * 这一组用例的存在理由很具体：**同一个会话只应该有一个箱**。此前 `provider-shell`
 * 按会话建箱、`provider-subprocess` 按 cwd 建箱，两者会为同一份工作区各建一个——
 * 于是 `fs.processPath()` 交出去的路径在子进程的箱里打不开，"共享执行世界"这条
 * 承诺就断了。
 *
 * 用一个桩后端就能把这条不变量钉死，不需要 Docker。
 *
 * @module @dsh-runbox/core/box-manager.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { BoxManager } from './box-manager.ts'
import { BackendRegistry } from './registry.ts'
import { canonicalWorldRoot, pickWorldRoot } from './world.ts'
import type { BoxBackend, BoxSpec } from './types.ts'

/** 记录每次 create 的规格，用来断言"到底建了几个箱、挂在哪个根上"。 */
class RecordingBackend implements BoxBackend {
  readonly name = 'recording'
  readonly specs: BoxSpec[] = []

  probe(): Promise<boolean> {
    return Promise.resolve(true)
  }

  create(spec: BoxSpec): Promise<{ id: string; sessionId: string; state: 'running'; createdAt: number }> {
    this.specs.push(spec)
    return Promise.resolve({
      id: `box-${String(this.specs.length)}`,
      sessionId: spec.sessionId,
      state: 'running',
      createdAt: Date.now(),
    })
  }

  exec(): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }> {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false })
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }

  remove(): Promise<void> {
    return Promise.resolve()
  }

  list(): Promise<never[]> {
    return Promise.resolve([])
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'runbox-world-'))
const workspace = join(sandbox, 'repo')
const nested = join(workspace, 'sub', 'deep')
const elsewhere = join(sandbox, 'other')
mkdirSync(nested, { recursive: true })
mkdirSync(elsewhere, { recursive: true })

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const makeManager = (): { manager: BoxManager; backend: RecordingBackend } => {
  const backend = new RecordingBackend()
  const registry = new BackendRegistry()
  registry.register(backend)
  const manager = new BoxManager(registry, {
    image: 'stub:latest',
    network: 'none',
    limits: { cpus: 1 },
  })
  return { manager, backend }
}

describe('pickWorldRoot（纯解析规则）', () => {
  it('取最深的那层包含根', () => {
    assert.equal(pickWorldRoot('/repo/inner/src', ['/repo', '/repo/inner']), '/repo/inner')
  })

  it('前缀相同但不是子路径不算命中', () => {
    assert.equal(pickWorldRoot('/repo-other', ['/repo']), undefined)
  })

  it('没有命中时返回 undefined，交由调用方决定', () => {
    assert.equal(pickWorldRoot('/somewhere', []), undefined)
  })
})

describe('同一份工作区只建一个箱（这是本次收敛的核心）', () => {
  it('shell 建箱后，subprocess 以自己的 cwd 请求时会复用同一个箱', async () => {
    const { manager, backend } = makeManager()

    // shell：拿得到权威的工作区根
    const shellBox = await manager.boxFor({
      cwd: nested,
      workspaceRoot: workspace,
      sessionId: 's1',
      mode: 'workspace-write',
    })

    // subprocess：拿不到会话，只知道自己在一个子目录里
    const subprocessBox = await manager.boxFor({
      cwd: nested,
      mode: 'workspace-write',
    })

    assert.equal(subprocessBox.id, shellBox.id, '两次请求必须落在同一个箱里')
    assert.equal(backend.specs.length, 1, '只应该建一个箱')
    assert.equal(backend.specs[0]?.workspaceRoot, await canonicalWorldRoot(workspace))
  })

  it('subprocess 先建箱时，根取 cwd；之后 shell 带权威根仍会另建一个（信息更准，理应分开）', async () => {
    const { manager, backend } = makeManager()

    await manager.boxFor({ cwd: elsewhere, mode: 'workspace-write' })
    assert.equal(backend.specs.length, 1)

    // elsewhere 不在 workspace 之下，所以这是两个不同的世界
    await manager.boxFor({
      cwd: elsewhere,
      workspaceRoot: workspace,
      sessionId: 's2',
      mode: 'workspace-write',
    })
    assert.equal(backend.specs.length, 2)
    assert.notEqual(backend.specs[0]?.workspaceRoot, backend.specs[1]?.workspaceRoot)
  })

  it('同一会话内重复请求只建一个箱', async () => {
    const { manager, backend } = makeManager()
    for (let i = 0; i < 5; i += 1) {
      await manager.boxFor({ cwd: nested, workspaceRoot: workspace, mode: 'workspace-write' })
    }
    assert.equal(backend.specs.length, 1)
  })

  it('worldOf() 让"会不会共用同一个箱"变成可断言的', async () => {
    const { manager } = makeManager()
    // 先由 shell 挂载出这个世界——继承规则只对**已挂载过**的根生效，
    // 否则任何两个目录都会"恰好"共用箱子，那是猜而不是收敛。
    await manager.boxFor({
      cwd: nested,
      workspaceRoot: workspace,
      mode: 'workspace-write',
    })
    const a = await manager.worldOf({ cwd: nested, workspaceRoot: workspace })
    const b = await manager.worldOf({ cwd: join(workspace, 'sub') })
    assert.equal(a, b, '同一工作区下的不同子目录必须解析到同一个世界')
    assert.equal(
      await manager.worldOf({ cwd: nested, workspaceRoot: undefined }),
      await canonicalWorldRoot(workspace),
    )
  })

  it('规范化让 /repo 与 /repo/. 收敛到同一个世界', async () => {
    const { manager, backend } = makeManager()
    const dotted = `${workspace}/.`
    const first = await manager.boxFor({ cwd: workspace, workspaceRoot: workspace, mode: 'workspace-write' })
    const second = await manager.boxFor({ cwd: dotted, workspaceRoot: dotted, mode: 'workspace-write' })
    assert.equal(first.id, second.id)
    assert.equal(backend.specs.length, 1)
  })
})

describe('释放', () => {
  it('按世界根或会话标识都能释放', async () => {
    const { manager } = makeManager()
    const box = await manager.boxFor({
      cwd: nested,
      workspaceRoot: workspace,
      sessionId: 's3',
      mode: 'workspace-write',
    })
    assert.equal(await manager.release('s3'), true)
    assert.equal(manager.list().length, 0)
    assert.equal(await manager.release('s3'), false, '重复释放是幂等的')
    assert.ok(box.id.length > 0)
  })

  it('releaseAll 清空箱与已知世界', async () => {
    const { manager } = makeManager()
    await manager.boxFor({ cwd: workspace, workspaceRoot: workspace, mode: 'workspace-write' })
    assert.equal(manager.worlds().length, 1)
    await manager.releaseAll()
    assert.equal(manager.list().length, 0)
    assert.equal(manager.worlds().length, 0, '已知世界也要清掉，否则下一个会话会继承上一个的根')
  })
})
