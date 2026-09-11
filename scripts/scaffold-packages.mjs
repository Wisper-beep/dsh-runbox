#!/usr/bin/env node
/**
 * 生成尚未落地的包的骨架（package.json / tsconfig.json / src/index.ts）。
 *
 * 特点：**幂等且非破坏性**——只创建不存在的文件，绝不覆盖已有实现。
 * 因此它可以在每次加包时重复运行，也不会踩到已经手写好的代码。
 *
 * 用法：
 *   node scripts/scaffold-packages.mjs          # 补齐缺失文件
 *   node scripts/scaffold-packages.mjs --dry    # 只打印将创建的文件
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry')

const SEAM_VERSION = {
  '@deepseek-ai/dsh-subprocess': '0.0.1-rc.1',
  '@deepseek-ai/dsh-fs': '0.0.1-rc.1',
  '@deepseek-ai/dsh-jobs': '0.0.1-rc.3',
  '@deepseek-ai/dsh-terminal': '0.0.1-rc.3',
  '@deepseek-ai/dsh-sandbox-policy': '0.0.1-rc.1',
}

/**
 * 占位包清单。每个包在 M0 只确立位置与契约归属，实现留给对应里程碑。
 * `seam` 是它将来要接管的官方 ctx 键，写进占位文件里作为自文档。
 */
const PACKAGES = [
  {
    dir: 'provider-subprocess',
    name: '@dsh-runbox/provider-subprocess',
    seam: 'ctx.subprocess',
    seamPkg: '@deepseek-ai/dsh-subprocess',
    milestone: 'M1',
    summary: '让 dsh 的每次进程 spawn 落在容器里，而不是宿主上',
    description:
      'Container-backed implementation of the ctx.subprocess capability seam for DeepSeek Harness.',
    keywords: ['dsh-plugin', 'deepseek-harness', 'dsh', 'subprocess', 'container'],
  },
  {
    dir: 'provider-fs',
    name: '@dsh-runbox/provider-fs',
    seam: 'ctx.fs',
    seamPkg: '@deepseek-ai/dsh-fs',
    milestone: 'M2',
    summary: '把文件读写落在箱的工作区挂载上，并诚实上报强制执行度',
    description:
      'Container-backed implementation of the ctx.fs capability seam for DeepSeek Harness.',
    keywords: ['dsh-plugin', 'deepseek-harness', 'dsh', 'filesystem', 'container'],
  },
  {
    dir: 'provider-jobs',
    name: '@dsh-runbox/provider-jobs',
    seam: 'ctx.jobs',
    seamPkg: '@deepseek-ai/dsh-jobs',
    milestone: 'M3',
    summary: '后台任务在箱内登记，箱销毁时不留孤儿进程',
    description:
      'Container-backed implementation of the ctx.jobs capability seam for DeepSeek Harness.',
    keywords: ['dsh-plugin', 'deepseek-harness', 'dsh', 'jobs', 'container'],
  },
  {
    dir: 'provider-terminal',
    name: '@dsh-runbox/provider-terminal',
    seam: 'ctx.terminals',
    seamPkg: '@deepseek-ai/dsh-terminal',
    milestone: 'M3',
    summary: '箱内的持久 PTY（官方契约是注册后端，不是替换服务）',
    description:
      'Container-backed terminal backend for the ctx.terminals seam of DeepSeek Harness.',
    keywords: ['dsh-plugin', 'deepseek-harness', 'dsh', 'terminal', 'pty', 'container'],
  },
  {
    dir: 'sandbox-bridge',
    name: '@dsh-runbox/sandbox-bridge',
    seam: 'ctx.sandboxPolicy（只消费）',
    seamPkg: '@deepseek-ai/dsh-sandbox-policy',
    milestone: 'M2',
    summary: '把逐调用沙箱模式翻译成箱的围栏配置，并把强制执行度上报给上层',
    description:
      'Translation layer between the dsh sandbox policy and dsh-runbox box confinement.',
    keywords: ['dsh-plugin', 'deepseek-harness', 'dsh', 'sandbox', 'policy'],
  },
  {
    dir: 'ui',
    name: '@dsh-runbox/ui',
    seam: 'web client（sidebar / settings / conversation node）',
    seamPkg: null,
    milestone: 'M4',
    summary: '设置卡（镜像 / 资源 / 网络）、箱状态面板、执行审计时间线',
    description: 'Web client plugin for dsh-runbox: settings card, box status, audit timeline.',
    keywords: ['dsh-plugin', 'deepseek-harness', 'dsh', 'ui', 'web'],
  },
]

