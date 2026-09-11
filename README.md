# dsh-runbox

> **让 DeepSeek Harness 的 agent 在你的机器「旁边」干活，而不是在它「上面」干活。**

`dsh-runbox` 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）补上**隔离执行地基**：把 shell / 文件 / 进程 / 终端 / 后台任务这一整层能力，从宿主本地搬到一次性容器里执行——可丢弃、有资源与网络边界、全程可审计。

> 状态：**M0 已完成**——monorepo 骨架已建、官方 seam 契约已摸清并固化为编译期门禁，
> 最小插件已在真实 Cordis 上下文中加载通过，CI 在 Ubuntu 与 Windows 双平台跑绿。
> 实现按里程碑推进（见下）。

## 快速开始

```bash
git clone https://github.com/Wisper-beep/dsh-runbox.git
cd dsh-runbox
npm ci --legacy-peer-deps   # 见「已知问题」，这个参数是必须的
npm run build               # tsc -b：同时是类型检查与构建
npm test                    # 25 个断言，含 M0 加载门禁
```

拉取官方 seam 类型契约（离线参考，产物不入库）：

```bash
npm run seams:pull          # → reference/dsh-seams/（已 gitignore）
```

## 仓库结构

```
packages/
  core/                 执行地基：后端注册表、箱契约、策略翻译、fail-closed
  backend-docker/       Docker/Podman 引擎后端（probe 已可用，箱生命周期 M1）
  provider-shell/       ctx.shell 替换实现（契约已定型，实现 M1）
  provider-subprocess/  ctx.subprocess 替换实现（M1）
  provider-fs/          ctx.fs 替换实现（M2）
  provider-jobs/        ctx.jobs 替换实现（M3）
  provider-terminal/    ctx.terminals 后端（M3）
  sandbox-bridge/       逐调用策略 → 箱围栏配置（M2）
  conformance/          M0 验收门禁（加载 / 可逆 / fail-closed）
  ui/                   Web 设置卡、状态面板、审计时间线（M4）
docs/
  01-选题提案.md         选题论证、架构、里程碑、风险
  02-seam契约速览.md     官方各个 seam 的接口要点（实现依据）
research/                生态调研证据（4646 插件快照 + 空白核验 + 可复现脚本）
scripts/                 契约抓取、包骨架生成
```

## 为什么做这个

DeepSeek Harness 官方文档 `docs/subsystems/sandbox.zh.md` 明确写道：

> 「容器、microVM 和远程执行是完整能力 seam 的**同级实现**，而非 `ctx.sandbox` 的提供方。」

也就是说，官方把容器 / microVM / 远程执行点名为**预期中的扩展形态**，却一个都没交付。而对全部 4646 个社区插件做密度探测后（见 [`research/gap-report.md`](research/gap-report.md)）：

| 方向 | 生态内有效实现 |
|---|---|
| 容器化执行后端 | **0** |
| `podman` | **0** |
| Windows 沙箱原语 | **0** |
| microVM / gVisor / Firecracker | 1（商业 provider） |

这是一个**官方点名 + 社区零占位 + 工程门槛高**的位置。

## 它解决什么

- **敢让 agent 过夜跑**：执行被关进容器，`read-only` / `workspace-write` 有真实边界，不再是"信任 + 祈祷"。
- **可丢弃、可复现**：每个会话一个箱子，跑完即弃；环境由镜像定义，换机器结果一致。
- **零改上层**：实现的是官方 capability seam，审批、权限、成本、审计、评测等既有插件**无需任何改动**即可获得隔离能力。
- **失败即拒绝**：容器不可用时抛 `SandboxUnavailableError`，**绝不静默回落**到宿主执行。

## 架构一览

```
dsh 上层（不改）
  agent-loop · tool-bash · tool-fs · tool-terminal · tool-jobs · 审批/权限
        │  只认 seam，不认实现
dsh-runbox
  core       后端注册表 · 会话↔沙箱绑定 · 策略翻译 · fail-closed · 审计 · 孤儿回收
  providers  subprocess │ fs │ shell │ terminal │ jobs
  backends   docker/podman │ wsl2 │ microVM │ ssh      ← 同一接口，可插拔
  ui         设置卡 · 状态面板 · 审计时间线
        │  Engine API (npipe / unix socket)
一次性容器：只读 rootfs + tmpfs · 工作区同路径挂载 · cgroup 限额 · 默认无网络
```

## 里程碑

| 阶段 | 交付 |
|---|---|
| ~~M0~~ ✅ | 官方 seam 契约已摸清并固化为编译期门禁；monorepo 骨架 + 双平台 CI；最小插件已在真实 Cordis 上下文加载通过 |
| M1 | `core` + Docker 后端 + `subprocess` / `shell` provider；宿主零副作用；fail-closed |
| M2 | `fs` provider + 挂载语义 + 策略翻译 + 强制执行上报 |
| M3 | `terminal` / `jobs` provider + 会话级生命周期 + 孤儿回收 |
| M4 | UI（设置 / 状态 / 审计）+ 网络与资源策略 + 文档 |
| M5 | 第二后端（Podman / WSL2 / microVM / SSH）+ 一致性测试套件全绿 |

## 仓库结构

```
docs/01-选题提案.md      选题论证、架构设计、里程碑、风险对策
research/                 生态调研证据（4646 插件快照 + 空白核验 + 可复现脚本）
```

## 链接

- DeepSeek Harness 官方仓库：https://github.com/deepseek-ai/deepseek-harness
- 官方文档站：https://deepseek-harness.github.io/deepseek-harness/
- 选题提案（本仓）：[`docs/01-选题提案.md`](docs/01-选题提案.md)

## 已知问题

**1. `npm ci` 必须带 `--legacy-peer-deps`。**

官方 seam 包的 peer 闭包里包含一个**未发布到 npm** 的包：`@deepseek-ai/dsh-type-meta`（registry 返回 404）。npm 的 peer 自动安装会因此中断整个 install。仓库根的 `.npmrc` 已固定该行为。

这是环境约束而非偏好：类型层面由 `skipLibCheck` 兜住，运行时的真实实例由宿主 dsh 提供。上游补发该包后即可移除。

**2. `reference/` 不入库。**

`reference/dsh-seams/` 是官方 seam 包的解包产物（第三方代码，MIT），可随时用 `npm run seams:pull` 重新生成，因此不提交。契约稳定后应把版本号写回 `scripts/fetch-seam-contracts.py` 的 `MANIFEST` 锁定。

**3. 契约门禁是编译期的。**

`provider-*` 包继承官方抽象 seam 类，所以官方签名一旦漂移，`npm run build` 会失败——这是刻意的。但它只能证明**签名一致**，不能证明**行为一致**；行为一致性由 `packages/conformance` 的用例逐步覆盖。

## 许可

[MIT](LICENSE)，与 DeepSeek Harness 保持一致。
