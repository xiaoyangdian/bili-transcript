from __future__ import annotations

import re
import subprocess
import wave
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
    if model_size.lower() == "sensevoice":
        return _transcribe_sensevoice(wav_path, language, progress_callback)

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


_SV_TAG_RE = re.compile(r"(?:<\|[a-zA-Z_0-9]+\|>)+")


def _extract_sentences_from_sensevoice(text: str) -> list[str]:
    """把 SenseVoice 带标签的长文本拆成句子列表。"""
    parts = re.split(r"(?=<\|[a-zA-Z_0-9]+\|>)", text)
    sentences: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        clean = _SV_TAG_RE.sub("", part).strip()
        if not clean:
            continue
        # 按句子结束符切分，保留结束符在句尾
        subs = re.split(r"(?<=[。！？.?!])", clean)
        for s in subs:
            s = s.strip()
            if s:
                sentences.append(s)
    return sentences


def _get_wav_duration(wav_path: Path) -> float:
    try:
        with wave.open(str(wav_path), "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            return frames / float(rate) if rate else 0.0
    except Exception:
        return 0.0


def _transcribe_sensevoice(
    wav_path: Path,
    language: str,
    progress_callback: Callable[[float, int], None] | None = None,
) -> list[Segment]:
    try:
        from funasr import AutoModel
    except ImportError as exc:
        raise TranscriptionError(
            "SenseVoice 需要 funasr，请运行: uv pip install funasr"
        ) from exc

    try:
        model = AutoModel(
            model="iic/SenseVoiceSmall",
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": 30000},
            disable_pbar=True,
            disable_log=True,
        )
    except Exception as exc:
        raise TranscriptionError(f"加载 SenseVoice 模型失败: {exc}") from exc

    lang_map = {
        "auto": "auto",
        "zh": "zh",
        "en": "en",
        "ja": "ja",
        "ko": "ko",
        "yue": "yue",
    }
    sv_lang = lang_map.get(language, "auto")

    try:
        res = model.generate(
            input=str(wav_path),
            cache={},
            language=sv_lang,
            use_itn=True,
        )
    except Exception as exc:
        raise TranscriptionError(f"SenseVoice 转写失败: {exc}") from exc

    if not res:
        return []

    # 合并所有返回项的文本
    full_text = ""
    for item in res:
        if isinstance(item, dict):
            full_text += item.get("text", "")
        else:
            full_text += str(item)

    sentences = _extract_sentences_from_sensevoice(full_text)
    if not sentences:
        return []

    total_duration = _get_wav_duration(wav_path)
    total_chars = sum(len(s) for s in sentences)

    segments: list[Segment] = []
    current_time = 0.0
    for idx, sentence in enumerate(sentences):
        seg_dur = (len(sentence) / total_chars) * total_duration if total_chars else 0.0
        end_time = current_time + seg_dur
        segments.append(Segment(start=current_time, end=end_time, text=sentence))
        current_time = end_time
        if progress_callback and total_duration > 0:
            progress = min(current_time / total_duration, 1.0)
            progress_callback(progress, len(segments))

    return segments
