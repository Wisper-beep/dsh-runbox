# 生态空白核验报告

> 生成时间：2026-09-11 ｜ 方向密度探测，全部数字可在 CSV 快照中复核

## 生态总量

- 包总数：**4646**
- 时间跨度：**2026-08-13 → 2026-09-11**
- 累计月下载：**4,290,234**
- 零下载包：**952**（20.5%）
- 下载集中度：Top10 **17.7%** ｜ Top100 **38.5%**

## 执行地基 / 隔离（本仓选定方向）

| 方向 | 匹配包数 | 头部实现（月下载） |
|---|---:|---|
| docker 相关 | 4 | `dsh-plugin-aitelier`(1540)；`dsh-github-intelligence`(770)；`dsh-1panel-ops`(204) |
| podman | 0 | — |
| 容器化沙箱后端 | 1 | `dsh-plugin-security-audit`(91) |
| microVM / gVisor / Firecracker / Kata | 1 | `@neevcloud/dsh-sandbox`(636) |
| Windows 沙箱原语 | 0 | — |
| 隔离执行 | 0 | — |
| 资源限制 / cgroup | 0 | — |
| 网络出站策略 | 10 | `dsh-permission-rules`(5025)；`oh-my-knowledge`(3001)；`dsh-miopiik-run-stats`(2392) |

## 对照：已被占据或饱和的方向

| 方向 | 匹配包数 | 头部实现（月下载） |
|---|---:|---|
| 评测 / 回归 / 基准 | 51 | `dsh-browser`(6223)；`dsh-excel-chat`(3355)；`dsh-harbor-evolution`(3179) |
| 测试 / QA / 一致性 | 69 | `dsh-testkit`(3479)；`dsh-crew`(3293)；`oh-my-knowledge`(3001) |
| 快照 / 回滚 / 时间机器 | 95 | `@morlay/session-rdb`(27677)；`@morlay/session-branch`(25568)；`@morlay/ui-conversation-message-actions`(21719) |
| 记忆 / 上下文 | 185 | `dsh-mnemon`(33077)；`dsh-memory-eternal`(15025)；`@furongjun1999/dsh-memory`(7684) |
| 成本 / 用量 / 余额 | 388 | `dsh-cost-meter`(47037)；`@kenz1117/dsh-ui-usage-billing`(17506)；`dsh-whale-widget`(17082) |
| 主题 / 皮肤 / 桌宠 / 挂件 | 240 | `dsh-dream-skin`(26000)；`dsh-quant`(18855)；`dsh-pet`(17235) |
| 视觉 / 多模态 | 245 | `dsh-memory-eternal`(15025)；`dsh-codex-subscription`(12238)；`@goodandready/dsh-vision-bridge`(10596) |
| IM 渠道接入 | 77 | `@xmanrui/dsh-im`(38045)；`dsh-lark-bot`(14146)；`@wenbin_wb/dsh-bridge`(12820) |
| 插件供应链安全 | 40 | `upstream-radar`(15589)；`correctover`(2955)；`dsh-memoir`(2474) |
| 浏览器 / 计算机使用 | 148 | `@morlay/ui-conversation-message-actions`(21719)；`dsh-builtin-browser`(13052)；`@wxg-prc-cpg/browser-skill-dsh-plugin`(7322) |

## 其他被考察并排除的方向

| 方向 | 匹配包数 | 头部实现（月下载） |
|---|---:|---|
| 多租户 / RBAC / SSO | 4 | `dsh-teams`(432)；`dsh-oauth-newapi`(364)；`@eduwork/dsh-oidc`(301) |
| 凭据 / 钥匙串后端 | 2 | `@dsh-enhanced/credentials-keychain`(444)；`dsh-codex-keychain`(197) |
| 对象存储后端 | 1 | `dsh-webfile`(435) |
| 数据库后端 | 16 | `dsh-sql`(1084)；`dsh-plugin-nlbi`(873)；`dsh-data-insight`(515) |
| 无障碍 a11y | 18 | `@kubor/dsh-bloom-theme`(4630)；`dsh-click`(2159)；`dsh-theme-plugin`(1893) |
| 完整本地化 / 语言包 | 9 | `@goodandready/dsh-russian-lang`(6369)；`dsh-harness-zh-cn`(1129)；`dsh-plugin-width-slider`(1022) |

## 判定指引

- 匹配数低**且**头部命中项与方向语义不符（例如 docker 方向命中的是面板而非执行后端）→ 视为空位。
- 匹配数高或多个同族包（`@scope/*`）→ 视为已占据，不再具备先发优势。
