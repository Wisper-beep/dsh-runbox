/**
 * `@dsh-runbox/provider-fs` —— 箱工作区的文件能力。
 *
 * 继承官方 `FileSystem`，加载即注册为 `ctx.fs`。
 *
 * ## 两个关键设计判断
 *
 * **一、读取直连宿主，变更在进程内按策略围栏。**
 *
 * 这与官方 `fs-sandbox` 同构——它的语义正是"按共享沙箱模式**限制变更**"，读取
 * 不受限。理由：变更的权威判定必须是模式与工作区边界，而这两样 `ctx.sandboxPolicy`
 * 已经逐调用给全了；把它再绕一圈送进容器，只会换来延迟与 argv 长度限制，并不会
 * 让围栏更真。
 *
 * 容器侧的只读挂载并没有白设：它是**进程侧的纵深防御**——`bash` 越不出工作区。
 * 两层各管一条路径，语义一致（同一模式同时决定挂载标志与这里的判定）。
 *
 * **二、`processPath()` 返回箱内路径，而不是宿主路径。**
 *
 * 官方明写 `fileUrl()` 的注释：「宿主平台可能与执行平台不同」。我们正好是这种
 * 情况——Windows 宿主 `E:\repo\a.txt` 在 Linux 箱里是 `/e/repo/a.txt`。交给子进程
 * 去 open 的必须是后者，否则那条路径在箱里根本不存在。
 *
 * @module @dsh-runbox/provider-fs
 */

import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'

import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
// 空类型导入：官方用模块增强声明 ctx.sandboxPolicy，必须加载该模块才能生效。
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Context } from '@deepseek-ai/cordis'

import { hostPlatform, isAtOrUnder, toBoxPath } from '@dsh-runbox/core'

/** 插件名。 */
export const name = '@dsh-runbox/provider-fs'

/** 依赖的 ctx 服务：无（`ctx.sandboxPolicy` 是可选消费，缺省时用安全默认值）。 */
export const inject: string[] = []

/** 本 provider 默认施加的沙箱模式。 */
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write'

/** 读取全文的大小上限，超过则要求走 `streamText`。 */
export const MAX_READ_BYTES = 32 * 1024 * 1024

/**
 * 判断一段字节是否是"文本"。
 *
 * 契约要求二进制由后端拒绝、策略层永远不碰原始字节，因此这里必须在解码前判一次：
 * 先看有没有 NUL（二进制的最强信号），再用**严格**解码验证 UTF-8 —— `toString('utf8')`
 * 会把非法字节悄悄替换成 U+FFFD，那样"拒绝二进制"就变成了"悄悄损坏二进制"。
 *
 * @param buffer - 原始字节。
 * @returns 是合法 UTF-8 文本时返回解码结果，否则返回 `undefined`。
 */
export function decodeText(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) {
    return undefined
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return undefined
  }
}

/** 文件的主要换行风格。 */
export type Eol = '\n' | '\r\n'

/**
 * 探测文件的主导换行风格。
 *
 * 变更时必须在**写回之前**还原它，否则一次小改动会把整个文件的换行风格翻掉——
 * 那是 diff 灾难，而且用户不会预期编辑器之外的组件干这事。
 */
export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** 统一换行到 LF，用于匹配与 diff 基准。 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** 把 LF 文本还原成指定的换行风格。 */
export function fromLf(text: string, eol: Eol): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/**
 * 计算不透明的新鲜度令牌。
 *
 * 用 mtime + size 而不是内容哈希：`stat()` 每次调用都要产生它，内容哈希会把
 * 目录列举变成全量读盘。代价是同一毫秒内等长的改写可能撞版本——对这个用途
 * （防止基于陈旧内容的覆盖）可接受，且换来的是 O(1)。
 */
export function versionOf(mtimeMs: number, size: number): FsVersion {
  return FsVersion(`${mtimeMs.toString(36)}:${size.toString(36)}`)
}

/** 当前调用应当施加的模式。`danger-full-access` 收窄为本 provider 的默认模式。 */
export function effectiveMode(policy: SandboxExecutionPolicy | undefined): SandboxMode {
  if (!policy || policy.mode === 'danger-full-access') {
    return DEFAULT_SANDBOX_MODE
  }
  return policy.mode
}

/**
 * 箱工作区的文件系统。
 */
