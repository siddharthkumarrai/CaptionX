"""
app/services/transcription.py
==============================
WhisperX pipeline — word-level transcription + alignment.
MUST run inside a Celery worker (blocking GPU call).
Never call directly from FastAPI async endpoint.

Why this module is more than a thin WhisperX wrapper
----------------------------------------------------
WhisperX 3.x *always* runs its bundled pyannote VAD before decoding and the
first speech chunk begins at the first VAD trigger::

    vad_segments = self.vad_model({...})
    vad_segments = merge_chunks(vad_segments, chunk_size,
                               onset=self._vad_params["vad_onset"],   # default 0.500
                               offset=self._vad_params["vad_offset"]) # default 0.363

Every sample *before* that trigger is never handed to the acoustic model, so a
quiet or faded intro (soft opening words, music bed under speech) silently
loses the first words — typically reported as "transcription starts at 0.77 s
and the opening is missing".

Four layers of defence are implemented here:

1. ``_vad_options`` lowers the VAD onset/offset so soft speech opens a region.
2. ``_ffmpeg_normalized_copy`` loudness-normalises (``dynaudnorm``) the audio so
   a quiet intro reaches the detector at a normal level without shifting time.
3. ``_recover_head`` / ``_recover_tail`` re-decode the head and tail *without*
   the VAD (faster-whisper ``vad_filter=False``) and merge them back with
   correct absolute timestamps.
4. ``_align_words`` falls back to proportional (segment-level) word timing if
   forced alignment fails, so words are never dropped just because the language
   has no alignment model.
"""
import logging
import os
import shutil
import subprocess
import tempfile
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
import whisperx

from app.core.config import settings
from app.services.hardware import HardwareProfile, detect_hardware

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
MIN_SAMPLES = SAMPLE_RATE // 4  # < 250 ms of audio cannot be transcribed usefully


def _resolve_device(hw: HardwareProfile):
    """Backward-compat shim returning (device, load_opts) from the profile."""
    opts = {"device": hw.device}
    if hw.device == "cpu" and hw.threads:
        opts["threads"] = hw.threads
    return hw.device, opts


def _resolve_compute_type(hw: HardwareProfile) -> str:
    return hw.compute_type


# ── Audio preparation ─────────────────────────────────────────────────────────

def _ffmpeg_normalized_copy(path: str) -> Optional[str]:
    """Loudness-normalise + high-pass the source into a 16 kHz mono WAV.

    ``dynaudnorm`` lifts quiet passages (a faded-in speaker, speech under a
    music bed) to a normal level *without touching timing*, which is what makes
    the VAD open on the very first syllable. Timestamps therefore still line up
    with the original video frame-for-frame.

    Returns ``None`` when ffmpeg is unavailable, disabled, or fails — the caller
    then simply decodes the original file.
    """
    if not getattr(settings, "WHISPER_NORMALIZE_AUDIO", True):
        return None
    if not shutil.which("ffmpeg"):
        logger.info("ffmpeg not found — skipping audio normalisation")
        return None

    fd, out_path = tempfile.mkstemp(prefix="captionx-norm-", suffix=".wav")
    os.close(fd)
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", path,
        "-vn",
        "-af", "highpass=f=60,dynaudnorm=f=250:g=15:p=0.95:m=20",
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-c:a", "pcm_s16le",
        out_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=1800)
        if proc.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            logger.warning(
                "Audio normalisation failed (rc=%s): %s",
                proc.returncode,
                proc.stderr.decode("utf-8", "ignore")[:200],
            )
            _safe_unlink(out_path)
            return None
        return out_path
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Audio normalisation error: %s", exc)
        _safe_unlink(out_path)
        return None


def _safe_unlink(path: Optional[str]) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except Exception:
        pass


