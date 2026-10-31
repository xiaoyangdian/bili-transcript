---
name: fetching-bilibili-transcripts
description: Fetch video transcripts (字幕/文字稿) using the bili-transcript CLI tool. Use when the user wants to extract text from a Bilibili or Douyin video, transcribe a local video/audio file, get a video's subtitles/transcript, mentions "B站字幕", "抖音文案", "视频转文字", "bilibili transcript", "BV号转文字", or asks to read/watch a video's content as text. Supports subtitle extraction plus Whisper/SenseVoice audio transcription.
---

# Fetching Video Transcripts

Retrieve text transcripts from Bilibili / Douyin videos, or from local media files, using the `bili-transcript` CLI tool (alias: `bt`).

## When to Use

- User wants text content from a Bilibili video URL, BV号, Douyin share link, or local video/audio file
- User mentions "B站字幕", "抖音文案", "视频转文字", "bilibili transcript"
- User asks to read/analyze a video's content as text

## Prerequisites

The tool requires:
1. **uv** - Python package manager (https://docs.astral.sh/uv/)
2. **ffmpeg** - System dependency for audio conversion
3. **faster-whisper** - Auto-installed via `uv sync` for audio transcription
4. **Cookies** - Bilibili requires browser cookies for access; default reads from Chrome

Install project dependencies:

```bash
cd /Users/chenenci/Personal/bili-transcript && uv sync
```

Verify ffmpeg is available:

```bash
ffmpeg -version
```

## Quick Start

```bash
cd /Users/chenenci/Personal/bili-transcript && uv run bili-transcript "BV1w7NTzXEqQ"
```

Or with full URL:

```bash
cd /Users/chenenci/Personal/bili-transcript && uv run bili-transcript "https://www.bilibili.com/video/BV1w7NTzXEqQ/"
```

Douyin share link (share text works too, the URL is extracted automatically):

```bash
uv run bili-transcript "https://v.douyin.com/xxxx/"
```

Local video/audio file (skips download entirely):

```bash
uv run bili-transcript "D:\\video.mp4"
```

The tool outputs files to `./output/` by default with three formats: `.txt`, `.srt`, `.json`.

## How It Works

1. **Parse input** — Accepts BV号 (e.g., `BV1w7NTzXEqQ`), Bilibili/Douyin URL, Douyin share text, or a local file path
2. **Fetch video info** — Uses yt-dlp with browser cookies
3. **Try platform subtitles** — Extracts existing subtitles when the platform provides them (B站优先)
4. **Fallback to Whisper** — Otherwise downloads audio (Douyin falls back to a no-login direct link when yt-dlp hits the signature wall) and transcribes with faster-whisper
5. **Export files** — Generates txt/srt/json in output directory

## Output Formats

- **txt** — Plain text, no timestamps (适合阅读)
- **srt** — SubRip format with timestamps (适合字幕叠加)
- **json** — Structured data with metadata + segments (适合程序处理)

JSON structure: `{ "meta": { "video_id", "title", "source_url", "duration", "uploader", "subtitle_source" }, "segments": [ { "start", "end", "text" } ] }`

## Common Commands

```bash
# Only txt output (最简)
uv run bili-transcript "BV1w7NTzXEqQ" -f txt

# Custom output directory
uv run bili-transcript "BV1w7NTzXEqQ" -o ./my-output

# Force Whisper transcription (忽略B站字幕)
uv run bili-transcript "BV1w7NTzXEqQ" --force-whisper

# Specify Whisper model size
uv run bili-transcript "BV1w7NTzXEqQ" -m small

# Use cookies from a different browser
uv run bili-transcript "BV1w7NTzXEqQ" --cookies-from-browser firefox
```

## Important Notes

- Always `cd /Users/chenenci/Personal/bili-transcript` before running commands
- The short alias `bt` can be used instead of `bili-transcript`
- Cookies from browser are needed for most videos; default is `chrome`
- If cookie extraction fails, try specifying your browser explicitly with `--cookies-from-browser`
- Whisper transcription is slow; prefer letting the tool extract existing subtitles first

## Reading Output

After running the tool, read the output file to provide transcript content to the user:

```bash
# Read plain text transcript
cat output/视频标题.txt

# Or use the read_file tool on the json for structured data
```

## Troubleshooting

For detailed CLI parameters and troubleshooting, see [references/cli-reference.md](references/cli-reference.md).