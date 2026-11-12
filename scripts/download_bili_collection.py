"""批量下载 B 站 UGC 合集（或单个视频）的完整视频文件。

与项目主流程不同：主流程只取音频用于转写，本脚本保存可播放的 mp4。

用法：
    .venv\\Scripts\\python.exe scripts/download_bili_collection.py BV1pV411J7qj --list
    .venv\\Scripts\\python.exe scripts/download_bili_collection.py BV1pV411J7qj
    .venv\\Scripts\\python.exe scripts/download_bili_collection.py BV1pV411J7qj 8 9
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.request
from pathlib import Path
from typing import Any

import imageio_ffmpeg
from yt_dlp import YoutubeDL

from bili_transcript.utils import sanitize_filename

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_ROOT = PROJECT_ROOT / "temp"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": "https://www.bilibili.com/",
}
_BV_RE = re.compile(r"BV[0-9A-Za-z]+")


def fetch_video_info(bvid: str) -> dict[str, Any]:
    url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
    request = urllib.request.Request(url, headers=HEADERS)
    payload: dict[str, Any] = json.loads(urllib.request.urlopen(request, timeout=20).read())
    if payload.get("code") != 0 or not isinstance(payload.get("data"), dict):
        raise RuntimeError(f"B 站接口异常：code={payload.get('code')} {payload.get('message')}")
    return payload["data"]


def collect_episodes(data: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    season = data.get("ugc_season") or {}
    episodes = [
        ep for section in season.get("sections", []) for ep in section.get("episodes", [])
    ]
    if episodes:
        return str(season.get("title") or data.get("title") or "B站合集"), episodes
    return str(data.get("title") or "B站视频"), [
        {
            "bvid": data.get("bvid"),
            "title": data.get("title"),
            "page": {"duration": data.get("duration") or 0},
        }
    ]


def download_one(index: int, total: int, episode: dict[str, Any], out_dir: Path) -> None:
    bvid = str(episode["bvid"])
    name = sanitize_filename(str(episode.get("title") or bvid))[:80]
    target = out_dir / f"{index:02d} - {name}.mp4"
    if target.is_file() and target.stat().st_size > 1_000_000:
        print(f"[{index:02d}/{total}] 已存在，跳过 {target.name}", flush=True)
        return

    print(f"[{index:02d}/{total}] 开始 {bvid} {name}", flush=True)
    options: dict[str, Any] = {
        "format": "bestvideo[vcodec^=avc1]+bestaudio/best",
        "merge_output_format": "mp4",
        "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
        "outtmpl": str(out_dir / f"{index:02d} - {name}.%(ext)s"),
        "http_headers": HEADERS,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "continuedl": True,
        "retries": 5,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 4,
    }
    try:
        with YoutubeDL(options) as ydl:
            ydl.download([f"https://www.bilibili.com/video/{bvid}/"])
    except Exception as exc:  # noqa: BLE001
        print(f"  失败：{type(exc).__name__} {str(exc)[:200]}", flush=True)
        return

    if target.is_file():
        print(f"  完成 {target.stat().st_size / 1048576:.1f} MB", flush=True)
    else:
        print(f"  产物：{[p.name for p in out_dir.glob(f'{index:02d} - {name}.*')]}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="下载 B 站 UGC 合集（默认全部集数）")
    parser.add_argument("video", help="BV 号或 B 站视频 URL")
    parser.add_argument("episodes", nargs="*", help="只下载指定集数序号，如 1 3 8")
    parser.add_argument("--list", action="store_true", help="只列出合集清单，不下载")
    parser.add_argument("-o", "--output", default=None, help="输出目录（默认 temp/<合集名>）")
    args = parser.parse_args()

    match = _BV_RE.search(args.video)
    if not match:
        raise SystemExit("请输入 BV 号或包含 BV 号的 B 站链接")
    data = fetch_video_info(match.group(0))
    season_title, episodes = collect_episodes(data)
    print(f"合集：{season_title} | 共 {len(episodes)} 集", flush=True)

    if args.list:
        total_minutes = 0.0
        for index, episode in enumerate(episodes, start=1):
            minutes = float((episode.get("page") or {}).get("duration") or 0) / 60
            total_minutes += minutes
            print(f"{index:02d} | {episode.get('bvid')} | {minutes:.1f} min | {episode.get('title')}")
        print(f"合计约 {total_minutes:.0f} 分钟")
        return

    out_dir = Path(args.output) if args.output else DEFAULT_OUT_ROOT / sanitize_filename(season_title)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"输出目录：{out_dir}", flush=True)
    wanted = set(args.episodes)
    for index, episode in enumerate(episodes, start=1):
        if wanted and str(index) not in wanted:
            continue
        download_one(index, len(episodes), episode, out_dir)


if __name__ == "__main__":
    main()
