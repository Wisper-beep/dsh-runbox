# research — 生态调研证据

本目录是选题决策的**原始证据**，不是结论。结论见 [`../docs/01-选题提案.md`](../docs/01-选题提案.md)。

## 文件

| 文件 | 内容 |
|---|---|
| `ecosystem-snapshot-2026-09-11.csv` | 4646 个 dsh 插件的全量快照（名称、版本、月下载、发布日期、作者、仓库、描述），按下载降序 |
| `ecosystem-raw.json` | 同上，保留原始 JSON 结构，供脚本消费 |
| `ecosystem-stats.json` | 汇总统计 + 各方向密度探测结果 |
| `gap-report.md` | 由 `scripts/probe_gaps.py` 生成的方向密度报告（**结论的主要依据**） |
| `scripts/fetch_ecosystem.py` | 抓取脚本：npm registry search API 全量分页 |
| `scripts/probe_gaps.py` | 探测脚本：正则密度分析 → `gap-report.md` |

## 数据源与口径

- 数据源：npm registry 官方 search API，查询 `keywords:dsh-plugin`
- 抓取日期：2026-09-11
- 口径说明：`monthly_downloads` 取自 npm 返回的 `downloads.monthly`
- 已知局限：
  - 只覆盖**发布到 npm** 的插件。仅发布在 GitHub、未上 npm 的插件不在样本内（`dsh-plugin` topic 下存在此类仓库）。
  - npm 下载量包含 CI 与镜像流量，不等于真实用户数；**只用于横向比较相对热度**，不用于绝对判断。
  - "匹配包数"是正则密度指标，**不等于有效实现数**——必须结合头部命中项逐个人工核对（`gap-report.md` 里已把头部实现一并列出，便于核对）。

## 复现

```bash
# 1) 重新抓取全量快照（约 19 次分页请求）
python scripts/fetch_ecosystem.py --keyword dsh-plugin --out ..

# 2) 重新生成方向密度报告
python scripts/probe_gaps.py --raw ../ecosystem-raw.json --out ../gap-report.md
```

两个脚本只依赖标准库，无需安装任何第三方包。

## 怎么读 `gap-report.md`

判定空位的规则是**两条同时成立**：

1. 匹配包数低（个位数到十几）；
2. 头部命中项与方向语义**不符**——例如 `docker` 方向命中的是「Docker 微面板」而不是执行后端。

只满足第 1 条不算空位：`podman` 匹配 0，可能只是因为没人用这个词，而不是因为没需求。本仓选定方向同时满足了两条，且有官方文档背书（详见提案第 2 节）。
