/**
 * M0 验收门禁。
 *
 * 它把提案里那句"跑通最小插件加载"变成 CI 里可复现的断言。三件事必须成立，
 * 缺一件就说明地基不成立：
 *
 * 1. 插件能加载进**真实 Cordis 上下文**，并以 `ctx.runbox` 暴露服务；
 *    （不是 mock——官方测试策略里也写着"优先使用真实实现而非 mock"。）
 * 2. 服务是可逆的：宿主卸载时不留残余注册；
 * 3. 后端选择是 **fail-closed** 的：没有任何可用后端时抛错，绝不返回
 *    "那就别隔离了"。
 *
 * @module @dsh-runbox/conformance/gate.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { DockerBackend } from '@dsh-runbox/backend-docker'
import {
  BackendUnavailableError,
  BackendRegistry,
  type BoxBackend,
  type BoxHandle,
} from '@dsh-runbox/core'
import * as corePlugin from '@dsh-runbox/core'

/** 一个只用于测试的最小后端：`probe` 结果可控。 */
function stubBackend(name: string, available: boolean): BoxBackend {
  return {
    name,
    probe: () => Promise.resolve(available),
    create: () => Promise.reject(new Error('unused')),
    exec: () => Promise.reject(new Error('unused')),
    stop: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    list: (): Promise<BoxHandle[]> => Promise.resolve([]),
  }
}

describe('M0 门禁：插件加载', () => {
  it('加载进真实 Cordis 上下文后，ctx.runbox 可用', async () => {
    const ctx = new Context()
    // ctx.plugin() 返回 Fiber & PromiseLike<Fiber>——必须 await，否则 apply 还没跑完。
    await ctx.plugin(corePlugin)
    assert.ok(ctx.runbox, 'ctx.runbox 应当由 apply() 注册')
    assert.deepEqual(ctx.runbox.backends.list(), [])
  })

  it('注册后端后可从服务里看到，注销后消失（注册即可逆）', async () => {
    const ctx = new Context()
    await ctx.plugin(corePlugin)
    const dispose = ctx.runbox.use(stubBackend('stub', true))
    assert.deepEqual(ctx.runbox.backends.list(), ['stub'])
    dispose()
    assert.deepEqual(ctx.runbox.backends.list(), [])
  })
})

describe('M0 门禁：fail-closed', () => {
  it('注册表为空时 select() 抛 BackendUnavailableError', async () => {
    const registry = new BackendRegistry()
    await assert.rejects(() => registry.select(), BackendUnavailableError)
  })

  it('所有后端探测失败时 select() 抛错，而不是返回某个后端', async () => {
    const registry = new BackendRegistry()
    registry.register(stubBackend('down-a', false))
    registry.register(stubBackend('down-b', false))
    await assert.rejects(
      () => registry.select(),
      (error: unknown) => {
        assert.ok(error instanceof BackendUnavailableError)
        assert.equal(error.code, 'SANDBOX_UNAVAILABLE')
        assert.match(error.message, /all backends failed probe/)
        return true
      },
    )
  })

  it('探测抛异常的后端不会被静默选中', async () => {
    const registry = new BackendRegistry()
    registry.register({
      ...stubBackend('explodes', true),
      probe: () => Promise.reject(new Error('boom')),
    })
    registry.register(stubBackend('healthy', true))
    const chosen = await registry.select()
    assert.equal(chosen.name, 'healthy')
  })

  it('同名后端重复注册会抛错，避免"到底在用哪个"不可知', () => {
    const registry = new BackendRegistry()
    registry.register(stubBackend('dup', true))
    assert.throws(() => registry.register(stubBackend('dup', true)), /already registered/)
  })
})

describe('M0 门禁：Docker 后端探测契约', () => {
  it('未命中真实 Docker 时 probe() 返回 false 而非抛错', async () => {
    const backend = new DockerBackend(
      { kind: 'socket', socketPath: '/nonexistent/no-docker.sock' },
      800,
    )
    assert.equal(await backend.probe(), false)
  })

  it('未实现的能力响亮失败，而不是静默空转', async () => {
    const backend = new DockerBackend({ kind: 'socket', socketPath: '/nonexistent/x.sock' }, 500)
    await assert.rejects(
      () => backend.create({} as never),
      /not implemented yet \(planned milestone: M1\)/,
    )
  })
})
