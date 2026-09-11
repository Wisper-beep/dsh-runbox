#!/usr/bin/env python3
"""抓取 DeepSeek Harness 插件生态全量元数据。

数据源：npm registry search API，关键词 dsh-plugin。
输出：ecosystem-snapshot-<date>.csv + ecosystem-raw.json

用法：
    python fetch_ecosystem.py [--keyword dsh-plugin] [--out .]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request

API = "https://registry.npmjs.org/-/v1/search"
PAGE = 250
UA = {"User-Agent": "dsh-ecosystem-research/1.0"}


def fetch_page(keyword: str, frm: int, tries: int = 4) -> dict | None:
    query = urllib.parse.urlencode(
        {"text": f"keywords:{keyword}", "size": PAGE, "from": frm}
    )
    url = f"{API}?{query}"
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - 网络抖动是预期内的
            print(f"  retry from={frm} attempt={attempt + 1}: {exc}", file=sys.stderr)
            time.sleep(2 + attempt * 3)
    return None


def collect(keyword: str) -> list[dict]:
    packages: list[dict] = []
    seen: set[str] = set()
    frm = 0
    total = None
    while True:
        page = fetch_page(keyword, frm)
        if not page:
            break
        if total is None:
            total = page.get("total")
            print(f"reported total: {total}")
        objects = page.get("objects", [])
        if not objects:
            break
        for obj in objects:
            meta = obj.get("package", {})
            name = meta.get("name")
            if not name or name in seen:
                continue
            seen.add(name)
            packages.append(
                {
                    "name": name,
                    "version": meta.get("version"),
                    "desc": meta.get("description", ""),
                    "keywords": meta.get("keywords", []),
                    "date": meta.get("date"),
                    "links": meta.get("links", {}),
                    "publisher": (meta.get("publisher") or {}).get("username"),
                    "downloads": (obj.get("downloads") or {}).get("monthly") or 0,
                }
            )
        print(f"from={frm:5d} -> {len(objects):3d} (cum {len(packages)})")
        frm += PAGE
        if total and frm >= total:
            break
        time.sleep(0.4)
    return packages


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keyword", default="dsh-plugin")
    ap.add_argument("--out", default=".")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    packages = collect(args.keyword)
    if not packages:
        print("no data fetched", file=sys.stderr)
        return 1

    raw_path = os.path.join(args.out, "ecosystem-raw.json")
    with open(raw_path, "w", encoding="utf-8") as fh:
        json.dump(packages, fh, ensure_ascii=False, indent=1)

    today = dt.date.today().isoformat()
    csv_path = os.path.join(args.out, f"ecosystem-snapshot-{today}.csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            ["name", "version", "monthly_downloads", "published_date", "publisher", "repo", "description"]
        )
        for pkg in sorted(packages, key=lambda p: -p["downloads"]):
            writer.writerow(
                [
                    pkg["name"],
                    pkg["version"],
                    pkg["downloads"],
                    (pkg["date"] or "")[:10],
                    pkg["publisher"] or "",
                    pkg["links"].get("repository") or "",
                    (pkg["desc"] or "").replace("\n", " "),
                ]
            )

    print(f"saved {len(packages)} packages -> {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
