# dsh-runbox

> DeepSeek Harness 的隔离执行地基：把 agent 的 shell、文件、进程、终端与后台任务，从宿主本地搬进一次性容器里执行。
>
> An isolated execution substrate for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

容器化、可丢弃、有资源与网络边界、执行过程可审计。

## 当前状态

**未可用的开发预览。** 地基与后端探测已落地，各 provider 的实现按里程碑推进中。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 官方 seam 契约、monorepo 骨架、CI、最小插件加载 | ✅ 已完成 |
| M1 | Docker 箱生命周期；`subprocess` / `shell` provider 实现 | 进行中 |
| M2 | `fs` provider、逐调用策略翻译、强制执行度上报 | 未开始 |
| M3 | `terminal` / `jobs` provider、会话级生命周期与孤儿回收 | 未开始 |
| M4 | Web UI（设置 / 状态 / 审计）、网络与资源策略 | 未开始 |
| M5 | Podman / WSL2 / microVM / SSH 第二后端、一致性测试套件 | 未开始 |

各包当前状态：

| 包 | 状态 |
|---|---|
| `@dsh-runbox/core` | 可用：后端注册表、箱契约、策略翻译、fail-closed 选择 |
| `@dsh-runbox/backend-docker` | `probe()` 可用；箱生命周期待 M1 |
| `@dsh-runbox/provider-shell` | 契约已定型；实现待 M1 |
| `@dsh-runbox/provider-subprocess` | 占位，待 M1 |
| `@dsh-runbox/provider-fs` | 占位，待 M2 |
| `@dsh-runbox/sandbox-bridge` | 占位，待 M2 |
| `@dsh-runbox/provider-jobs` | 占位，待 M3 |
| `@dsh-runbox/provider-terminal` | 占位，待 M3 |
| `@dsh-runbox/ui` | 占位，待 M4 |

占位包被调用时抛 `RunboxNotImplementedError`，**不会静默空转**——一个"什么都不做也不报错"的 provider 会让上层误以为隔离已经生效。

## 用途

### 为什么需要它

DeepSeek Harness 官方文档 `docs/subsystems/sandbox.zh.md` 写道：

> 「容器、microVM 和远程执行是完整能力 seam 的**同级实现**，而非 `ctx.sandbox` 的提供方。」

官方把这三类点名为预期扩展形态，但尚未实现；社区侧同样是空的（对 npm 上 4646 个 `dsh-plugin` 做密度探测，容器化执行后端的有效实现为 0，`podman` 为 0，Windows 沙箱原语为 0。见 [`research/gap-report.md`](research/gap-report.md)）。

### 它做什么

- **真实边界**：`read-only` / `workspace-write` 由容器挂载标志在挂载命名空间层面强制，不是应用层的自觉。
- **可丢弃、可复现**：每个会话一个箱子，跑完即弃；环境由镜像定义。
- **零改上层**：实现的是官方 capability seam，审批、权限、成本、审计等既有插件无需改动即可获得隔离能力。
- **失败即拒绝**：容器不可用时抛 `SandboxUnavailableError`，绝不静默回落到宿主执行。

## 架构

```
dsh 上层（无需改动）
  agent-loop · tool-bash · tool-fs · tool-terminal · tool-jobs · 审批 / 权限
        │  只认 seam，不认实现
dsh-runbox
  core       后端注册表 · 会话与箱绑定 · 策略翻译 · fail-closed · 审计 · 孤儿回收
  providers  subprocess │ fs │ shell │ terminal │ jobs
  backends   docker / podman │ wsl2 │ microVM │ ssh        ← 同一接口，可插拔
  ui         设置卡 · 状态面板 · 审计时间线
        │  Engine API（npipe / unix socket）
一次性容器：只读 rootfs + tmpfs · 工作区同路径挂载 · cgroup 限额 · 默认无网络
```

### 包划分