export class RunboxFileSystem extends FileSystem {
  private readonly platform = hostPlatform()
  /** 规范化的工作区根缓存：策略给的根未必是规范路径（见 canonicalRoot）。 */
  private readonly rootCache = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx)
    this.ctx.logger?.debug?.('runbox filesystem ready (host platform: %s)', this.platform)
  }

  /** 本后端默认强制的模式。 */
  override get sandboxMode(): SandboxMode | undefined {
    return DEFAULT_SANDBOX_MODE
  }

  /**
   * 解析路径为稳定目标。
   *
   * 会跟随符号链接（`realpath`）——因此同一文件经不同别名到达时得到同一个
   * `targetKey`，这正是契约要求的"身份不因别名改变"。
   */
  override async resolve(
    path: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    const absolute = resolvePath(opts?.cwd ?? process.cwd(), path)
    const canonical = await this.canonicalize(absolute)
    return { targetKey: FsTargetKey(canonical), displayPath: canonical }
  }

  /** 箱内可打开的规范路径——与宿主路径不同（Windows 宿主需要盘符映射）。 */
  override processPath(target: FsTarget): string {
    return toBoxPath(target.displayPath, this.platform)
  }

  /** 箱内视角的 `file:` URI。 */
  override fileUrl(target: FsTarget): string {
    const boxPath = this.processPath(target)
    return `file://${boxPath.split('/').map(encodeURIComponent).join('/')}`
  }

  /** 词法包含判断；两个目标必须来自本 provider。 */
  override contains(parent: FsTarget, child: FsTarget): boolean {
    return isAtOrUnder(parent.displayPath, child.displayPath)
  }

  /** 目标元数据；不存在返回 `undefined`。 */
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    try {
      const info = await stat(target.displayPath)
      const type = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
      return {
        version: versionOf(info.mtimeMs, info.size),
        type,
        size: info.size,
      }
    } catch (error) {
      if (this.absent(error)) {
        return undefined
      }
      throw this.io(error)
    }
  }

  /** 不跟随末段符号链接的路径元数据。 */
  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    signal?.throwIfAborted()
    const absolute = resolvePath(opts?.cwd ?? process.cwd(), path)
    try {
      const info = await lstat(absolute)
      const type = info.isSymbolicLink()
        ? 'symlink'
        : info.isFile()
          ? 'file'
          : info.isDirectory()
            ? 'directory'
            : 'other'
      return { version: versionOf(info.mtimeMs, info.size), type, size: info.size }
    } catch (error) {
      if (this.absent(error)) {
        return undefined
      }
      throw this.io(error)
    }
  }

  /** 读取全文；二进制或超限时抛出对应的类型化错误。 */
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const info = await this.stat(target, signal)
    if (!info) {
      throw new FsError(`no such file: ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    if (info.type === 'directory') {
      throw new FsError(`not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE')
    }
    if ((info.size ?? 0) > MAX_READ_BYTES) {
      throw new FsError(
        `file too large for readText (${String(info.size ?? 0)} bytes): ${target.displayPath}`,
        'FS_NOT_TEXT',
      )
    }
    let buffer: Buffer
    try {
      buffer = await readFile(target.displayPath)
    } catch (error) {
      throw this.io(error)
    }
    const text = decodeText(buffer)
    if (text === undefined) {
      throw new FsError(`not a UTF-8 text file: ${target.displayPath}`, 'FS_NOT_TEXT')
    }
    return text
  }

  /**
   * 流式读取。
   *
   * 逐块严格解码，因此**二进制会在第一块就被拒绝**，而不是边流边吐替换字符。
   */
  override async streamText(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<string>> {
    signal?.throwIfAborted()
    const info = await this.stat(target, signal)
    if (!info) {
      throw new FsError(`no such file: ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    if (info.type !== 'file') {
      throw new FsError(`not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE')
    }
    const path = target.displayPath
    return (async function* stream(): AsyncIterable<string> {
      const source = createReadStream(path)
      try {
        for await (const chunk of source) {
          signal?.throwIfAborted()
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
          const text = decodeText(buffer)
          if (text === undefined) {
            throw new FsError(`not a UTF-8 text file: ${path}`, 'FS_NOT_TEXT')
          }
          yield text
        }
      } finally {
        source.destroy()
      }
    })()
  }

  /** 按名稳定排序列出直接子项；不读任何文件内容。 */
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    signal?.throwIfAborted()
    let names: string[]
    try {
      names = await readdir(target.displayPath)
    } catch (error) {
      if (this.absent(error)) {
        throw new FsError(`no such directory: ${target.displayPath}`, 'FS_NOT_FOUND')
      }
      throw this.io(error)
    }
    const entries: FsDirEntry[] = []
    for (const entryName of names.sort()) {
      signal?.throwIfAborted()
      const childPath = join(target.displayPath, entryName)
      try {
        const info = await lstat(childPath)
        const type = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
        const canonical = await this.canonicalize(childPath)
        entries.push({
          name: entryName,
          type,
          target: { targetKey: FsTargetKey(canonical), displayPath: canonical },
          version: versionOf(info.mtimeMs, info.size),
          size: info.size,
        })
      } catch (error) {
        // 列举期间被删掉的项：跳过而不是让整个列举失败。
        if (!this.absent(error)) {
          throw this.io(error)
        }
      }
    }
    return entries
  }

  /** 原子创建或替换全文。 */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    signal?.throwIfAborted()
    const before = await this.readIfPresent(target, signal)
    this.assertMutable(target, sandboxPolicy, await this.rootFor(sandboxPolicy), before !== null)

    if (before !== null) {
      if (expected?.kind === 'createIfAbsent') {
        throw new FsError(
          `refusing to create: already exists: ${target.displayPath}`,
          'FS_STALE_VERSION',
        )
      }
      if (expected?.kind === 'replaceIfVersion') {
        const current = await this.requireVersion(target, signal)
        if (current !== expected.version) {
          throw new FsError(
            `stale content: ${target.displayPath} changed since it was read`,
            'FS_STALE_VERSION',
          )
        }
      }
    }

    // 保留原文件已有的换行风格；新文件按 LF。
    const eol = before === null ? '\n' : detectEol(before)
    const payload = fromLf(toLf(content), eol)
    await this.atomicWrite(target, payload, signal)

    const afterInfo = await this.stat(target, signal)
    return {
      operation: before === null ? 'create' : 'update',
      version: afterInfo?.version ?? versionOf(Date.now(), Buffer.byteLength(payload)),
      before: before === null ? null : toLf(before),
      after: toLf(payload),
    }
  }

  /**
   * 字面量替换。
   *
   * 版本校验与匹配必须在**同一个临界区**里完成——中间被别的东西改了文件，
   * 后半段就会基于陈旧内容做决定。因此这里先取版本、再读内容、再比对。
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    signal?.throwIfAborted()
    if (edit.oldString.length === 0) {
      throw new FsError('editText requires a non-empty oldString', 'FS_IO_ERROR')
    }
    const before = await this.readIfPresent(target, signal)
    if (before === null) {
      throw new FsError(`no such file: ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    this.assertMutable(target, sandboxPolicy, await this.rootFor(sandboxPolicy), true)

    if (expected) {
      const current = await this.requireVersion(target, signal)
      if (current !== expected.version) {
        throw new FsError(
          `stale content: ${target.displayPath} changed since it was read`,
          'FS_STALE_VERSION',
        )
      }
    }

    const lfBefore = toLf(before)
    const needle = toLf(edit.oldString)
    const occurrences = lfBefore.split(needle).length - 1
    if (occurrences === 0) {
      throw new FsError(
        `edit target not found in ${target.displayPath}`,
        'FS_EDIT_NOT_FOUND',
      )
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new FsError(
        `edit target appears ${String(occurrences)} times in ${target.displayPath}; ` +
          'pass replaceAll to change every occurrence',
        'FS_AMBIGUOUS_EDIT',
      )
    }
    const lfAfter = edit.replaceAll
      ? lfBefore.split(needle).join(toLf(edit.newString))
      : lfBefore.replace(needle, toLf(edit.newString))

    const eol = detectEol(before)
    await this.atomicWrite(target, fromLf(lfAfter, eol), signal)

    const afterInfo = await this.stat(target, signal)
    return {
      version: afterInfo?.version ?? versionOf(Date.now(), Buffer.byteLength(lfAfter)),
      before: lfBefore,
      after: lfAfter,
    }
  }

  /**
   * 规范化一个绝对路径，**目标不存在时也保持一致**。
   *
   * 这里踩过一个真实缺陷：`realpath` 对不存在的目标会失败，早先的实现于是退回
   * 词法路径；而工作区根走的是 `realpath`（长名）。于是"新建文件"这个最常见的
   * 场景里，两侧一个短名一个长名，包含判断恒为假——**所有新建都被拒绝**。
   *
   * 正确做法是把最深的存在祖先规范化，再把剩余段拼回去，让两侧始终同形。
   */
  private async canonicalize(absolute: string): Promise<string> {
    try {
      return await realpath(absolute)
    } catch {
      const parent = dirname(absolute)
      if (parent === absolute) {
        return absolute
      }
      return join(await this.canonicalize(parent), basename(absolute))
    }
  }

  /**
   * 取规范化的工作区根。
   *
   * **为什么必须规范化**：`resolve()` 会把目标做 `realpath`，而策略给的根未必是
   * 规范路径——Windows 短名（`RUNNER~1` vs `runneradmin`）、符号链接、macOS 的
   * 大小写不敏感都会让两者对不上。对不上的后果是包含判断恒为假，于是**所有写入
   * 都被拒绝**。这不是安全问题（fail-closed），但会让文件能力直接不可用。
   */
  private async rootFor(policy: SandboxExecutionPolicy | undefined): Promise<string | undefined> {
    const raw = policy?.workspaceRoot
    if (!raw) {
      return undefined
    }
    const cached = this.rootCache.get(raw)
    if (cached !== undefined) {
      return cached
    }
    const resolved = await realpath(raw).catch(() => raw)
    this.rootCache.set(raw, resolved)
    return resolved
  }
  /** 围栏判定：模式与工作区边界。拒绝时用 `FS_SANDBOX_DENIED` 而不是普通 IO 错误。 */
  private assertMutable(
    target: FsTarget,
    policy: SandboxExecutionPolicy | undefined,
    root: string | undefined,
    exists: boolean,
  ): void {
    const mode = effectiveMode(policy)
    if (mode === 'read-only') {
      throw new FsError(
        `sandbox is read-only; refusing to modify ${target.displayPath}`,
        'FS_SANDBOX_DENIED',
      )
    }
    if (root) {
      if (!isAtOrUnder(root, target.displayPath)) {
        throw new FsError(
          `path is outside the workspace boundary: ${target.displayPath}`,
          'FS_SANDBOX_DENIED',
        )
      }
    } else if (!exists) {
      // 新建文件且没有工作区边界可依：不猜，直接拒绝。
      throw new FsError(
        `no workspace boundary resolved for a new file: ${target.displayPath}`,
        'FS_SANDBOX_DENIED',
      )
    }
  }

  /**
   * 原子写：先写同目录临时文件，再 rename 覆盖。
   *
   * 同目录对 rename 是必需的——跨设备 rename 会退化甚至失败，而临时文件放在
   * `os.tmpdir()` 恰好就是跨设备的典型。
   */
  private async atomicWrite(target: FsTarget, content: string, signal?: AbortSignal): Promise<void> {
    const dir = dirname(target.displayPath)
    const temp = join(dir, `.runbox-tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      await writeFile(temp, content, 'utf8')
      signal?.throwIfAborted()
      const { rename } = await import('node:fs/promises')
      await rename(temp, target.displayPath)
    } catch (error) {
      const { rm } = await import('node:fs/promises')
      await rm(temp, { force: true }).catch(() => undefined)
      throw this.io(error)
    }
  }

  private async readIfPresent(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    const info = await this.stat(target, signal)
    if (!info) {
      return null
    }
    if (info.type !== 'file') {
      throw new FsError(`not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE')
    }
    return this.readText(target, signal)
  }

  private async requireVersion(target: FsTarget, signal?: AbortSignal): Promise<FsVersion> {
    const info = await this.stat(target, signal)
    if (!info) {
      throw new FsError(`no such file: ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    return info.version
  }

  private absent(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }

  private io(error: unknown): FsError {
    if (error instanceof FsError) {
      return error
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return new FsError(
        `permission denied: ${(error as Error).message}`,
        code === 'EROFS' ? 'FS_SANDBOX_DENIED' : 'FS_PERMISSION_DENIED',
      )
    }
    return new FsError(
      `filesystem error: ${error instanceof Error ? error.message : String(error)}`,
      'FS_IO_ERROR',
    )
  }
}

/**
 * Cordis 插件入口。
 * @param ctx - 所属上下文。
 */
export function apply(ctx: Context): void {
  new RunboxFileSystem(ctx)
}
