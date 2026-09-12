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
  effectiveTmpfsPaths,
  isAtOrUnder,
  parseDockerHost,
  pingEndpoint,
  selectEndpoint,
} from './index.ts'
import { LABELS } from './engine.ts'
import { encodeFrame, linuxEngineSkipReason } from './test-helpers.ts'

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

describe('tmpfs 与工作区的重叠判定', () => {
  it('路径前缀相同但不是子路径时不算包含', () => {
    assert.equal(isAtOrUnder('/tmp', '/tmp-other'), false)
    assert.equal(isAtOrUnder('/tmp', '/tmp'), true)
    assert.equal(isAtOrUnder('/tmp', '/tmp/x'), true)
  })

  it('工作区在 /tmp 下时，/tmp 的 tmpfs 必须被剔除——否则会把工作区盖住', () => {
    // 这是 CI 抓出来的真实缺陷：宿主临时目录就在 /tmp 下，
    // tmpfs 后挂会遮盖 bind mount，且不报任何错。
    assert.deepEqual(effectiveTmpfsPaths(['/tmp', '/run'], '/tmp/runbox-it-abc'), ['/run'])
  })

  it('工作区在别处时两个 tmpfs 都保留', () => {
    assert.deepEqual(effectiveTmpfsPaths(['/tmp', '/run'], '/home/u/repo'), ['/tmp', '/run'])
  })

  it('工作区恰好等于 /tmp 时同样剔除', () => {
    assert.deepEqual(effectiveTmpfsPaths(['/tmp', '/run'], '/tmp'), ['/run'])
  })

  it('工作区是根时全部剔除：任何 tmpfs 都会遮住工作区的某个子目录', () => {
    assert.deepEqual(effectiveTmpfsPaths(['/tmp', '/run'], '/'), [])
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

// —— 集成层：以下用例需要真实 **Linux 容器**引擎 ——

const dockerSkip = await linuxEngineSkipReason()

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

      // 工作区是挂载进来的：写进去的文件宿主上也该看到。
      // 这里必须断言退出码——否则写入失败会表现成"宿主上没这个文件"，
      // 而真正的原因藏在没人看的 stderr 里（CI 上就是这么绕了一圈）。
      const write = await backend.exec(box, {
        argv: ['bash', '-c', `echo mounted > ${hostDir}/mounted.txt`],
        cwd: hostDir,
      })
      assert.equal(write.exitCode, 0, `工作区写入失败：${write.stderr}`)
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

  it('流式执行边产生边交付，退出码可读', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-stream-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-stream', hostDir))
      const stream = await backend.startExec(box, {
        argv: ['bash', '-c', 'echo first; echo second; echo oops >&2; exit 7'],
        cwd: hostDir,
      })
      let stdout = ''
      let stderr = ''
      stream.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      stream.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })
      const outcome = await stream.done
      assert.equal(outcome.exitCode, 7)
      assert.match(stdout, /first[\s\S]*second/)
      assert.match(stderr, /oops/)
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('terminate 按进程树终止：逃逸的孙进程留不下痕迹', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-kill-'))
    const marker = join(hostDir, 'survived.txt')
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-kill', hostDir))
      // 两层进程，并且**让进程树自己留下证据**：若没被真正终止，
      // sleep 结束后会写出 survived.txt。
      //
      // 刻意不用 `pgrep -f` 判定存活：`pgrep -f "sleep 120"` 会匹配到运行它
      // 自己的那个 bash（命令行里就含这串字），于是永远报 alive。判定"进程还在
      // 不在"必须用行为证据，不能用模式匹配。
      const stream = await backend.startExec(box, {
        argv: ['bash', '-c', `sleep 4; echo survived > ${marker}`],
        cwd: hostDir,
      })
      // 等到包装脚本把 pid 写出来再终止。固定 sleep 在负载高的 runner 上会偶发
      // 失败（CI 上真的出现过两次运行结果不同）。这里确定性等待，是因为要测的是
      // "终止能做到"，而不是"终止能容忍进程还没起来"。
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = await backend.exec(box, {
          argv: ['bash', '-c', 'ls /runbox/*.pid 2>/dev/null | head -1'],
          cwd: hostDir,
        })
        if (probe.stdout.trim().length > 0) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      stream.terminate()
      const exited = await Promise.race([
        stream.waitForExit().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
      ])
      assert.equal(exited, true, 'terminate 之后进程应当停下来')
      // 等到原命令本该写出文件的时间点之后，确认它从未发生。
      await new Promise((resolve) => setTimeout(resolve, 5000))
      assert.equal(
        existsSync(marker),
        false,
        '进程树没被真正终止——逃逸的进程写出了 survived.txt',
      )
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('交互式 stdin：边写边读，end() 即半关闭', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-stdin-pipe-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-stdin-pipe', hostDir))
      const stream = await backend.startExec(box, {
        argv: ['bash', '-c', 'cat'],
        cwd: hostDir,
        stdin: 'pipe',
      })
      assert.ok(stream.stdin, "请求 stdin: 'pipe' 时必须给出可写流")
      let stdout = ''
      stream.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      stream.stdin?.write('line-one\n')
      stream.stdin?.write('line-two\n')
      stream.stdin?.end()
      await stream.done
      assert.match(stdout, /line-one/)
      assert.match(stdout, /line-two/, '两行都写到了才算真的双向通了')
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('批式 exec 明确拒绝 stdin: pipe——静默忽略会让调用方以为在交互', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-stdin-reject-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-stdin-reject', hostDir))
      await assert.rejects(
        () =>
          backend.exec(box as BoxHandle, {
            argv: ['bash', '-c', 'cat'],
            cwd: hostDir,
            stdin: 'pipe',
          }),
        /use startExec/
      )
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('批式 stdin 被如实喂给命令', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-stdin-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-stdin', hostDir))
      const stream = await backend.startExec(box, {
        argv: ['bash', '-c', 'cat'],
        cwd: hostDir,
        stdin: { data: 'fed-through-stdin\n' },
      })
      let stdout = ''
      stream.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      await stream.done
      assert.match(stdout, /fed-through-stdin/)
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })
  it('终端（pty）：交互式输入有回显，尺寸被接受', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-term-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-term', hostDir))
      const term = await backend.startTerminal(box, {
        argv: ['bash', '-i'],
        cwd: hostDir,
        rows: 24,
        cols: 100,
      })
      assert.ok(term.pid > 0, '终端必须报告顶层进程 pid')
      let out = ''
      term.output.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      await term.write('echo terminal-ok\n')
      await term.write('exit\n')
      await term.done
      assert.match(out, /terminal-ok/, 'pty 里敲的命令应当有回显与输出')
    } finally {
      if (box) {
        await backend.remove(box)
      }
      rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('终端前台信息如实报告「无法证明在等输入」', async () => {
    const backend = new DockerBackend({ image })
    const hostDir = mkdtempSync(join(tmpdir(), 'runbox-term-fg-'))
    let box: BoxHandle | undefined
    try {
      box = await backend.create(makeSpec('it-term-fg', hostDir))
      const term = await backend.startTerminal(box, {
        argv: ['bash', '-i'],
        cwd: hostDir,
        rows: 24,
        cols: 80,
      })
      const foreground = await term.inspectForeground()
      assert.ok(foreground, '应当给出前台进程组')
      assert.equal(foreground.processGroupId, term.pid)
      // 关键：我们**没有**能力证明它正阻塞在终端输入上，因此必须报 false。
      // 报 true 是撒谎，会让上层的"卡住了"判定给出错误结论。
      assert.equal(foreground.inputWaiting, false)
      await term.terminate()
      await term.done
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
