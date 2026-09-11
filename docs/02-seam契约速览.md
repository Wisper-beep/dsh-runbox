# 官方 seam 契约速览（M0 产出）

> 来源：官方 npm 包 `@deepseek-ai/dsh-*` 的 `.d.ts`，由 `scripts/fetch-seam-contracts.py` 拉取。
> 版本：`dsh-subprocess@0.0.1-rc.1`、`dsh-fs@0.0.1-rc.1`、`dsh-shell@0.0.1-rc.5`、`dsh-terminal@0.0.1-rc.3`、`dsh-jobs@0.0.1-rc.3`、`dsh-sandbox@0.0.1-rc.1`、`dsh-sandbox-policy@0.0.1-rc.1`
> 抓取日期：2026-09-11

本文件是**实现依据**。dsh 处于 developer preview，升级前请重跑抓取脚本并逐条比对。

---

## 1. 一句话路线图

| ctx 键 | 官方类型 | 我们的形态 | 关键约束 |
|---|---|---|---|
| `ctx.subprocess` | `abstract class SubprocessService` | **子类替换** | 每个 context 只能有一个实现，加载第二个会抛错 |
| `ctx.fs` | `abstract class FileSystem` | **子类替换** | 同上 |
| `ctx.shell` | `abstract class ShellExecutor` | **子类替换** | 同上 |
| `ctx.jobs` | `abstract class JobRegistry` | **子类替换** | 同上 |
| `ctx.terminals` | `class TerminalSessionService`（**具体类**） | **注册 backend** | 不是替换服务，而是 `registerBackend()` |
| `ctx.sandboxPolicy` | `class SandboxPolicyService`（**具体类**） | **只消费，不实现** | 策略真源，直接调 `resolve()` |
| `ctx.sandbox` | `abstract class SandboxProvider` | **不实现** | 官方明确：容器/microVM/远程是"同级实现"，不是它的 provider |

**这条表纠正了提案里的一个措辞**：终端那一层不是替换服务，而是往官方服务里注册一个后端；策略层（`sandboxPolicy`）是共享服务，我们只读不实现。

---

## 2. `ctx.subprocess` — 进程执行世界

```ts
abstract class SubprocessService extends Service {
  abstract resolveExecutable(command: string, env?: Readonly<Record<string,string>>, signal?: AbortSignal): Promise<string>
  abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}
```

必须遵守的语义（官方原文要点）：

- **执行世界统一**：可执行文件路径属于"与挂载的文件系统 provider 共享的同一个执行世界"。→ 我们换掉 `fs` 就必须同时换 `subprocess`，否则路径语义不一致。
- **`spawn` 立即返回**活句柄；`done` 在进程 close 时以退出事实 resolve，**仅 spawn 级失败才 reject**。
- **collect 模式读取器是偏移量驱动、非消费式**：`readFrom(fromByte)`，独立读者互不抢输出；有损读要报 `lossy` 与 spill 文件路径。
- **终止只有一个动词**：`terminate()`，SIGTERM → `graceMs` → SIGKILL，且**按进程树作用域**（Windows 走 `taskkill /T`）。`waitForExit()` 观察的是整棵树。
- **服务释放要终止并等待所有在跑的托管进程**。

关键类型：

```ts
interface SubprocessSpawnSpec {
  argv: readonly string[]      // argv[0] 是程序，永不经 shell 解释
  cwd: string
  stdio: { stdin: 'ignore' | 'pipe' | { data: string }
           stdout: SubprocessOutputMode   // 'pipe' | 'inherit' | { maxBytes, spill? }
           stderr: SubprocessOutputMode }
  graceMs: number              // 正有限，且 ≤ MAX_TIMER_DELAY_MS
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv      // undefined 是"删除该环境变量"的墓碑值
}
```

**这个 seam 不施加任何默认值**——每个处置、上限、目录都必须显式给出。

环境变量清洗：官方导出 `scrubbedParentEnv()`，会剔除凭据形状的变量名与**所有 `DSH_*`**；`spawn` 的 `env` 在清洗之后合并。

---

## 3. `ctx.fs` — 一个执行世界的文件系统

```ts
abstract class FileSystem extends Service {
  get sandboxMode(): SandboxMode | undefined      // 后端默认强制的模式，不隔离则 undefined
  abstract resolve(path, opts?): Promise<FsTarget>
  abstract processPath(target: FsTarget): string
  abstract fileUrl(target: FsTarget): string
  abstract contains(parent: FsTarget, child: FsTarget): boolean
  abstract stat(target, signal?): Promise<FsInfo | undefined>
  abstract lstat(path, opts?, signal?): Promise<FsPathInfo | undefined>
  abstract readText(target, signal?): Promise<string>
  abstract streamText(target, signal?): Promise<AsyncIterable<string>>
  abstract listDir(target, signal?): Promise<FsDirEntry[]>
  abstract writeText(target, content, expected?, signal?, sandboxPolicy?): Promise<FsWriteOutcome>
  abstract editText(target, edit, expected?, signal?, sandboxPolicy?): Promise<FsEditOutcome>
}
```

要点：

