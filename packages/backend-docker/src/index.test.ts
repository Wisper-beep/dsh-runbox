/**
 * 引擎端点解析与探测的单测。
 *
 * 探测这两个函数而不是别处，因为 `probe()` 是 fail-closed 的入口：端点解析错了，
 * 后端会"看不见"本机明明在跑的 Docker，于是整条链路拒绝执行——安全但不可用。
 *
 * 这些测试**不要求本机装了 Docker**：探测失败路径同样是必须正确的路径。
 *
 * @module @dsh-runbox/backend-docker/index.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { pingEngine, resolveEngineEndpoint } from './index.ts'

describe('resolveEngineEndpoint', () => {
  it('DOCKER_HOST=npipe 解析成 Windows 命名管道路径', () => {
    const e = resolveEngineEndpoint({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' })
    assert.equal(e.kind, 'socket')
    assert.equal(e.socketPath, '//./pipe/docker_engine')
  })

  it('DOCKER_HOST=unix 解析成 socket 路径', () => {
    const e = resolveEngineEndpoint({ DOCKER_HOST: 'unix:///var/run/docker.sock' })
    assert.equal(e.kind, 'socket')
    assert.equal(e.socketPath, '/var/run/docker.sock')
  })

  it('DOCKER_HOST=tcp 解析出 host 与 port', () => {
    const e = resolveEngineEndpoint({ DOCKER_HOST: 'tcp://10.0.0.5:2376' })
    assert.equal(e.kind, 'tcp')
    assert.equal(e.host, '10.0.0.5')
    assert.equal(e.port, 2376)
  })

  it('tcp 缺端口时回落到 2375', () => {
    const e = resolveEngineEndpoint({ DOCKER_HOST: 'tcp://10.0.0.5' })
    assert.equal(e.port, 2375)
  })

  it('没有 DOCKER_HOST 时给出平台默认端点', () => {
    const e = resolveEngineEndpoint({})
    assert.equal(e.kind, 'socket')
    assert.ok(e.socketPath && e.socketPath.length > 0)
  })
})

describe('pingEngine', () => {
  it('端点不存在时返回 ok:false 而不是抛错', async () => {
    const result = await pingEngine(
      { kind: 'socket', socketPath: '/nonexistent/definitely-not-a-docker.sock' },
      1000,
    )
    assert.equal(result.ok, false)
    assert.ok(result.detail.length > 0, '失败必须带可读原因')
  })

  it('探测失败不影响 process 存活（不产生未捕获异常）', async () => {
    const result = await pingEngine({ kind: 'tcp', host: '127.0.0.1', port: 1 }, 1000)
    assert.equal(result.ok, false)
  })
})