def _sanitize_waveform(audio: np.ndarray) -> np.ndarray:
    """Flatten to mono float32, remove DC offset and peak-normalise.

    A silent/hushed source is the single most common cause of "the first words
    are missing", so normalising here (in addition to the ffmpeg pass) gives the
    model a consistent, healthy signal level.
    """
    if audio is None:
        raise RuntimeError("Audio decode produced no samples. Is the file a valid media file?")

    wav = np.asarray(audio, dtype=np.float32).reshape(-1)
    if wav.size == 0:
        raise RuntimeError("Decoded audio is empty — the uploaded file has no audio track.")

    wav = np.nan_to_num(wav, nan=0.0, posinf=0.0, neginf=0.0)
    wav = wav - float(wav.mean())

    peak = float(np.abs(wav).max()) if wav.size else 0.0
    if peak > 1.0:
        wav = wav / peak
        peak = 1.0
    if 1e-6 < peak < 0.97:
        wav = (wav / peak) * 0.97

    return np.ascontiguousarray(wav, dtype=np.float32)


def _load_audio(path: str) -> np.ndarray:
    """Decode + normalise the source into a float32 mono 16 kHz waveform."""
    normalized = _ffmpeg_normalized_copy(path)
    source = normalized or path
    try:
        audio = whisperx.load_audio(source)
    finally:
        _safe_unlink(normalized)

    wav = _sanitize_waveform(audio)
    if wav.size < MIN_SAMPLES:
        raise RuntimeError(
            f"Audio too short to transcribe ({wav.size / SAMPLE_RATE:.2f}s)."
        )
    logger.info(
        "Audio ready: %.2fs @ %d Hz (normalised=%s)",
        wav.size / SAMPLE_RATE,
        SAMPLE_RATE,
        bool(normalized),
    )
    return wav


# ── WhisperX options ──────────────────────────────────────────────────────────

def _asr_options() -> Dict:
    """Only keys that exist in WhisperX's ``default_asr_options`` are sent."""
    return {
        "beam_size": 5,
        "best_of": 5,
        "temperatures": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        "condition_on_previous_text": False,  # prevents repeat/hallucination loops
        "compression_ratio_threshold": 2.4,
        "log_prob_threshold": -1.0,
        "no_speech_threshold": 0.6,
        # Word timings come from WhisperX forced alignment, not the decoder.
        "without_timestamps": True,
        "initial_prompt": None,
    }


def _vad_options() -> Dict:
    """Lower the pyannote onset/offset so soft opening speech is not skipped."""
    return {
        "vad_onset": float(getattr(settings, "WHISPER_VAD_ONSET", 0.30)),
        "vad_offset": float(getattr(settings, "WHISPER_VAD_OFFSET", 0.20)),
    }


# ── Token / timing helpers ────────────────────────────────────────────────────

_NOISE_CHARS = "\"'“”‘’([{)]}<>*_-,.;:!?…·•|~`^/\\’ʼ"


def _is_artifact(token: str) -> bool:
    """True for alignment fillers (``<unk>``, ``[...]``) and punctuation-only tokens."""
    tok = (token or "").strip()
    if not tok:
        return True
    if tok.startswith("<") and tok.endswith(">"):
        return True
    if tok.startswith("[") and tok.endswith("]"):
        return True
    return not tok.strip(_NOISE_CHARS)


def _normalize_token(token: str) -> str:
    return "".join(ch for ch in (token or "").lower() if ch.isalnum())


