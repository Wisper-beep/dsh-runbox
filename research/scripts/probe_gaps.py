#!/usr/bin/env python3
"""对生态快照做方向密度探测，找出"官方点名但社区零占位"的空位。

输入：fetch_ecosystem.py 产出的 ecosystem-raw.json
输出：gap-report.md

用法：
    python probe_gaps.py [--raw ecosystem-raw.json] [--out gap-report.md]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
from typing import Iterable

# 方向 -> 正则。分组只为报告可读性，语义无差别。
GROUPS: dict[str, dict[str, str]] = {
    "执行地基 / 隔离（本仓选定方向）": {
        "docker 相关": r"docker",
        "podman": r"podman",
        "容器化沙箱后端": r"container sandbox|沙箱后端|sandbox backend|sandbox provider",
        "microVM / gVisor / Firecracker / Kata": r"microvm|gvisor|firecracker|kata|lima",
        "Windows 沙箱原语": r"windows sandbox|appcontainer|job object|restricted token|受限令牌",
        "隔离执行": r"isolated execution|isolat.*exec|隔离执行|隔离运行",
        "资源限制 / cgroup": r"cgroup|rlimit|cpu limit|内存限制|资源限制",
        "网络出站策略": r"network policy|egress|出网|网络隔离",
    },
    "对照：已被占据或饱和的方向": {
        "评测 / 回归 / 基准": r"\beval|评测|评估|benchmark|regression|golden|rubric",
        "测试 / QA / 一致性": r"\btest|flake|conform|acceptance",
        "快照 / 回滚 / 时间机器": r"checkpoint|rewind|rollback|snapshot|time machine|回滚|快照",
        "记忆 / 上下文": r"memory|记忆|agent-memory",
        "成本 / 用量 / 余额": r"cost|usage|balance|token|费用|用量|余额",
        "主题 / 皮肤 / 桌宠 / 挂件": r"theme|skin|壁纸|wallpaper|桌宠|\bpet\b|widget|挂件",
        "视觉 / 多模态": r"vision|image|ocr|多模态|识图",
        "IM 渠道接入": r"feishu|lark|dingtalk|telegram|wechat|微信|钉钉|飞书|slack",
        "插件供应链安全": r"supply.?chain|provenance|sbom|cve|poison|供应链",
        "浏览器 / 计算机使用": r"browser|playwright|computer use|computer-use",
    },
    "其他被考察并排除的方向": {
        "多租户 / RBAC / SSO": r"multi.?user|\brbac\b|\bsso\b|oidc|login wall|多用户",
        "凭据 / 钥匙串后端": r"keychain|keyring|credential manager|密码管理器|libsecret",
        "对象存储后端": r"\bs3\b|minio|\br2\b|对象存储",
        "数据库后端": r"redis|mongodb|postgres|mysql|duckdb",
        "无障碍 a11y": r"a11y|accessib|无障碍|wcag",
        "完整本地化 / 语言包": r"localization|localisation|语言包|locale pack",
    },
}


def blob(pkg: dict) -> str:
    return " ".join(
        [pkg.get("name", ""), pkg.get("desc") or "", " ".join(pkg.get("keywords") or [])]
    )


def probe(packages: Iterable[dict], pattern: str) -> list[dict]:
    rx = re.compile(pattern, re.I)
    hits = [p for p in packages if rx.search(blob(p))]
    return sorted(hits, key=lambda p: -(p.get("downloads") or 0))


def build_report(packages: list[dict]) -> str:
    dates = sorted((p.get("date") or "")[:10] for p in packages if p.get("date"))
    downloads = sorted([(p.get("downloads") or 0) for p in packages], reverse=True)
    total = sum(downloads) or 1

    out: list[str] = []
    add = out.append
    add("# 生态空白核验报告")
    add("")
    add(f"> 生成时间：{dt.date.today().isoformat()} ｜ 方向密度探测，全部数字可在 CSV 快照中复核")
    add("")
    add("## 生态总量")
    add("")
    add(f"- 包总数：**{len(packages)}**")
    add(f"- 时间跨度：**{dates[0]} → {dates[-1]}**" if dates else "- 时间跨度：—")
    add(f"- 累计月下载：**{total:,}**")
    zeros = sum(1 for d in downloads if d == 0)
    add(f"- 零下载包：**{zeros}**（{zeros / max(len(packages), 1) * 100:.1f}%）")
    add(f"- 下载集中度：Top10 **{sum(downloads[:10]) / total * 100:.1f}%** ｜ Top100 **{sum(downloads[:100]) / total * 100:.1f}%**")
    add("")

    for group, patterns in GROUPS.items():
        add(f"## {group}")
        add("")
        add("| 方向 | 匹配包数 | 头部实现（月下载） |")
        add("|---|---:|---|")
        for label, pattern in patterns.items():
            hits = probe(packages, pattern)
            top = "；".join(f"`{h['name']}`({h.get('downloads') or 0})" for h in hits[:3]) or "—"
            add(f"| {label} | {len(hits)} | {top} |")
        add("")

    add("## 判定指引")
    add("")
    add("- 匹配数低**且**头部命中项与方向语义不符（例如 docker 方向命中的是面板而非执行后端）→ 视为空位。")
    add("- 匹配数高或多个同族包（`@scope/*`）→ 视为已占据，不再具备先发优势。")
    add("")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="ecosystem-raw.json")
    ap.add_argument("--out", default="gap-report.md")
    args = ap.parse_args()

    if not os.path.exists(args.raw):
        print(f"missing {args.raw}; run fetch_ecosystem.py first")
        return 1
    packages = json.load(open(args.raw, encoding="utf-8"))
    report = build_report(packages)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(report)
    print(f"written {args.out} ({len(packages)} packages analysed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
