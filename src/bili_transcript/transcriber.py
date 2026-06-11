from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import cast

import imageio_ffmpeg
from faster_whisper import WhisperModel  # type: ignore[import-untyped]

from bili_transcript.config import SAMPLE_RATE
from bili_transcript.models import Segment


class TranscriptionError(RuntimeError):
    pass


def convert_to_wav(audio_path: Path, wav_path: Path) -> Path:
    if audio_path.resolve() == wav_path.resolve():
        return wav_path
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    wav_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg,
        "-y",
        "-i",
        str(audio_path),
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-vn",
        str(wav_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise TranscriptionError(result.stderr.strip() or "ffmpeg convert failed")
    return wav_path


def transcribe_audio(
    wav_path: Path,
    model_size: str,
    language: str,
    device: str,
    progress_callback: Callable[[float, int], None] | None = None,
) -> list[Segment]:
    try:
        model = WhisperModel(model_size, device="cpu" if device == "auto" else device)
        segments_iter, info = model.transcribe(
            str(wav_path),
            language=None if language == "auto" else language,
            vad_filter=True,
        )
    except Exception as exc:  # noqa: BLE001
        raise TranscriptionError(str(exc)) from exc

    total_duration = float(getattr(info, "duration", 0.0))
    segments: list[Segment] = []
    for segment in segments_iter:
        text = cast(str, segment.text).strip()
        if not text:
            continue
        start = float(cast(float, segment.start))
        end = float(cast(float, segment.end))
        segments.append(Segment(start=start, end=max(end, start), text=text))
        if progress_callback and total_duration > 0:
            progress = min(start / total_duration, 1.0)
            progress_callback(progress, len(segments))
    return segments