| 包 | 职责 |
|---|---|
| `core` | 后端注册表、箱契约、`SandboxMode` → 围栏配置翻译、fail-closed 选择、审计 |
| `backend-docker` | Docker / Podman Engine API 后端（不依赖 docker CLI） |
| `provider-subprocess` | `ctx.subprocess` 实现：spawn 进箱、stdio、退出码、进程树终止 |
| `provider-fs` | `ctx.fs` 实现：读写与编辑路由进箱，遵守工作区边界 |
| `provider-shell` | `ctx.shell` 实现：箱内 bash 执行器 |
| `provider-terminal` | `ctx.terminals` 后端：箱内持久 PTY |
| `provider-jobs` | `ctx.jobs` 实现：后台任务登记与回收 |
| `sandbox-bridge` | 逐调用沙箱模式 → 箱围栏配置，并上报强制执行度 |
| `conformance` | 验收门禁：加载、注册可逆、fail-closed |
| `ui` | Web 设置卡、箱状态面板、审计时间线 |

### 关键机制

**契约门禁。** `provider-*` 包继承官方抽象 seam 类（如 `ShellExecutor`）。官方 rc 版本一旦改签名，`npm run build` 直接失败——dsh 处于 developer preview 且明说会有破坏性变更，这是最可靠的一根安全绳。

**fail-closed。** 后端选择逐个探测，全部不可用时抛 `BackendUnavailableError`。代码里不存在"降级为不隔离"的分支，并有测试守着。

**执行世界一致。** 官方要求 `ctx.fs` 与 `ctx.subprocess` 共享同一个执行世界，因此 `fs.processPath()` 交给子进程的路径在箱内必须可打开——两者成对替换，工作区在箱内挂载到与宿主相同的路径。

**注册即可逆。** 所有注册都走 Cordis 的 `ctx.effect`，返回注销函数，热卸载不留残余。

## 使用

### 环境要求

- Node.js ≥ 22
- Docker 或 Podman（M1 起需要；用于承载箱）

### 安装

```bash
git clone https://github.com/Wisper-beep/dsh-runbox.git
cd dsh-runbox
npm ci --legacy-peer-deps
```

`--legacy-peer-deps` 是必须的，原因见[已知问题](#已知问题)。

### 在 dsh 中加载

```bash
# 核心地基（必需）
dsh plugin --profile web add @dsh-runbox/core

# Docker 后端
dsh plugin --profile web add @dsh-runbox/backend-docker

# 执行层（M1 起可用）
dsh plugin --profile web add @dsh-runbox/provider-shell
dsh plugin --profile web add @dsh-runbox/provider-subprocess
```

加载 provider 即接管对应能力。每个 context 只能有一个实现，因此挂上 `provider-shell` 后不应再挂官方的 `bash-local`。

### 验证

```bash
npm run build   # tsc -b：同时是类型检查与构建
npm test        # 含 M0 加载门禁、fail-closed、策略翻译、引擎探测
```

## 开发

```
packages/    十个包，见上表
docs/        01-选题提案.md（论证与设计）｜ 02-seam契约速览.md（官方接口要点，实现依据）
research/    生态调研证据：4646 插件快照、空白核验、可复现脚本
scripts/     fetch-seam-contracts.py（拉官方类型契约）｜ scaffold-packages.mjs（生成包骨架）
```

常用命令：

```bash
npm run build        # 类型检查 + 构建（= 契约门禁）
npm test             # 单元与门禁测试
npm run seams:pull   # 拉取官方 seam 类型契约 → reference/dsh-seams/（不入库）
```

`reference/dsh-seams/` 是官方包的解包产物（第三方代码，MIT），可用脚本随时重建，因此不提交。契约稳定后应把版本号写回 `scripts/fetch-seam-contracts.py` 的 `MANIFEST` 锁定。

契约要点见 [`docs/02-seam契约速览.md`](docs/02-seam契约速览.md)。

## 已知问题

**1. `npm ci` 必须带 `--legacy-peer-deps`。**

官方 seam 包的 peer 闭包包含一个未发布到 npm 的包：`@deepseek-ai/dsh-type-meta`（registry 返回 404），npm 的 peer 自动安装会因此中断整个 install。仓库根 `.npmrc` 已固定该行为。类型层面由 `skipLibCheck` 兜住，运行时的真实实例由宿主 dsh 提供；上游补发该包后即可移除。

**2. 契约门禁是编译期的。**

它能证明**签名一致**，不能证明**行为一致**。行为一致性由 `packages/conformance` 的用例逐步覆盖。

## 许可

[MIT](LICENSE)，与 DeepSeek Harness 保持一致。
