/**
 * 箱（box）的抽象契约。
 *
 * 一个 box = 一个会话的一次性执行环境。后端可以是 Docker、Podman、WSL2、
 * microVM 或远程主机——上层 provider 只认这份契约，不认具体后端。
 *
 * @module @dsh-runbox/core/types
 */

import type { Readable } from 'node:stream'

import type { BoxConfinement } from './policy.ts'

/** 箱的稳定标识。 */
export type BoxId = string

/** 箱的状态。`failed` 是终态，需要回收。 */
export type BoxState = 'created' | 'running' | 'stopped' | 'failed'

/**
 * 箱的网络模式。
 *
 * 默认必须是 `none`：agent 自主运行时，出网是最容易被忽视的逃逸面。
 * 需要联网时由部署方显式打开，并在 M4 收敛为域名白名单。
 */
export type BoxNetworkMode = 'none' | 'bridge' | 'host'

/** 箱的资源限额。字段缺省表示交给后端默认值，不表示"无限"。 */
export interface BoxLimits {
  /** CPU 核数（可小数），对应 Docker 的 `NanoCPUs`。 */
  readonly cpus?: number
  /** 内存上限（字节），对应 Docker 的 `Memory`。 */
  readonly memoryBytes?: number
  /** 进程数上限，对应 Docker 的 `PidsLimit`——防止 fork 炸弹拖垮宿主。 */
  readonly pidsLimit?: number
}

/** 创建箱所需的完整规格。字段全部显式：本层不施加隐藏默认值。 */
export interface BoxSpec {
  /** 归属会话；一个会话一个箱，箱的生命周期跟随会话。 */
  readonly sessionId: string
  /** 宿主上的工作区根目录——`workspace-write` 的写入边界。 */
  readonly workspaceRoot: string
  /**
   * 工作区在箱内的挂载路径。
   *
   * 刻意与宿主同路径：官方 `ctx.fs` 的 `processPath()` 会把宿主路径交给
   * 子进程去 open，两侧路径必须一致，"执行世界统一"这条契约才成立。
   */
  readonly workspaceMountPath: string
  /** 镜像引用，例如 `node:22-alpine`。 */
  readonly image: string
  /** 网络模式。 */
  readonly network: BoxNetworkMode
  /** 资源限额。 */
  readonly limits: BoxLimits
  /**
   * 本次的围栏配置，由 `confinementFor()` 从官方沙箱模式翻译而来。
   *
   * 刻意**不**在这里再放一个 `SandboxMode` 字段：翻译只发生一次，后端只消费
   * 结果。否则每加一个后端都要重新实现一遍模式语义，隔离就会开始走样。
   */
  readonly confinement: BoxConfinement
}

/** 一个已创建的箱。 */
export interface BoxHandle {
  readonly id: BoxId
  readonly sessionId: string
  readonly state: BoxState
  /** 创建成功的时间戳（毫秒）。 */
  readonly createdAt: number
}

/** 一次箱内执行请求。 */
export interface BoxExecRequest {
  /** 要执行的确切 argv；`argv[0]` 是程序，永不经 shell 解释。 */
  readonly argv: readonly string[]
  /** 箱内工作目录。 */
  readonly cwd: string
  /** 追加的环境变量。 */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** 标准输入内容；缺省即关闭 stdin。 */
  readonly stdin?: string | undefined
  /** 超时（毫秒）。超时由调用方判定，本层只负责终止进程树。 */
  readonly timeoutMs?: number | undefined
  /** 取消信号。 */
  readonly signal?: AbortSignal | undefined
}

/** 一次箱内执行的结果。 */
export interface BoxExecResult {
  /** 退出码；被信号杀死时为 null。 */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  /** 墙钟耗时（毫秒）。 */
  readonly durationMs: number
  /** 是否因超时被终止。 */
  readonly timedOut: boolean
}

/**
 * 一次**流式**执行的句柄。
 *
 * 与 `BoxExecResult` 的区别是语义上的：批式等进程结束再返回，流式边产生边交付。
 * `ctx.subprocess` 的 `spawn` 契约要求"立即返回活句柄"，所以它需要这个。
 */
export interface BoxExecStream {
  /** 标准输出（增量到达）；后端不支持分路时为 `undefined`。 */
  readonly stdout?: Readable | undefined
  /** 标准错误（增量到达）。 */
  readonly stderr?: Readable | undefined
  /** 进程结束后 resolve 出退出码；取不到时为 `null`（不编造）。 */
  readonly done: Promise<{ exitCode: number | null }>
  /** 按进程树终止：先 TERM，宽限期后 KILL。 */
  terminate(): void
  /** 等待进程树退出；`signal` 中断则返回 `false`。 */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/**
 * 后端契约。实现者只需要把这一组方法做对，上层 provider 就能复用。
 *
 * 注意 `probe()`：它是 fail-closed 的入口。registry 在选中后端前必须先探测，
 * 探测失败就直接抛 `BackendUnavailableError`，绝不允许"降级为不隔离"。
 */
export interface BoxBackend {
  /** 后端名，用于配置选择与日志归因。 */
  readonly name: string

  /**
   * 探测后端此刻是否真的可用（守护进程在跑、权限够、能创建容器）。
   * @returns 可用返回 `true`；不可用返回 `false` 而不是抛错。
   */
  probe(signal?: AbortSignal): Promise<boolean>

  /** 按规格创建一个箱。失败必须清理掉已分配的局部资源。 */
  create(spec: BoxSpec): Promise<BoxHandle>

  /** 在箱内执行一次命令。 */
  exec(box: BoxHandle, request: BoxExecRequest): Promise<BoxExecResult>

  /**
   * 在箱内启动一次**流式**执行并立即返回句柄。
   *
   * 声明为可选：不是每个后端都能做流式（有些只暴露批式接口）。缺失时
   * `BoxManager.startExec()` 会抛错——**不允许**退化成"等结束再返回"，
   * 那会静默改变 `spawn` 的语义。
   */
  startExec?(box: BoxHandle, request: BoxExecRequest): Promise<BoxExecStream>

  /** 停止箱，但保留其身份以便回收与审计。 */
  stop(box: BoxHandle): Promise<void>

  /** 移除箱及其所有资源。必须是幂等的。 */
  remove(box: BoxHandle): Promise<void>

  /** 列出本后端当前持有的箱——孤儿回收的依据。 */
  list(): Promise<BoxHandle[]>
}