def _frame_levels(audio: np.ndarray, frame_sec: float = 0.02):
    """Per-frame dB levels + voice-detection threshold for the waveform.

    Returns ``(db, frame_dur, threshold)`` — ``(None, frame_dur, None)`` when
    the audio is too short. The threshold (noise floor + 10 dB, clamped to
    [-55, -40]) is shared by the onset detector and the gap scanner so both
    agree on what counts as voice.
    """
    frame = max(1, int(SAMPLE_RATE * frame_sec))
    frame_dur = frame / SAMPLE_RATE
    try:
        usable = (audio.size // frame) * frame
        if usable < frame * 10:
            return None, frame_dur, None
        rms = np.sqrt(
            np.mean(np.square(audio[:usable].reshape(-1, frame)), axis=1) + 1e-12
        )
        db = 20.0 * np.log10(rms + 1e-12)
        floor = float(np.percentile(db, 20))
        threshold = min(max(floor + 10.0, -55.0), -40.0)
        return db, frame_dur, threshold
    except Exception:  # pragma: no cover - defensive
        return None, frame_dur, None


def _first_voice_time(audio: np.ndarray, frame_sec: float = 0.02) -> Optional[float]:
    """Absolute time of the first sustained voice in the raw waveform.

    Uses a noise floor derived from the quietest 20 % of frames, so it adapts to
    both hot and very quiet recordings. A short run-length requirement (100 ms)
    stops a single click from being mistaken for speech.
    """
    try:
        db, frame_dur, threshold = _frame_levels(audio, frame_sec)
        if db is None:
            return None
        active = db >= threshold

        run = 0
        for i, is_active in enumerate(active):
            run = run + 1 if is_active else 0
            if run >= 5:
                return round((i - run + 1) * frame_dur, 4)
        return None
    except Exception:  # pragma: no cover - defensive
        return None


def _voice_spans(audio: np.ndarray, frame_sec: float = 0.02) -> List[Tuple[float, float]]:
    """Voice-active intervals across the whole file (onset detector, generalized).

    Spans split by tiny pauses (< 0.3 s) are merged back into one — a sentence
    with a breath in it is still one span to re-decode.
    """
    try:
        db, frame_dur, threshold = _frame_levels(audio, frame_sec)
        if db is None:
            return []
        active = db >= threshold
        spans: List[Tuple[float, float]] = []
        run_start = None
        run = 0
        for i, is_active in enumerate(active):
            if is_active:
                if run == 0:
                    run_start = i
                run += 1
            else:
                if run >= 5:
                    spans.append((round(run_start * frame_dur, 4), round(i * frame_dur, 4)))
                run = 0
                run_start = None
        if run >= 5:
            spans.append((round(run_start * frame_dur, 4), round(len(active) * frame_dur, 4)))
        merged: List[Tuple[float, float]] = []
        for s, e in spans:
            if merged and s - merged[-1][1] < 0.3:
                merged[-1] = (merged[-1][0], e)
            else:
                merged.append((s, e))
        return merged
    except Exception:  # pragma: no cover - defensive
        return []


def _offset_words(words: List[Dict], offset: float) -> List[Dict]:
    if not offset:
        return words
    return [
        {**w, "start": round(w["start"] + offset, 4), "end": round(w["end"] + offset, 4)}
        for w in words
    ]


def _word_from(word_data: Dict, segment_id: int) -> Optional[Dict]:
    """Convert one aligned WhisperX word into our flat, safely-typed record."""
    text = str(word_data.get("word", "")).strip()
    if _is_artifact(text):
        return None

    start, end = word_data.get("start"), word_data.get("end")
    if start is None or end is None:
        return None

    start, end = float(start), float(end)
    if np.isnan(start) or np.isnan(end):
        return None
    if end < start:
        start, end = end, start
    if end - start < 0.01:  # keep every word clickable / renderable
        end = start + 0.01

    raw_score = word_data.get("score")
    score = 0.0 if raw_score is None else float(raw_score)
    return {
        "word": text,
        "start": round(start, 4),
        "end": round(end, 4),
        "score": round(float(np.clip(score, 0.0, 1.0)), 4),
        "segment_id": segment_id,
    }


def _proportional_words(segments: List[Dict]) -> List[Dict]:
    """Fallback word timings spread proportionally across a segment's duration.

    Used when no forced-alignment model exists for the detected language — a
    missing alignment model must never mean "no captions at all".
    """
    out: List[Dict] = []
    for seg_idx, segment in enumerate(segments or []):
        text = str(segment.get("text", "")).strip()
        start, end = segment.get("start"), segment.get("end")
        if not text or start is None or end is None:
            continue
        start, end = float(start), float(end)
        if end < start:
            start, end = end, start
        pieces = [p for p in text.split() if not _is_artifact(p)]
        if not pieces:
            continue
        span = max(end - start, 0.01) / len(pieces)
        for k, piece in enumerate(pieces):
            out.append({
                "word": piece,
                "start": round(start + k * span, 4),
                "end": round(start + (k + 1) * span, 4),
                "score": 0.0,
                "segment_id": seg_idx,
            })
    return out


def _load_align_model(language: str, device: str):
    """Load the forced-alignment model; returns ``(None, None)`` when unavailable."""
    try:
        return whisperx.load_align_model(language_code=language, device=device)
    except Exception as exc:
        logger.warning(
            "No forced-alignment model for language %r (%s) — falling back to "
            "proportional word timings.",
            language,
            exc,
        )
        return None, None


def _align_words(
    segments: List[Dict],
    align_model,
    metadata,
    audio: np.ndarray,
    device: str,
) -> List[Dict]:
    """Forced-align segments into words, with a proportional-timing fallback."""
    if not segments:
        return []

    if align_model is None or metadata is None:
        return _proportional_words(segments)

    try:
        aligned = whisperx.align(
            segments,
            align_model,
            metadata,
            audio,
            device,
            return_char_alignments=False,
            print_progress=False,
        )
        words: List[Dict] = []
        for seg_idx, segment in enumerate(aligned.get("segments", [])):
            for word_data in segment.get("words", []):
                word = _word_from(word_data, seg_idx)
                if word is not None:
                    words.append(word)
        if words:
            return words
        logger.warning("Alignment returned no words — using proportional timings.")
    except Exception as exc:
        logger.warning("Alignment failed (%s) — using proportional timings.", exc)
        if device == "cuda":
            torch.cuda.empty_cache()

    return _proportional_words(segments)


def _decode_window(
    model,
    window: np.ndarray,
    window_start: float,
    align_model,
    metadata,
    device: str,
    batch_size: int,
    language: Optional[str] = None,
    origin: Optional[str] = "recovered",
) -> List[Dict]:
    """Transcribe a slice of audio and return its words in *absolute* time.

    The recovery window may contain the very intro that the main VAD pass
    skipped. WhisperX's pipeline **always** re-runs its pyannote VAD inside
    ``transcribe()`` (there is no option to skip it), so the same quiet opening
    would be clipped again and recovery would be a no-op. The window is
    therefore decoded through the underlying faster-whisper model with
    ``vad_filter=False``, falling back to the WhisperX pipeline if that
    low-level path ever disappears in a future WhisperX version.

    ``origin`` stamps every returned word (e.g. ``"recovered-head"``) so the
    panel can visually distinguish pipeline-recovered words from directly
    transcribed ones. Garbled recovery segments are filtered here using
    faster-whisper's own quality signals (a single garbled token like
    "tollerent" sails through a words-per-second rate guard untouched).
    """
    segments: List[Dict] = []
    inner = getattr(model, "model", None)  # the faster-whisper WhisperModel
    if inner is not None:
        try:
            raw_segments, _info = inner.transcribe(
                window,
                language=language or None,
                task="transcribe",
                beam_size=5,
                vad_filter=False,  # ← the whole point of the recovery pass
                word_timestamps=False,  # timings come from forced alignment
                condition_on_previous_text=False,
            )
            kept, dropped = 0, 0
            for seg in raw_segments:
                text = (seg.text or "").strip()
                if not text:
                    continue
                # faster-whisper quality gates — same well-known defaults the
                # main decoder uses (logprob −1.0, no-speech 0.6). Missing
                # attributes (older builds) mean "no signal", not "bad".
                nsp = getattr(seg, "no_speech_prob", None)
                alp = getattr(seg, "avg_logprob", None)
                if nsp is not None and float(nsp) > 0.6:
                    dropped += 1
                    continue
                if alp is not None and float(alp) < -1.0:
                    dropped += 1
                    continue
                segments.append({
                    "text": text,
                    "start": float(seg.start),
                    "end": float(seg.end),
                })
                kept += 1
            if dropped:
                logger.info(
                    "Recovery decode filtered %d low-quality segment(s), kept %d.",
                    dropped, kept,
                )
        except Exception as exc:
            logger.warning("Faster-whisper recovery decode failed: %s", exc)
            segments = []

    if not segments:
        # Fallback: the WhisperX pipeline (its VAD re-runs, but a recovered
        # partial is still better than losing the intro entirely).
        try:
            decoded = model.transcribe(window, batch_size=batch_size, language=language or None)
            segments = [
                {
                    "text": str(s.get("text", "")).strip(),
                    "start": float(s["start"]),
                    "end": float(s["end"]),
                }
                for s in decoded.get("segments", [])
                if s.get("start") is not None and s.get("end") is not None
            ]
        except Exception as exc:
            logger.warning("Secondary decode failed: %s", exc)
            return []

    segments = [s for s in segments if s["text"]]
    if not segments:
        return []

    words = _offset_words(
        _align_words(segments, align_model, metadata, window, device), window_start
    )
    if origin:
        for w in words:
            w.setdefault("origin", origin)
    return words


# Floors for merging recovered words: below either one a "word" is almost
# certainly an alignment splinter or hallucination, and merging it would
# create the back-to-back near-duplicate captions users report as "out of
# sync". Score 0.0 is exempt — it marks proportional-timing fallback words
# (no alignment model), which are kept but flagged for review instead.
RECOVERY_MIN_DURATION = 0.08
RECOVERY_MIN_SCORE = 0.35


def _merge_recovered(primary: List[Dict], recovered: List[Dict]) -> List[Dict]:
    """Append recovered words that are not near-duplicates of existing ones.

    The recovery window deliberately overlaps the first primary word (alignment
    jitter on either side), so equality is time-tolerant: the same token
    within 0.15 s of an existing one is the same spoken word, not a new one.
    This mirrors the ``_dedupe_words`` pass so the recovered list is already
    clean before the final sort.
    """
    if not recovered:
        return primary

    import bisect

    known = {
        (round(w["start"], 1), _normalize_token(w["word"]))
        for w in primary
        if _normalize_token(w["word"])
    }
    by_token: Dict[str, List[float]] = {}
    for w in primary:
        tok = _normalize_token(w["word"])
        if tok:
            bisect.insort(by_token.setdefault(tok, []), float(w["start"]))
    gated_duration, gated_score = 0, 0
    for word in recovered:
        tok = _normalize_token(word["word"])
        if not tok:
            continue
        try:
            dur = float(word["end"]) - float(word["start"])
        except (TypeError, ValueError):
            continue
        if dur < RECOVERY_MIN_DURATION:
            gated_duration += 1
            continue
        score = word.get("score")
        try:
            score = 0.0 if score is None else float(score)
        except (TypeError, ValueError):
            score = 0.0
        if 0.0 < score < RECOVERY_MIN_SCORE:
            gated_score += 1
            continue
        key = (round(word["start"], 1), tok)
        if key in known:
            continue
        starts = by_token.get(tok, [])
        at = float(word["start"])
        pos = bisect.bisect_left(starts, at)
        neighbours = starts[max(0, pos - 1): pos + 1]
        if any(abs(s - at) <= 0.15 for s in neighbours):
            continue
        known.add(key)
        bisect.insort(starts, at)
        by_token[tok] = starts
        primary.append(word)
    if gated_duration or gated_score:
        logger.info(
            "Recovery merge dropped %d sub-80ms fragment(s) and %d low-confidence word(s).",
            gated_duration, gated_score,
        )
    return primary


def _dedupe_words(words: List[Dict]) -> List[Dict]:
    """Sort by time, drop duplicates and clamp overlaps so captions never clash."""
    ordered = sorted(words, key=lambda w: (w["start"], w["end"]))
    out: List[Dict] = []
    for word in ordered:
        if out:
            prev = out[-1]
            if (
                _normalize_token(prev["word"]) == _normalize_token(word["word"])
                and abs(word["start"] - prev["start"]) <= 0.15
            ):
                prev["end"] = max(prev["end"], word["end"])
                prev["score"] = max(prev["score"], word["score"])
                continue
            if word["start"] < prev["end"] - 0.05:
                word["start"] = round(prev["end"], 4)
                if word["end"] <= word["start"]:
                    word["end"] = round(word["start"] + 0.01, 4)
        out.append(word)
    return out


def _head_has_energy(audio: np.ndarray, until_sec: float) -> bool:
    """Lenient ear for a faded/quiet intro the main detector may have missed.

    Returns True when at least ~100 ms of audio before ``until_sec`` sits above
    −50 dB. Used only to decide whether a late-starting transcript deserves a
    no-VAD re-decode of its head — decoding near-silence with the VAD off
    hallucinates, so pure-silence heads must stay untouched.
    """
    try:
        n = int(min(audio.size, max(0.0, until_sec) * SAMPLE_RATE))
        frame = max(1, int(SAMPLE_RATE * 0.02))
        usable = (n // frame) * frame
        if usable < frame * 5:
            return False
        seg = audio[:usable].reshape(-1, frame)
        rms = np.sqrt(np.mean(np.square(seg), axis=1) + 1e-12)
        db = 20.0 * np.log10(rms + 1e-12)
        run = 0
        for level in db:
            run = run + 1 if level >= -50.0 else 0
            if run * frame / SAMPLE_RATE >= 0.1:
                return True
        return False
    except Exception:  # pragma: no cover - defensive
        return False


def _uncovered_spans(
    audio: np.ndarray, words: List[Dict], min_gap: float = 0.5
) -> List[Tuple[float, float]]:
    """Voice spans with no transcribed words covering them.

    These are the "chunkwise" holes the main VAD pass leaves behind — an
    intro starting at 0.77 s instead of 0.00 s, or a sentence dropped
    mid-file. Anything shorter than ``min_gap`` is alignment jitter, not a
    hole worth a GPU re-decode.
    """
    spans = _voice_spans(audio)
    if not spans:
        return []
    covered = sorted((float(w["start"]), float(w["end"])) for w in words or [])
    out: List[Tuple[float, float]] = []
    for s, e in spans:
        cursor = s
        for ws, we in covered:
            if we <= cursor:
                continue
            if ws >= e:
                break
            if ws - cursor >= min_gap:
                out.append((round(cursor, 4), round(min(ws, e), 4)))
            cursor = max(cursor, we)
            if cursor >= e:
                break
        if e - cursor >= min_gap:
            out.append((round(cursor, 4), round(e, 4)))
    return out


def _recover_gaps(
    model,
    audio: np.ndarray,
    words: List[Dict],
    align_model,
    metadata,
    device: str,
    batch_size: int,
    max_spans: int = 8,
) -> Tuple[List[Dict], int]:
    """Chunkwise fill for voice regions the main pass left untranscribed.

    The same no-VAD decode as the head/tail passes, applied to every
    uncovered voice span — middle of the file included. Bounded so a long
    file can never spiral: at most ``max_spans`` spans, 32 s windows, and a
    words-per-second cap per span so a music bed can never turn into
    hallucinated captions. Returns ``(words, added_count)``.
    """
    spans = _uncovered_spans(audio, words)
    if not spans:
        return words, 0
    duration = audio.size / SAMPLE_RATE
    added = 0
    for s, e in spans[:max_spans]:
        ws = max(0.0, s - 0.5)
        we = min(duration, e + 0.5)
        if we - ws > 32.0:
            we = ws + 32.0
        start_sample = int(ws * SAMPLE_RATE)
        end_sample = int(we * SAMPLE_RATE)
        if end_sample - start_sample < MIN_SAMPLES:
            continue
        window = np.ascontiguousarray(audio[start_sample:end_sample], dtype=np.float32)
        recovered = _decode_window(
            model, window, ws, align_model, metadata, device, batch_size,
            origin="recovered-gap",
        )
        span_len = max(we - ws, 0.5)
        in_span = [w for w in recovered if w["end"] > s - 0.3 and w["start"] < e + 0.3]
        # Hallucination guard: sustained speech rarely exceeds ~4 words/sec.
        if len(in_span) > 4 * span_len + 2:
            logger.warning(
                "Gap-recovery: discarding %d words in a %.1fs span (likely music).",
                len(in_span),
                span_len,
            )
            continue
        before = len(words)
        words = _merge_recovered(words, in_span)
        gained = len(words) - before
        if gained:
            logger.info(
                "Gap-recovery: restored %d words in %.2f–%.2fs.", gained, s, e
            )
        added += gained
    return words, added


def _recover_head(
    model,
    audio: np.ndarray,
    words: List[Dict],
    cut: Optional[float],
    align_model,
    metadata,
    device: str,
    batch_size: int,
) -> List[Dict]:
    """Re-decode the intro when the opening words never made the transcript.

    Two failure shapes are covered (the old code only handled the second):

    1. **Voice starts at 0 but the first word is late** (the reported
       "transcription starts at 0.77 s" case). The energy detector correctly
       hears speech from the first frame, yet the decoder's first segment
       begins mid-sentence. The gap between voice onset and first word is the
       signal — anything over ~0.35 s means dropped intro words.
    2. **Voice itself is detected late** (a faded/whispered intro under the
       detector floor). Then the gap is small but the first word still starts
       suspiciously late; a lenient energy check of the audio *before* the
       detected onset decides whether a re-decode is worthwhile.

    The window always spans up to the first decoded word (the old
    ``[cut − 4, cut + 0.5]`` window ended *before* the first word whenever the
    gap exceeded half a second, so words near it could never be restored).
    Recovered words are kept only when they end at/before the first primary
    word (+0.3 s jitter tolerance) and merged with duplicate suppression.
    """
    if not words:
        return words

    first = min(w["start"] for w in words)
    voice_start = cut if cut is not None else 0.0
    gap = first - voice_start

    needs_recovery = gap > 0.35
    if not needs_recovery and first > 0.50 and voice_start > 0.0:
        needs_recovery = _head_has_energy(audio, min(first, voice_start))
    if not needs_recovery:
        return words

    window_start = max(0.0, min(voice_start, first) - 1.0)
    window_end = first + 1.0
    start_sample = int(window_start * SAMPLE_RATE)
    end_sample = int(min(audio.size, window_end * SAMPLE_RATE))
    if end_sample - start_sample < MIN_SAMPLES:
        return words

    logger.info(
        "Head-recovery: voice begins at %.2fs but the first word is at %.2fs — "
        "re-decoding %.2f–%.2fs to restore the intro.",
        voice_start,
        first,
        window_start,
        window_end,
    )

    window = np.ascontiguousarray(audio[start_sample:end_sample], dtype=np.float32)
    recovered = _decode_window(
        model, window, window_start, align_model, metadata, device, batch_size,
        origin="recovered-head",
    )
    # Keep only words that live inside the missing intro region.
    recovered = [w for w in recovered if w["end"] <= first + 0.3]
    return _merge_recovered(words, recovered)


def _recover_tail(
    model,
    audio: np.ndarray,
    words: List[Dict],
    align_model,
    metadata,
    device: str,
    batch_size: int,
) -> List[Dict]:
    """Re-decode the outro when the VAD clipped the closing words away."""
    if not words:
        return words

    end_sec = audio.size / SAMPLE_RATE
    last_end = max(w["end"] for w in words)
    if end_sec - last_end < 1.2:
        return words

    start_sample = int(max(0.0, last_end - 0.3) * SAMPLE_RATE)
    if audio.size - start_sample < MIN_SAMPLES:
        return words

    window = np.ascontiguousarray(audio[start_sample:], dtype=np.float32)
    if _first_voice_time(window) is None:
        return words  # trailing silence — skip to avoid hallucinated captions

    window_start = start_sample / SAMPLE_RATE
    logger.info(
        "Tail-recovery: audio ends at %.2fs but the last word ends at %.2fs — "
        "re-decoding the outro.",
        end_sec,
        last_end,
    )

    recovered = _decode_window(
        model, window, window_start, align_model, metadata, device, batch_size,
        origin="recovered-tail",
    )
    recovered = [w for w in recovered if w["start"] > last_end + 0.05]
    return _merge_recovered(words, recovered)


def transcribe_audio(
    audio_path: str, language: str = "auto", stats: Optional[Dict] = None
) -> List[Dict]:
    """
    Full WhisperX pipeline: audio normalisation → transcription → forced
    alignment → head/tail recovery.

    Returns flat word list:
    [{"word": str, "start": float, "end": float, "score": float, "segment_id": int}]

    Raises:
        RuntimeError: if no words with valid timestamps are found.
    """
    hw = detect_hardware()
    device, load_opts = _resolve_device(hw)
    compute_type = _resolve_compute_type(hw)
    lang = None if language == "auto" else language
    if device == "cpu" and hw.threads:
        torch.set_num_threads(hw.threads)

    # ── Step 0: decode + normalise (fixes quiet intros losing their words) ────
    audio = _load_audio(audio_path)
    duration = audio.size / SAMPLE_RATE

    # ── Step 1: Whisper transcription (VAD onset/offset lowered) ──────────────
    logger.info(
        "Loading %s on %s (%s) — VAD onset=%.2f offset=%.2f",
        settings.WHISPER_MODEL,
        device,
        compute_type,
        _vad_options()["vad_onset"],
        _vad_options()["vad_offset"],
    )
    model = whisperx.load_model(
        settings.WHISPER_MODEL,
        device,
        compute_type=compute_type,
        asr_options=_asr_options(),
        vad_options=_vad_options(),
        language=lang,
        **{k: v for k, v in load_opts.items() if k != "device"},
    )

    try:
        result = model.transcribe(audio, batch_size=hw.batch_size)
        detected_lang = result.get("language") or lang or "en"

        # ── Step 2: Forced word-level alignment ───────────────────────────────
        align_model, metadata = _load_align_model(detected_lang, device)
        try:
            words = _align_words(result.get("segments", []), align_model, metadata, audio, device)
            if not words:
                raise RuntimeError(
                    f"No aligned words found. Language detected: {detected_lang}. "
                    "Check that the audio has speech and language is supported."
                )

            # ── Step 3: Recover anything the VAD clipped off ──────────────────
            cut = _first_voice_time(audio)
            before = len(words)
            words = _recover_head(
                model, audio, words, cut, align_model, metadata, device, hw.batch_size
            )
            head_added = len(words) - before
            words = _recover_tail(
                model, audio, words, align_model, metadata, device, hw.batch_size
            )
            tail_added = len(words) - before - head_added
            # ── Step 4: Chunkwise fill for holes mid-file ─────────────────────
            words, gap_added = _recover_gaps(
                model, audio, words, align_model, metadata, device, hw.batch_size
            )
            if stats is not None:
                stats.update({
                    "recovered_head": head_added,
                    "recovered_middle": gap_added,
                    "recovered_tail": tail_added,
                    "recovered_total": head_added + gap_added + tail_added,
                })
        finally:
            if align_model is not None and device == "cuda":
                torch.cuda.empty_cache()
    finally:
        del model
        if device == "cuda":
            torch.cuda.empty_cache()

    if not words:
        raise RuntimeError(
            f"No words with valid timestamps. Language detected: {detected_lang}."
        )

    words = _dedupe_words(words)
    logger.info(
        "Transcribed %d words from %.2fs of audio (first=%.2fs, last=%.2fs, lang=%s)",
        len(words),
        duration,
        words[0]["start"],
        words[-1]["end"],
        detected_lang,
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

    # Words can arrive in any order once a user has inserted/deleted entries in
    # the panel — caption order is always chronological, so normalise here.
    # A missing/duplicate ``segment_id`` (manual inserts) gets a unique index so
    # "full_phrase" mode never merges unrelated entries.
    normalised = []
    for idx, raw in enumerate(words):
        word = dict(raw)
        try:
            word["start"] = float(word.get("start") or 0.0)
            word["end"] = float(word.get("end") or word["start"])
        except (TypeError, ValueError):
            continue
        if word["end"] < word["start"]:
            word["start"], word["end"] = word["end"], word["start"]
        try:
            segment_id = int(word.get("segment_id"))
        except (TypeError, ValueError):
            segment_id = -1
        # ``0`` is a legitimate WhisperX segment id, so only truly missing ids
        # (manually inserted entries) fall back to a unique per-word index.
        word["segment_id"] = segment_id if segment_id >= 0 else idx + 1
        normalised.append(word)

    if not normalised:
        return []

    normalised.sort(key=lambda w: (w["start"], w["end"]))
    words = normalised

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

    # A freshly inserted entry has no text yet — never turn that into an empty
    # caption. The word rows themselves are still returned to the caller so the
    # user's in-progress insert survives a Save and can be completed later.
    return [p for p in phrases if str(p.get("phrase", "")).strip()]
