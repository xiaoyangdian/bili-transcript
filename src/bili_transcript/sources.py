from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from bili_transcript.utils import sanitize_filename


class SourceError(RuntimeError):
    pass


@dataclass(frozen=True)
class MediaSource:
    """解析后的输入来源。"""

    kind: str  # bilibili / douyin / generic / local
    url: str  # 规范化后的链接，本地文件为绝对路径
    video_id: str
    platform: str  # 展示用平台名


_URL_RE = re.compile(r"https?://[^\s]+")
_BV_RE = re.compile(r"BV[0-9A-Za-z]+")
_DOUYIN_VIDEO_ID_RE = re.compile(r"/video/(\d+)")
_TRAILING_CHARS = "，。！？、,.!?)]}】\"'…"

_BILIBILI_HOSTS = ("bilibili.com", "b23.tv")
_DOUYIN_HOSTS = ("douyin.com", "iesdouyin.com")


def _find_url(text: str) -> str | None:
    match = _URL_RE.search(text)
    if match is None:
        return None
    return match.group(0).rstrip(_TRAILING_CHARS)


def _host(url: str) -> str:
    return urlparse(url).netloc.lower()


def _matches(host: str, names: tuple[str, ...]) -> bool:
    return any(name in host for name in names)


def _url_tail(url: str) -> str:
    tail = urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]
    return sanitize_filename(tail or _host(url))


def resolve_source(value: str) -> MediaSource:
    """把用户输入解析成可处理的来源；无法识别时抛 SourceError。"""
    text = (value or "").strip().strip('"').strip("'")
    if not text:
        raise SourceError("请输入视频链接、BV 号，或本地音视频文件路径")

    path = Path(text).expanduser()
    if not text.lower().startswith(("http://", "https://")) and path.is_file():
        return MediaSource(
            kind="local",
            url=str(path.resolve()),
            video_id=sanitize_filename(path.stem),
            platform="本地文件",
        )

    url = _find_url(text)
    if url is None:
        # 允许直接粘贴裸 BV 号或夹带分享文案的 BV 号
        bv_match = _BV_RE.search(text)
        if bv_match:
            video_id = bv_match.group(0)
            return MediaSource(
                kind="bilibili",
                url=f"https://www.bilibili.com/video/{video_id}/",
                video_id=video_id,
                platform="B站",
            )
        raise SourceError("无法识别输入：请提供 B 站/抖音链接，或本地音视频文件路径")

    bv_match = _BV_RE.search(url)
    if bv_match:
        video_id = bv_match.group(0)
        return MediaSource(
            kind="bilibili",
            url=f"https://www.bilibili.com/video/{video_id}/",
            video_id=video_id,
            platform="B站",
        )

    host = _host(url)
    if _matches(host, _DOUYIN_HOSTS):
        id_match = _DOUYIN_VIDEO_ID_RE.search(url)
        video_id = id_match.group(1) if id_match else _url_tail(url)
        return MediaSource(kind="douyin", url=url, video_id=video_id, platform="抖音")

    if _matches(host, _BILIBILI_HOSTS):
        return MediaSource(kind="generic", url=url, video_id=_url_tail(url), platform="B站")

    return MediaSource(kind="generic", url=url, video_id=_url_tail(url), platform=_host(url) or "通用链接")