function pkgJson(p) {
  const out = {
    name: p.name,
    version: '0.0.0',
    type: 'module',
    description: p.description,
    license: 'MIT',
    keywords: p.keywords,
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    files: ['dist'],
  }
  if (p.seamPkg) {
    out.dependencies = { [p.seamPkg]: SEAM_VERSION[p.seamPkg], '@dsh-runbox/core': '0.0.0' }
  } else {
    out.dependencies = { '@dsh-runbox/core': '0.0.0' }
  }
  out.peerDependencies = { '@deepseek-ai/cordis': '^4.0.2' }
  out.devDependencies = { '@deepseek-ai/cordis': '^4.0.2' }
  return `${JSON.stringify(out, null, 2)}\n`
}

const TSCONFIG = `${JSON.stringify(
  {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      rootDir: 'src',
      outDir: 'dist',
      tsBuildInfoFile: 'dist/.tsbuildinfo',
    },
    include: ['src/**/*.ts'],
  },
  null,
  2,
)}\n`

function indexTs(p) {
  const seamLine = p.seamPkg
    ? ` * 将来接管：\`${p.seam}\`（官方 seam 包 \`${p.seamPkg}\`）\n`
    : ` * 将来接管：${p.seam}\n`
  return `/**
 * ${p.name}
 *
 * ${p.summary}。
 *
${seamLine} * 当前状态：**M0 占位**，实现排在 ${p.milestone}。
 *
 * 这里刻意不假装可用：被调用时抛 \`RunboxNotImplementedError\`。一个"什么都不做
 * 也不报错"的 provider，比一个报错的 provider 危险得多——上层会以为自己被隔离了。
 *
 * @module ${p.name}
 */

import { RunboxNotImplementedError, type RunboxService } from '@dsh-runbox/core'
import type { Context } from '@deepseek-ai/cordis'

/** 插件名。 */
export const name = '${p.name}'

/** 依赖的 ctx 服务：执行地基。 */
export const inject = ['runbox'] as const

/** 本包在 M0 的定位说明，供 host 启动日志与插件市场展示。 */
export const summary = '${p.summary}'

/** 计划落地的里程碑。 */
export const milestone = '${p.milestone}'

/**
 * Cordis 插件入口。
 * @param ctx - 所属上下文，ctx.runbox 已由 @dsh-runbox/core 提供。
 * @throws RunboxNotImplementedError - 实现尚未落地（${p.milestone}）。
 */
export function apply(_ctx: Context & { runbox: RunboxService }): never {
  throw new RunboxNotImplementedError('${p.seam}', '${p.milestone}')
}
`
}

let created = 0
let skipped = 0
for (const p of PACKAGES) {
  const dir = join(ROOT, 'packages', p.dir)
  const files = [
    ['package.json', pkgJson(p)],
    ['tsconfig.json', TSCONFIG],
    ['src/index.ts', indexTs(p)],
  ]
  for (const [rel, content] of files) {
    const target = join(dir, rel)
    if (existsSync(target)) {
      skipped += 1
      continue
    }
    if (DRY) {
      console.log(`would create ${target}`)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
    created += 1
    console.log(`created ${target}`)
  }
}
console.log(`\n${DRY ? '(dry run) ' : ''}created=${created} skipped(existing)=${skipped}`)
