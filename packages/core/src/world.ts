/**
 * 执行世界的解析。
 *
 * ## 要解决的问题
 *
 * 官方要求 `ctx.fs` 与 `ctx.subprocess` 共享同一个执行世界，否则
 * `fs.processPath()` 交出去的路径在子进程里打不开。我们此前让**每个 provider
 * 各自决定**箱的工作区根：`provider-shell` 用会话工作区，`provider-subprocess`
 * 用它的 `cwd`。当 `cwd` 是工作区的子目录时，两者挂载点不同——于是同一个会话有了
 * 两个箱，`processPath()` 的承诺也就破了。
 *
 * ## 解法
 *
 * 把"执行世界"变成一个**由工作区根标识的共享概念**，并制定一条确定的解析规则：
 *
 * 1. 调用方**确知**工作区根时（如 shell 拿到 `ctx.sandboxPolicy.workspaceRoot`），以它为准；
 * 2. 否则，若 `cwd` 落在某个**已经挂载过的**世界根之下，复用那个根——这保证了
 *    "先由 shell 建箱，再由 subprocess 在里面跑"这条最常见的路径收敛到同一个箱；
 * 3. 再否则，以 `cwd` 自身为根（没有其它信息时不猜）。
 *
 * 规则 2 是关键：它让收敛**自动发生**，不需要任何跨 provider 的注册协议。
 *
 * @module @dsh-runbox/core/world
 */

import { realpath } from 'node:fs/promises'

import { isAtOrUnder } from './paths.ts'

/**
 * 从已知世界里挑出包含 `cwd` 的**最深**那个根。
 *
 * 取最深而不是第一个匹配：嵌套仓库（工作区里还有子工作区）时，用户期望的是
 * 更靠近的那一层，而不是最外层。
 *
 * 纯函数，不碰文件系统——好测，而且解析规则本身值得被测死。
 *
 * @param cwd - 执行发生的目录（绝对路径）。
 * @param knownRoots - 已经挂载过的世界根（绝对路径）。
 * @returns 最深的那层包含根；没有命中时返回 `undefined`。
 */
export function pickWorldRoot(
  cwd: string,
  knownRoots: readonly string[],
): string | undefined {
  let best: string | undefined
  for (const root of knownRoots) {
    if (!isAtOrUnder(root, cwd)) {
      continue
    }
    if (best === undefined || root.length > best.length) {
      best = root
    }
  }
  return best
}

/**
 * 把路径规范化成世界标识。
 *
 * 目标不存在时把**最深的存在祖先**规范化再拼回剩余段——理由与 `provider-fs`
 * 里那处相同：`realpath` 对不存在的目标会失败，若此时退回词法路径，同一个目录
 * 就会有两个标识（短名与长名、`/repo` 与 `/repo/.`），围栏与箱复用都会因此失效。
 *
 * @param absolute - 绝对路径。
 * @returns 规范化后的路径。
 */
export async function canonicalWorldRoot(absolute: string): Promise<string> {
  try {
    return await realpath(absolute)
  } catch {
    const cut = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
    if (cut <= 0) {
      return absolute
    }
    const parent = absolute.slice(0, cut)
    const tail = absolute.slice(cut + 1)
    const canonicalParent = await canonicalWorldRoot(parent)
    return canonicalParent.endsWith('/')
      ? `${canonicalParent}${tail}`
      : `${canonicalParent}/${tail}`
  }
}

/**
 * 按既定规则解析出执行世界。
 *
 * @param cwd - 执行发生的目录。
 * @param explicitRoot - 调用方确知的工作区根（可选）。
 * @param knownRoots - 已经挂载过的世界根。
 * @returns 规范化后的世界根。
 */
export async function resolveWorldRoot(
  cwd: string,
  explicitRoot: string | undefined,
  knownRoots: readonly string[],
): Promise<string> {
  if (explicitRoot) {
    return canonicalWorldRoot(explicitRoot)
  }
  const inherited = pickWorldRoot(cwd, knownRoots)
  return canonicalWorldRoot(inherited ?? cwd)
}
