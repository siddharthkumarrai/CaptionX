"""
app/services/transcription.py
==============================
WhisperX pipeline — word-level transcription + alignment.
MUST run inside a Celery worker (blocking GPU call).
Never call directly from FastAPI async endpoint.
"""
import os
import tempfile
import torch
import whisperx
from typing import List, Dict
from app.core.config import settings


def _resolve_device():
    if settings.WHISPER_DEVICE == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return settings.WHISPER_DEVICE


def _resolve_compute_type(device: str):
    if settings.WHISPER_COMPUTE_TYPE == "auto":
        return "float16" if device == "cuda" else "int8"
    return settings.WHISPER_COMPUTE_TYPE


def transcribe_audio(audio_path: str, language: str = "auto") -> List[Dict]:
    """
    Full WhisperX pipeline: transcription → forced alignment.

    Returns flat word list:
    [{"word": str, "start": float, "end": float, "score": float, "segment_id": int}]

    Raises:
        RuntimeError: if no words with valid timestamps are found.
    """
    device = _resolve_device()
    compute_type = _resolve_compute_type(device)
    lang = None if language == "auto" else language

    # ── Step 1: Whisper transcription ─────────────────────────────────────────
    model = whisperx.load_model(
        settings.WHISPER_MODEL,
        device,
        compute_type=compute_type,
        language=lang,
    )
    audio = whisperx.load_audio(audio_path)
    result = model.transcribe(audio, batch_size=16)

    # Free GPU memory before alignment model loads
    del model
    if device == "cuda":
        torch.cuda.empty_cache()

    # ── Step 2: Forced word-level alignment ───────────────────────────────────
    detected_lang = result.get("language", lang or "en")
    align_model, metadata = whisperx.load_align_model(
        language_code=detected_lang,
        device=device,
    )
    result = whisperx.align(
        result["segments"],
        align_model,
        metadata,
        audio,
        device,
        return_char_alignments=False,
    )

    del align_model
    if device == "cuda":
        torch.cuda.empty_cache()

    # ── Step 3: Flatten to word list ──────────────────────────────────────────
    words = []
    for seg_idx, segment in enumerate(result.get("segments", [])):
        for word_data in segment.get("words", []):
            # Skip words without alignment (common for numbers, punctuation)
            if "start" not in word_data or "end" not in word_data:
                continue
            # Skip very low confidence (likely hallucination)
            score = word_data.get("score", 0.0)
            if score < 0.3:
                continue
            words.append({
                "word": word_data["word"].strip(),
                "start": round(float(word_data["start"]), 4),
                "end": round(float(word_data["end"]), 4),
                "score": round(float(score), 4),
                "segment_id": seg_idx,
            })

    if not words:
        raise RuntimeError(
            f"No aligned words found. Language detected: {detected_lang}. "
            "Check that the audio has speech and language is supported."
        )

    return words


def group_words_into_phrases(words: List[Dict], mode: str = "two_words") -> List[Dict]:
    """
    Groups flat word list into caption display phrases.

    mode options:
      "one_word"    — each word is its own phrase
      "two_words"   — pairs of words (most popular for social/Shorts)
      "full_phrase" — full WhisperX segment as one phrase

    Returns:
    [{
        "phrase": str,
        "words": List[Dict],   # subset of input words
        "start": float,
        "end": float,
        "duration": float,
    }]
    """
    if not words:
        return []

    phrases = []

    if mode == "one_word":
        for w in words:
            phrases.append({
                "phrase": w["word"],
                "words": [w],
                "start": w["start"],
                "end": w["end"],
                "duration": round(w["end"] - w["start"], 4),
            })

    elif mode == "two_words":
        for i in range(0, len(words), 2):
            chunk = words[i : i + 2]
            phrases.append({
                "phrase": " ".join(c["word"] for c in chunk),
                "words": chunk,
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
                "duration": round(chunk[-1]["end"] - chunk[0]["start"], 4),
            })

    elif mode == "full_phrase":
        from itertools import groupby
        for _, group in groupby(words, key=lambda w: w["segment_id"]):
            chunk = list(group)
            if not chunk:
                continue
            phrases.append({
                "phrase": " ".join(c["word"] for c in chunk),
                "words": chunk,
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
                "duration": round(chunk[-1]["end"] - chunk[0]["start"], 4),
            })

    else:
        raise ValueError(f"Unknown caption mode: {mode!r}. Use one_word/two_words/full_phrase")

    return phrases
