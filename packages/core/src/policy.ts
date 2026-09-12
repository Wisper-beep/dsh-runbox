/**
 * 逐调用策略翻译：把官方的 `SandboxMode` 翻成箱的围栏配置。
 *
 * 这是全项目最该被测死的一个函数——它错了，隔离就是假的。因此它是纯函数、
 * 无 I/O、无状态，并有对应单测。
 *
 * 官方语义（`docs/subsystems/sandbox.zh.md`）：
 * - `read-only`：只允许必需的写入汇（如 `/dev/null`），后端拒绝一切写入。
 * - `workspace-write`：允许在工作区根目录与后端承诺的临时区下写入。
 * - `danger-full-access`：**绕过隔离，根本不进 seam**——消费方直接 spawn 原始
 *   argv。因此本函数只接受前两种模式，收到第三种即是编程错误。
 *
 * @module @dsh-runbox/core/policy
 */

import type { ConfinedSandboxMode, SandboxEnforcement } from '@deepseek-ai/dsh-sandbox'
import { UnsupportedModeError } from './errors.ts'
import { isAtOrUnder } from './paths.ts'

/** 箱的围栏配置——后端据此设置 rootfs 与工作区的挂载标志。 */
export interface BoxConfinement {
  /** 根文件系统是否只读。两种受限模式下都是 `true`：可写 rootfs 会让隔离形同虚设。 */
  readonly rootfsReadOnly: boolean
  /** 工作区挂载是否只读。仅 `read-only` 模式为 `true`。 */
  readonly workspaceReadOnly: boolean
  /** 启动后需要挂载为可写 tmpfs 的路径——进程普遍需要这些汇才能正常工作。 */
  readonly tmpfsPaths: readonly string[]
  /**
   * 强制执行完整度。
   *
   * 容器边界管住了**文件效果**的全部承诺（rootfs 与工作区的读写都由
   * 挂载标志在挂载命名空间层面决定），因此容器后端报 `full`。
   * 这与官方 Windows ACL 后端因环境 ACL 缺口报 `partial` 形成对照。
   */
  readonly enforcement: SandboxEnforcement
}

/** 进程在受限环境里仍然需要的可写临时区。 */
const DEFAULT_TMPFS_PATHS = ['/tmp', '/run'] as const

/**
 * 把官方模式翻译成箱的围栏配置。
 *
 * @param mode - 受限的沙箱模式（`read-only` 或 `workspace-write`）。
 * @returns 该模式对应的围栏配置。
 * @throws UnsupportedModeError - 传入 `danger-full-access` 时抛出：按官方契约，
 *   该模式不应该到达任何隔离后端，能到达就说明调用方逻辑有误。
 */
export function confinementFor(mode: ConfinedSandboxMode): BoxConfinement {
  switch (mode) {
    case 'read-only':
      return {
        rootfsReadOnly: true,
        workspaceReadOnly: true,
        tmpfsPaths: DEFAULT_TMPFS_PATHS,
        enforcement: 'full',
      }
    case 'workspace-write':
      return {
        rootfsReadOnly: true,
        workspaceReadOnly: false,
        tmpfsPaths: DEFAULT_TMPFS_PATHS,
        enforcement: 'full',
      }
    default:
      throw new UnsupportedModeError(
        `runbox only confines read-only / workspace-write; ` +
          `'${String(mode)}' must not reach a confining backend`,
      )
  }
}

/**
 * 判断一次调用是否真的落在工作区内——`workspace-write` 的边界检查。
 *
 * 纯词法比较，不做 I/O：官方 `ctx.sandboxPolicy` 已经把 root 规范化过
 * （先按文件系统语义、再按词法），这里只比前缀。
 *
 * @param workspaceRoot - 已规范化的绝对工作区根。
 * @param candidate - 已规范化的绝对候选路径。
 * @returns 候选路径是否等于工作区根或位于其下。
 */
export function withinWorkspace(workspaceRoot: string, candidate: string): boolean {
  return isAtOrUnder(workspaceRoot, candidate)
}
