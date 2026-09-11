/**
 * 引擎客户端与真实箱的测试。
 *
 * 分两层：
 * - **纯函数层**：端点解析、多路复用流拆分、容器名清洗。这些不依赖 Docker，
 *   在 CI 上必定运行。
 * - **集成层**：真的建一个容器、真的在里面跑命令、真的验证宿主上没有副作用。
 *   引擎不可用时整组**跳过**而不是失败——CI 上没有 Docker 守护进程是常态，
 *   把"环境不具备"报成"代码坏了"只会训练大家忽略红灯。
 *
 * @module @dsh-runbox/backend-docker/index.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { confinementFor, type BoxHandle, type BoxSpec } from '@dsh-runbox/core'

import {
  candidateEndpoints,
  containerName,
  demuxStream,
  DockerBackend,
  parseDockerHost,
  pingEndpoint,
  selectEndpoint,
} from './index.ts'
import { LABELS } from './engine.ts'
import { encodeFrame } from './test-helpers.ts'

describe('端点解析', () => {
  it('DOCKER_HOST=npipe 解析成命名管道路径', () => {
    assert.deepEqual(parseDockerHost('npipe:////./pipe/dockerDesktopLinuxEngine'), {
      kind: 'socket',
      socketPath: '//./pipe/dockerDesktopLinuxEngine',
    })
  })

  it('DOCKER_HOST=unix 解析成 socket 路径', () => {
    assert.deepEqual(parseDockerHost('unix:///var/run/docker.sock'), {
      kind: 'socket',
      socketPath: '/var/run/docker.sock',
    })
  })

  it('DOCKER_HOST=tcp 解析出 host 与 port', () => {
    assert.deepEqual(parseDockerHost('tcp://10.0.0.5:2376'), {
      kind: 'tcp',
      host: '10.0.0.5',
      port: 2376,
    })
  })

  it('tcp 缺端口时回落到 2375', () => {
    assert.equal(parseDockerHost('tcp://10.0.0.5')?.kind, 'tcp')
    const parsed = parseDockerHost('tcp://10.0.0.5')
    assert.ok(parsed && parsed.kind === 'tcp' && parsed.port === 2375)
  })

  it('无法识别的 DOCKER_HOST 返回 undefined，交由平台默认接管', () => {
    assert.equal(parseDockerHost('weird://whatever'), undefined)
  })

  it('平台默认端点给出多个候选（Docker Desktop 的管道名随版本变过）', () => {
    const candidates = candidateEndpoints({})
    assert.ok(candidates.length >= 1, '至少要有一个候选端点')
    for (const candidate of candidates) {
      assert.ok(candidate.kind === 'socket' || candidate.kind === 'tcp')
    }
  })
})

describe('多路复用流拆分', () => {
  it('按帧拆出 stdout 与 stderr', () => {
    const buffer = Buffer.concat([
      encodeFrame(1, 'out-1\n'),
      encodeFrame(2, 'err-1\n'),
      encodeFrame(1, 'out-2\n'),
    ])
    assert.deepEqual(demuxStream(buffer), { stdout: 'out-1\nout-2\n', stderr: 'err-1\n' })
  })

  it('多字节字符跨帧边界不会被截断', () => {
    const buffer = Buffer.concat([encodeFrame(1, '中文'), encodeFrame(1, '测试')])
    assert.deepEqual(demuxStream(buffer).stdout, '中文测试')
  })

  it('尾部残缺帧被忽略而不是抛错', () => {
    const whole = encodeFrame(1, 'complete')
    const truncated = whole.subarray(0, whole.length - 3)
    assert.equal(demuxStream(Buffer.concat([whole, truncated])).stdout, 'complete')
  })

  it('空输入返回空串', () => {
    assert.deepEqual(demuxStream(Buffer.alloc(0)), { stdout: '', stderr: '' })
  })
})

describe('容器名清洗', () => {
  it('非法字符被替换，且不以非字母数字开头', () => {
    assert.equal(containerName('会话/abc 123'), 'dsh-runbox-abc-123')
  })

  it('超长会话 id 被截断', () => {
    assert.ok(containerName('x'.repeat(200)).length <= 64)
  })

  it('全非法字符时有兜底名', () => {
    assert.equal(containerName('中文'), 'dsh-runbox-session')
  })
})

describe('探测失败路径', () => {
  it('端点不存在时返回 ok:false 而不是抛错', async () => {
    const result = await pingEndpoint(
      { kind: 'socket', socketPath: '/nonexistent/definitely-not-docker.sock' },
      800,
    )
    assert.equal(result.ok, false)
    assert.ok(result.detail.length > 0)
  })

  it('全部候选都不可用时报出逐个失败原因', async () => {
    const { endpoint, tried } = await selectEndpoint(
      [
        { kind: 'socket', socketPath: '/nonexistent/a.sock' },
        { kind: 'tcp', host: '127.0.0.1', port: 1 },
      ],
      800,
    )
    assert.equal(endpoint, undefined)
    assert.equal(tried.length, 2)
  })
})

// —— 集成层：以下用例需要真实 Docker 守护进程 ——

const engineProbe = await selectEndpoint(candidateEndpoints(), 1200)
const dockerSkip =
  engineProbe.endpoint === undefined ? 'docker engine unavailable' : false

describe('集成：真实容器', { skip: dockerSkip }, () => {
  const image = process.env['DSH_RUNBOX_TEST_IMAGE'] ?? 'bash:5.2'

  const makeSpec = (sessionId: string, workspaceRoot: string): BoxSpec => ({
    sessionId,
    workspaceRoot,
    workspaceMountPath: workspaceRoot,
    image,
    network: 'none',
    limits: { cpus: 1, memoryBytes: 256 * 1024 * 1024, pidsLimit: 128 },
    confinement: confinementFor('workspace-write'),
  })

  it('命令真的跑在容器里，且宿主上没有副作用', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-it-'))
    const marker = `inside-${Date.now()}.txt`
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-basic', hostDir))

      const hello = await backend.exec(box, {
        argv: ['bash', '-c', 'echo hello-from-box; uname -s'],
        cwd: hostDir,
      })
      assert.equal(hello.exitCode, 0, `stderr=${hello.stderr}`)
      assert.match(hello.stdout, /hello-from-box/)
      assert.ok(hello.stdout.includes('Linux'), '箱内应当是 Linux，与宿主平台解耦')

      // 工作区是挂载进来的：写进去的文件宿主上也该看到
      await backend.exec(box, { argv: ['bash', '-c', `echo mounted > ${hostDir}/mounted.txt`], cwd: hostDir })
      assert.ok(existsSync(join(hostDir, 'mounted.txt')), '工作区挂载应当双向可见')

      // 箱内 /tmp 是 tmpfs：写进去的东西不该出现在宿主上
      await backend.exec(box, { argv: ['bash', '-c', `echo secret > /tmp/${marker}`], cwd: hostDir })
      assert.equal(existsSync(join(tmpdir(), marker)), false, '宿主 /tmp 不该被箱内写入污染')
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('只读 rootfs 真的拒绝写入——隔离不是装饰', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-ro-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create({
        ...makeSpec('it-readonly', hostDir),
        confinement: confinementFor('read-only'),
      })
      const denied = await backend.exec(box, {
        argv: ['bash', '-c', 'echo blocked > /etc/blocked.txt'],
        cwd: hostDir,
      })
      assert.notEqual(denied.exitCode, 0, '只读 rootfs 下写系统路径必须失败')
      assert.match(denied.stderr, /read-only|Read-only|Permission denied/i)
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('退出码如实透传', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-code-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-exit', hostDir))
      const result = await backend.exec(box, { argv: ['bash', '-c', 'exit 42'], cwd: hostDir })
      assert.equal(result.exitCode, 42)
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('list() 按标签找到自己的箱，remove() 后消失', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-list-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-list', hostDir))
      const found = await backend.list()
      assert.ok(
        found.some((b) => b.id === box?.id),
        '刚建的箱必须能被 list 找到，否则孤儿回收无从谈起',
      )
      await backend.remove(box)
      box = undefined
      const after = await backend.list()
      assert.equal(
        after.some((b) => b.sessionId === 'it-list'),
        false,
      )
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('超时被如实上报', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-timeout-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-timeout', hostDir))
      const result = await backend.exec(box, {
        argv: ['bash', '-c', 'sleep 30'],
        cwd: hostDir,
        timeoutMs: 1500,
      })
      assert.equal(result.timedOut, true)
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })
})

describe('标签契约', () => {
  it('回收依据是标签而不是容器名', () => {
    assert.equal(LABELS.managed, 'dsh.runbox.managed')
    assert.equal(LABELS.session, 'dsh.runbox.session')
  })
})
