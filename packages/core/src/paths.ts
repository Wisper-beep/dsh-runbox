/**
 * 路径语义：宿主路径 ↔ 箱内路径。
 *
 * **为什么需要这一层**：官方 `ctx.fs` 的 `processPath()` 要求返回"本文件系统执行
 * 世界里、子进程能打开的规范绝对路径"，而 `fileUrl()` 的注释更直接点明
 * 「后端负责 URI 编码，因为**宿主平台可能与执行平台不同**」。
 *
 * 我们正好是这种情况：宿主可能是 Windows（`E:\repo\a.txt`），而箱是 Linux。
 * 同一路径挂载只在 POSIX 宿主上成立；Windows 宿主必须做盘符映射，否则箱里
 * 根本不存在那个路径，`processPath()` 交出去的东西打不开。
 *
 * @module @dsh-runbox/core/paths
 */

/** 运行平台，注入以便测试。 */
export type HostPlatform = 'win32' | 'posix'

/**
 * 判断 `child` 是否等于 `parent` 或位于其下。
 *
 * **分隔符必须先归一化**：Windows 宿主路径用反斜杠，若直接比前缀，工作区包含
 * 判断会**静默返回 false**——围栏看起来在生效，实际上一条都没拦住。这个 bug 不会
 * 报错，只会让边界失效，因此由测试锁住。
 *
 * 归一化时顺带压掉尾斜杠，避免 `C:\repo\` 与 `C:\repo` 被当成两个根。
 *
 * @param parent - 已规范化的父路径。
 * @param child - 已规范化的候选子路径。
 * @returns `child` 是否等于 `parent` 或位于其下。
 */
export function isAtOrUnder(parent: string, child: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  const root = normalize(parent)
  const candidate = normalize(child)
  if (root === candidate) {
    return true
  }
  return candidate.startsWith(root === '/' ? '/' : `${root}/`)
}

/**
 * 把宿主路径翻译成箱内路径。
 *
 * - **POSIX 宿主**：恒等映射。宿主与箱共享同一套绝对路径，工作区可以挂到同路径，
 *   `processPath()` 因此天然自洽。
 * - **Windows 宿主**：盘符小写并降为路径段（`E:\repo\a.txt` → `/e/repo/a.txt`），
 *   反斜杠转正斜杠。这是 Docker Desktop 绑定挂载的通行约定，也是唯一能让箱内
 *   路径既稳定又可预期的方式。
 *
 * 注意这是**纯词法**变换，不做 realpath——realpath 是宿主的职责，在 `resolve()`
 * 里已经做过一次，重复做只会把符号链接语义搞乱。
 *
 * @param hostPath - 宿主上的绝对路径（Windows 上是 `E:\...` 或 `E:/...`）。
 * @param platform - 宿主平台。
 * @returns 箱内的绝对 POSIX 路径。
 */
export function toBoxPath(hostPath: string, platform: HostPlatform): string {
  const normalized = hostPath.replace(/\\/g, '/')
  if (platform === 'posix') {
    return normalized
  }
  const drive = normalized.match(/^([A-Za-z]):(\/.*)?$/)
  if (!drive?.[1]) {
    // UNC（\\server\share）或其它形态：保留为绝对路径，不假装能映射。
    return normalized.startsWith('/') ? normalized : `/${normalized}`
  }
  const rest = (drive[2] ?? '').replace(/^\/+/, '')
  const lower = drive[1].toLowerCase()
  return rest.length === 0 ? `/${lower}` : `/${lower}/${rest}`
}

/** 当前进程的平台，转成我们的词汇。 */
export function hostPlatform(): HostPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

/**
 * 把箱内路径翻译回宿主路径。仅供诊断与展示——权威方向是宿主 → 箱。
 *
 * @param boxPath - 箱内的绝对 POSIX 路径。
 * @param platform - 宿主平台。
 * @returns 宿主上的路径；无法确定时原样返回。
 */
export function fromBoxPath(boxPath: string, platform: HostPlatform): string {
  if (platform === 'posix') {
    return boxPath
  }
  const mapped = boxPath.match(/^\/([a-zA-Z])(\/.*)?$/)
  if (!mapped?.[1]) {
    return boxPath
  }
  const rest = (mapped[2] ?? '').replace(/\//g, '\\')
  return `${mapped[1].toUpperCase()}:${rest.length === 0 ? '\\' : rest}`
}
