#!/usr/bin/env python3
"""拉取官方 DeepSeek Harness capability seam 的类型契约，供本地开发参考。

这些包是 dsh 官方发布在 npm 上的 seam 定义（MIT），本仓只下载不修改。
产物落在 reference/dsh-seams/（已在 .gitignore 中忽略），可随时重新生成。

用法：
    python scripts/fetch-seam-contracts.py            # 拉取 manifest 中的全部包
    python scripts/fetch-seam-contracts.py --list     # 只打印清单，不下载
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import tarfile
import urllib.parse
import urllib.request

# 本仓实现所依赖的官方 seam 包。版本留空表示取 latest。
MANIFEST: dict[str, str] = {
    "@deepseek-ai/dsh-subprocess": "",       # ctx.subprocess —— 进程 spawn
    "@deepseek-ai/dsh-fs": "",               # ctx.fs —— 文件能力
    "@deepseek-ai/dsh-shell": "",            # ctx.shell —— bash 执行器
    "@deepseek-ai/dsh-terminal": "",         # ctx.terminals —— 持久 PTY
    "@deepseek-ai/dsh-jobs": "",             # ctx.jobs —— 后台任务登记
    "@deepseek-ai/dsh-sandbox": "",          # ctx.sandbox —— 进程沙箱
    "@deepseek-ai/dsh-sandbox-policy": "",   # ctx.sandboxPolicy —— 逐调用策略
    "@deepseek-ai/dsh-sandbox-local": "",    # 官方本地后端（对照实现）
    "@deepseek-ai/dsh-subprocess-local": "",  # 官方本地子进程（对照实现）
}

REGISTRY = "https://registry.npmjs.org"
OUT_ROOT = os.path.join("reference", "dsh-seams")
UA = {"User-Agent": "dsh-runbox-seam-fetch/0.1"}


def _with_retry(fn, url: str, tries: int = 4):
    """registry 与 CDN 偶发 SSL EOF，重试比失败更划算。"""
    import time

    last: Exception | None = None
    for attempt in range(tries):
        try:
            return fn(url)
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 + attempt * 2.5)
    raise last  # type: ignore[misc]


def fetch_json(url: str) -> dict:
    def _do(u: str) -> dict:
        req = urllib.request.Request(u, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    return _with_retry(_do, url)


def fetch_bytes(url: str) -> bytes:
    def _do(u: str) -> bytes:
        req = urllib.request.Request(u, headers=UA)
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.read()

    return _with_retry(_do, url)


def esc(name: str) -> str:
    return urllib.parse.quote(name, safe="")


def resolve(name: str, version: str) -> dict:
    doc = fetch_json(f"{REGISTRY}/{esc(name)}")
    ver = version or doc["dist-tags"]["latest"]
    meta = doc["versions"][ver]
    return {
        "name": name,
        "version": ver,
        "tarball": meta["dist"]["tarball"],
        "license": meta.get("license", "?"),
        "description": (meta.get("description") or "").strip(),
    }


def extract(tarball: bytes, dest: str) -> list[str]:
    os.makedirs(dest, exist_ok=True)
    written: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            rel = member.name.split("/", 1)[1] if "/" in member.name else member.name
            if not rel or rel.startswith(".."):
                continue
            target = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with tf.extractfile(member) as src, open(target, "wb") as out:
                out.write(src.read())
            written.append(rel)
    return written


SYMBOL_RE = re.compile(
    r"^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?"
    r"(class|interface|type|enum|const|function|namespace)\s+([A-Za-z_$][\w$]*)",
    re.M,
)


def symbol_summary(pkg_dir: str) -> list[str]:
    found: list[str] = []
    for root, _dirs, files in os.walk(pkg_dir):
        for f in sorted(files):
            if not f.endswith(".d.ts"):
                continue
            path = os.path.join(root, f)
            text = open(path, encoding="utf-8", errors="replace").read()
            rel = os.path.relpath(path, pkg_dir).replace("\\", "/")
            names = sorted({f"{kind} {sym}" for kind, sym in SYMBOL_RE.findall(text)})
            if names:
                found.append(f"  - `{rel}`：{', '.join(names)}")
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只打印清单")
    ap.add_argument("--out", default=OUT_ROOT)
    args = ap.parse_args()

    if args.list:
        for name, ver in MANIFEST.items():
            print(f"{name}{'@' + ver if ver else ''}")
        return 0

    os.makedirs(args.out, exist_ok=True)
    index_lines = ["# 官方 seam 契约（本地参考，勿手改）", "",
                   "由 `scripts/fetch-seam-contracts.py` 生成，版权归 DeepSeek AI，MIT。", ""]
    resolved: dict[str, dict] = {}

    for name, ver in MANIFEST.items():
        short = name.split("/", 1)[1]
        try:
            info = resolve(name, ver)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! 解析失败 {name}: {exc}", file=sys.stderr)
            continue
        dest = os.path.join(args.out, short)
        try:
            files = extract(fetch_bytes(info["tarball"]), dest)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! 下载失败 {name}: {exc}", file=sys.stderr)
            continue
        resolved[name] = info
        dts = [f for f in files if f.endswith(".d.ts")]
        print(f"  ✓ {name}@{info['version']}  {len(files)} 个文件（{len(dts)} 个 .d.ts）")

        index_lines.append(f"## {name}@{info['version']}")
        index_lines.append("")
        index_lines.append(f"- 许可：{info['license']}")
        index_lines.append(f"- 描述：{info['description']}")
        index_lines.append("- 导出符号：")
        index_lines.extend(symbol_summary(dest) or ["  - （无 .d.ts）"])
        index_lines.append("")

    with open(os.path.join(args.out, "INDEX.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(index_lines))
    with open(os.path.join(args.out, "resolved.json"), "w", encoding="utf-8") as fh:
        json.dump(resolved, fh, ensure_ascii=False, indent=2)

    print(f"\n完成：{len(resolved)}/{len(MANIFEST)} 个包 → {args.out}/")
    print("建议在参考类型稳定后，把版本写回 MANIFEST 以锁定契约（dsh 处于预览期会破坏兼容）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
