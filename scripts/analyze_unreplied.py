#!/usr/bin/env python3
"""分析抖音楼层导出 JSON：谁给「我」发过消息但「我」还没回复。

用法：
    python scripts/analyze_unreplied.py [导出.json]

不传参数时，自动取当前目录下最新的 *_2026-*.json / 含 floor+replies 的 json。
"""

import json
import sys
from pathlib import Path

# Windows 控制台默认 GBK，打不出 emoji/中文，强制 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def normalize(s):
    return str(s or "").strip()


def find_latest_export(root: Path):
    candidates = [
        p for p in root.glob("*.json")
        if p.name != "manifest.json"
        and ("floor" in p.read_text(encoding="utf-8", errors="ignore")[:2000])
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def load(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if "floor" not in data or "replies" not in data:
        raise ValueError("不是楼层导出 JSON（缺 floor / replies）")
    return data


def analyze(data):
    me = normalize(data["floor"].get("author"))
    replies = data.get("replies") or []

    inbound = {}
    outbound_to = set()

    for r in replies:
        author = normalize(r.get("author"))
        to = normalize(r.get("replyTo"))
        if not author or author == me:
            if author == me and to and to != me:
                outbound_to.add(to)
            continue
        # 别人发给「我」：replyTo 为空（直接回楼层）或明确指向我
        if to == "" or to == me:
            inbound.setdefault(author, []).append(r)

    unreplied = {who: items for who, items in inbound.items() if who not in outbound_to}

    return {
        "me": me,
        "inbound": inbound,
        "outbound_to": outbound_to,
        "unreplied": unreplied,
    }


def brief(text, limit=70):
    t = " ".join(str(text or "").split())
    return t if len(t) <= limit else t[:limit] + "…"


def main():
    root = Path(__file__).resolve().parent.parent
    if len(sys.argv) > 1:
        path = Path(sys.argv[1]).expanduser().resolve()
    else:
        path = find_latest_export(root)
        if not path:
            print("没找到楼层导出 JSON，请传文件路径。")
            return
    data = load(path)
    res = analyze(data)

    print(f"我：{res['me']}")
    print(f"给我发过消息的人：{len(res['inbound'])}")
    print(f"我回复过的人：{len(res['outbound_to'])}")
    print(f"未回复：{len(res['unreplied'])}")
    print("=" * 60)

    if not res["unreplied"]:
        print("没有未回复的人。")
        return

    for who, items in res["unreplied"].items():
        print(f"\n● {who}  （{len(items)} 条未回）")
        for r in items[-3:]:
            to = normalize(r.get("replyTo"))
            target = "我" if to == "" or to == res["me"] else to
            print(f"   [{r.get('time', '')}] → {target}: {brief(r.get('text'))}")


if __name__ == "__main__":
    main()
