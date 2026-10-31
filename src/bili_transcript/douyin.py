from __future__ import annotations

import json
import re
import shutil
import urllib.error
import urllib.request
from pathlib import Path

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
)
_HEADERS = {
    "User-Agent": _UA,
    "Referer": "https://www.douyin.com/",
    "Accept": "*/*",
}
_NUMERIC_ID_RE = re.compile(r"/(?:share/)?video/(\d+)")
_VIDEO_URI_PATTERNS = [
    re.compile(r'"play_addr":\{"uri":"([^"]+)"'),
    re.compile(r'"uri":"(v[0-9a-z]{10,})"'),
]
_DESC_RE = re.compile(r'"desc":"((?:[^"\\]|\\.)*)"')
_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)


class DouyinError(RuntimeError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _http_get(url: str, allow_redirects: bool = True, timeout: int = 15):
    request = urllib.request.Request(url, headers=_HEADERS)
    if allow_redirects:
        return urllib.request.urlopen(request, timeout=timeout)
    opener = urllib.request.build_opener(_NoRedirect())
    return opener.open(request, timeout=timeout)


def resolve_numeric_id(url: str) -> str | None:
    match = _NUMERIC_ID_RE.search(url)
    if match:
        return match.group(1)
    try:
        response = _http_get(url)
        match = _NUMERIC_ID_RE.search(response.geturl())
        return match.group(1) if match else None
    except Exception:  # noqa: BLE001
        return None


def fetch_share_html(numeric_id: str) -> str:
    share_url = f"https://www.iesdouyin.com/share/video/{numeric_id}/"
    try:
        response = _http_get(share_url)
        return response.read().decode("utf-8", errors="ignore")
    except Exception:  # noqa: BLE001
        return ""


def _extract_video_uri(html: str) -> str | None:
    for pattern in _VIDEO_URI_PATTERNS:
        match = pattern.search(html)
        if match:
            return match.group(1)
    return None


def _extract_title(html: str) -> str | None:
    match = _DESC_RE.search(html)
    if match:
        try:
            return json.loads(f'"{match.group(1)}"').strip() or None
        except ValueError:
            return match.group(1).strip() or None
    match = _TITLE_RE.search(html)
    if match:
        title = re.sub(r"\s*-\s*抖音$", "", match.group(1).strip())
        return title or None
    return None


def fetch_cdn_url(video_uri: str) -> str | None:
    """用 video_id 换 CDN 直链（v1/play 返回 302，Location 即直链）。"""
    play_url = f"https://aweme.snssdk.com/aweme/v1/play/?video_id={video_uri}&ratio=540p&line=0"
    try:
        response = _http_get(play_url, allow_redirects=False)
        content_type = str(response.headers.get("Content-Type", "")).lower()
        if response.status == 200 and "video" in content_type:
            return play_url
    except urllib.error.HTTPError as exc:
        if exc.code in (301, 302, 303, 307, 308):
            location = exc.headers.get("Location")
            if location:
                return location
    except Exception:  # noqa: BLE001
        pass
    return None


def download_direct(url: str, temp_dir: Path) -> tuple[Path, dict[str, object]]:
    """yt-dlp 撞抖音签名墙时的无登录直连兜底（仅公开视频）。"""
    numeric_id = resolve_numeric_id(url)
    if not numeric_id:
        raise DouyinError("无法解析抖音视频 ID（链接可能已删除或受异地限制）")

    html = fetch_share_html(numeric_id)
    video_uri = _extract_video_uri(html)
    if not video_uri:
        raise DouyinError("无法提取 video_id（私密/仅好友可见的视频不支持）")

    cdn_url = fetch_cdn_url(video_uri)
    if not cdn_url:
        raise DouyinError("未拿到 CDN 直链（抖音直连接口可能已失效）")

    temp_dir.mkdir(parents=True, exist_ok=True)
    media_path = temp_dir / f"{numeric_id}.mp4"
    try:
        request = urllib.request.Request(cdn_url, headers=_HEADERS)
        with urllib.request.urlopen(request, timeout=60) as response, open(media_path, "wb") as out:
            shutil.copyfileobj(response, out)
    except Exception as exc:  # noqa: BLE001
        raise DouyinError(f"抖音直连下载失败：{exc}") from exc
    if not media_path.is_file() or media_path.stat().st_size == 0:
        raise DouyinError("抖音直连下载得到空文件")

    title = _extract_title(html) or f"douyin_{numeric_id}"
    return media_path, {"id": numeric_id, "title": title}