- **`FsTarget` 是不透明身份**：同一文件必须得到同一个 `targetKey`，别名要归一到同一身份。`processPath()` 才是能交给子进程去 open 的真实路径——两者刻意分离。
- **`writeText` / `editText` 逐调用接收 `sandboxPolicy`**（`SandboxExecutionPolicy`：`mode` + `workspaceRoot` + `sessionId?`）。裸后端忽略它，沙箱化后端用它围栏。
- **变更必须原子**；`editText` 的版本校验与字面量匹配必须在同一个临界区内完成，陈旧内容报 `FS_STALE_VERSION`。
- 三个 `fs/*` 事件可挂钩：`fs/write-intent`（waterfall，单槽决策）、`fs/edit-intent`（waterfall）、`fs/observed`（同步记录，返回 Promise 不会被 await）。
- provider 负责跨 chunk 的 UTF-8 解码与二进制拒绝，策略层永远不碰原始字节。

---

## 4. `ctx.shell` — bash 执行器

```ts
abstract class ShellExecutor extends Service {
  get sandboxMode(): SandboxMode | undefined
  abstract resolve(request: ShellExecRequest): ShellExecSpec
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>
  abstract start(spec: ShellExecSpec): ShellProcess
}
```

要点：

- `run` **只在基础设施故障时 reject**；非零退出、超时被杀、abort 被杀都以 `ShellRunResult` resolve。
- `start` 立即返回，**后台进程不适用超时**；`done` 永不 reject，spawn 失败以 `killed` + stderr 落地。
- `readOutput` 增量：连续读不重复输出；有损读报截断与 spill 文件。
- 组合拆除时要停掉并等待仍在跑的后台进程——**边界是 `ctx.subprocess` 的释放**，所以后台进程能活过执行器单独重载。
- 设置命名空间 `SHELL_SETTINGS_NAMESPACE` 归 seam 而非实现所有（win32 换 pwsh 行，两套同时挂会因重复服务注册而报错）。
- 官方同时导出 `parseExitStatus` / `ParsedExitStatus` 供渲染退出状态。

---

## 5. `ctx.jobs` — 后台任务登记

```ts
abstract class JobRegistry extends Service {
  abstract start(spec: JobStart): JobId
  abstract list(caller?: Agent): JobSnapshot[]
  abstract get(id: JobId, caller?: Agent): JobSnapshot
  abstract read(id: JobId, caller?: Agent): JobRead
  abstract kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'
  abstract wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot>
  abstract onJobDone(listener: JobDoneListener): () => void
  abstract onJobsChanged(listener: JobsChangedListener): () => void
  abstract attachController(name: string): () => void
}
```

要点：**任务 id、归属、轮询、通知都归这个 seam**，执行器不感知 session——这是 `shell` 与 `jobs` 的分界线。`caller` 参数用于按调用方（Agent）做可见性过滤；`attachController(name)` 返回注销函数，符合"注册即可逆"。

---

## 6. `ctx.terminals` — 持久 PTY（注册后端，不替换服务）

```ts
class TerminalSessionService extends Service {
  registerBackend(backend: TerminalBackend): () => void     // ← 我们扩展的入口
  listBackends(): string[]
  spawn(owner: Agent, request: TerminalSpawnRequest, signal?: AbortSignal): Promise<TerminalSpawnResult>
  hasOwnerActivity(owner: Agent): boolean
  startSend(owner, id, request): TerminalSendOperation
  read(owner, id, request?): TerminalReadResult
  signal(owner, id, signal: TerminalSignal): Promise<TerminalSignalResult>
  kill(owner, id, reason?): Promise<boolean>
  list(owner: Agent): TerminalSessionSnapshot[]
}

interface TerminalBackend {
  readonly type: string                                  // 被 TerminalSpawnRequest.type 选中
  spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession>
}
```

要点：会话身份**按 Agent 归属**，清理也按 owner；后端在 partial 资源清理失败时用 `TerminalBackendCleanupError`。

---

## 7. `ctx.sandboxPolicy` / `ctx.sandbox` — 只消费

```ts
class SandboxPolicyService extends Service {
  resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy
  overrideOf(session: Session): SandboxMode | undefined
}

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

要点：

- **优先级**：已批准的显式 mode > 会话最后一条 `sandbox/mode` 事件 > 部署默认值。会话 cwd 就是 `workspace-write` 的边界。
- 只有 `read-only` 与 `workspace-write` 会发给 provider；`danger-full-access` 的消费方直接 spawn 原始 argv，**根本不进 seam**。
- `SandboxEnforcement = 'full' | 'partial'` 是后端上报的**事实**，不是配置。
- `ctx.sandbox.confine()` 的契约里写明：**受限策略下静默的无隔离透传永远不合法**，没有可用后端时必须抛 `SandboxUnavailableError`（`SANDBOX_UNAVAILABLE`）。这条是 `dsh-runbox` 全项目的安全底线。

---

## 8. 对我们实现的三条硬约束

1. **`fs` 与 `subprocess` 必须成对替换**——官方明确两者的"执行世界"必须一致，否则 `processPath()` 交出去的路径在进程侧打不开。
2. **一个 context 只能有一个 service 实现**——换掉 `ctx.subprocess` 意味着官方 `subprocess-local` 不能再挂。这是设计意图，不是限制。
3. **fail-closed 不是可选项**——容器不可用时抛错，绝不静默回落宿主执行。

---

## 9. 复现与升级

```bash
python scripts/fetch-seam-contracts.py     # 重新拉取，产物在 reference/dsh-seams/
```

`reference/` 已在 `.gitignore` 中忽略（可重新生成的第三方代码，不入库）。契约稳定后应把版本号写回脚本里的 `MANIFEST` 锁定。
