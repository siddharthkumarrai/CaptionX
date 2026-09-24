"""Regression tests for the "transcription starts at 0.77s" intro-loss bug.

Runs entirely on stubbed models (no GPU, no whisperx/torch installs needed):
the faster-whisper inner model and the WhisperX pipeline are fakes whose
transcripts reproduce the production failure shape — primary decode starts
at 0.77s while the audio carries speech from 0s.
"""
import sys
import types
from types import SimpleNamespace

import numpy as np
import pytest

# ── Stub heavy deps before importing the module under test ──────────────────
_torch = types.ModuleType("torch")
_cuda = types.SimpleNamespace(
    is_available=lambda: False,
    empty_cache=lambda: None,
    get_device_name=lambda *a: "",
)
_torch.cuda = _cuda
_torch.set_num_threads = lambda *a: None
sys.modules.setdefault("torch", _torch)

_whisperx = types.ModuleType("whisperx")
_whisperx.load_audio = lambda path: np.zeros(16000, dtype=np.float32)
_whisperx.load_model = lambda *a, **k: (_ for _ in ()).throw(
    AssertionError("test must inject its own fake model")
)
_whisperx.load_align_model = lambda *a, **k: (_ for _ in ()).throw(
    RuntimeError("no alignment model in tests")
)


def _boom(*a, **k):
    raise RuntimeError("no alignment model in tests")


_whisperx.load_align_model = _boom
_whisperx.align = _boom
sys.modules.setdefault("whisperx", _whisperx)

from app.services.transcription import (  # noqa: E402
    SAMPLE_RATE,
    _decode_window,
    _dedupe_words,
    _first_voice_time,
    _merge_recovered,
    _recover_gaps,
    _recover_head,
    _uncovered_spans,
    _voice_spans,
    transcribe_audio,
)


# ── Helpers ─────────────────────────────────────────────────────────────────
def seg(text, start, end, avg_logprob=None, no_speech_prob=None):
    ns = SimpleNamespace(text=text, start=start, end=end)
    if avg_logprob is not None:
        ns.avg_logprob = avg_logprob
    if no_speech_prob is not None:
        ns.no_speech_prob = no_speech_prob
    return ns


def word(text, start, end, score=0.9, segment_id=0):
    return {"word": text, "start": start, "end": end, "score": score,
            "segment_id": segment_id}


def voiced_audio(seconds, voiced_until=None, amp=0.4, seed=7):
    """White-ish voiced band (speech-like energy) then digital silence."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SAMPLE_RATE)
    audio = np.zeros(n, dtype=np.float32)
    voiced_until = seconds if voiced_until is None else voiced_until
    m = int(voiced_until * SAMPLE_RATE)
    t = np.arange(m) / SAMPLE_RATE
    audio[:m] = (amp * np.sin(2 * np.pi * 220 * t)
                 + 0.05 * rng.standard_normal(m)).astype(np.float32)
    return audio


class FakeInner:
    """Stand-in for faster-whisper WhisperModel (vad_filter=False path)."""

    def __init__(self, segments, record=None):
        self._segments = segments
        self.calls = record if record is not None else []

    def transcribe(self, window, **kwargs):
        assert kwargs.get("vad_filter") is False, "recovery must bypass the VAD"
        self.calls.append(float(len(window)) / SAMPLE_RATE)
        return list(self._segments), {}


class FakePipeline:
    """Stand-in for the WhisperX pipeline model."""

    def __init__(self, primary_segments, recovery_segments, record=None,
                 language="en"):
        self.model = FakeInner(recovery_segments, record=record)
        self._primary = primary_segments
        self._language = language

    def transcribe(self, window, batch_size=None, language=None):
        return {"segments": self._primary, "language": self._language}


# ── _recover_head ───────────────────────────────────────────────────────────
def test_recover_head_restores_intro_when_first_word_late():
    """The reported bug: voice from 0s, decoder starts at 0.77s."""
    audio = voiced_audio(6.0)
    primary = [word("people", 0.77, 1.0), word("be", 1.05, 1.2)]
    inner = FakeInner([seg("do not judge", 0.02, 0.6)])
    model = SimpleNamespace(model=inner)
    out = _recover_head(model, audio, primary, cut=0.02,
                        align_model=None, metadata=None,
                        device="cpu", batch_size=16)
    starts = sorted(w["start"] for w in out)
    assert starts[0] < 0.3, f"intro not restored, first={starts[0]}"
    assert len(inner.calls) == 1


def test_recover_head_subfloor_whispered_intro():
    """Late VAD onset (cut=0.77) but audible energy before it → still recover."""
    audio = voiced_audio(6.0)
    primary = [word("tolerant", 0.9, 1.2)]
    inner = FakeInner([seg("be more", 0.1, 0.6)])
    model = SimpleNamespace(model=inner)
    out = _recover_head(model, audio, primary, cut=0.77,
                        align_model=None, metadata=None,
                        device="cpu", batch_size=16)
    assert min(w["start"] for w in out) < 0.5
    assert len(inner.calls) == 1


def test_recover_head_noop_when_intro_healthy():
    """First word at 0.05s → no re-decode at all."""
    audio = voiced_audio(6.0)
    primary = [word("do", 0.05, 0.2), word("not", 0.25, 0.4)]
    inner = FakeInner([seg("do not", 0.0, 0.4)])
    model = SimpleNamespace(model=inner)
    out = _recover_head(model, audio, primary, cut=0.0,
                        align_model=None, metadata=None,
                        device="cpu", batch_size=16)
    assert out == primary
    assert inner.calls == []


def test_recover_head_pure_silence_head_untouched():
    """Silence before a late onset must not be hallucinated into words."""
    audio = np.zeros(int(6.0 * SAMPLE_RATE), dtype=np.float32)
    primary = [word("hello", 2.0, 2.3)]
    inner = FakeInner([seg("thanks for watching", 0.0, 0.5)])
    model = SimpleNamespace(model=inner)
    out = _recover_head(model, audio, primary, cut=2.0,
                        align_model=None, metadata=None,
                        device="cpu", batch_size=16)
    assert [w["word"] for w in out] == ["hello"]
    assert inner.calls == []


# ── gaps / merge / dedupe ───────────────────────────────────────────────────
def test_uncovered_spans_finds_mid_file_hole():
    audio = voiced_audio(10.0)
    words = [word("a", 0.1, 0.4), word("b", 8.0, 8.4)]
    spans = _uncovered_spans(audio, words)
    assert spans, "expected at least one uncovered span"
    # hole must cover the middle, not the transcribed edges
    assert any(s < 1.0 and e > 7.0 for s, e in spans)


def test_recover_gaps_fills_mid_file_hole():
    audio = voiced_audio(10.0)
    primary = [word("a", 0.1, 0.4), word("b", 8.0, 8.4)]
    inner = FakeInner([seg("middle words here", 4.0, 5.0)])
    model = SimpleNamespace(model=inner)
    out, added = _recover_gaps(model, audio, primary,
                               align_model=None, metadata=None,
                               device="cpu", batch_size=16)
    assert added == 3
    assert any(3.5 < w["start"] < 5.5 for w in out)
    assert len(inner.calls) >= 1


def test_merge_recovered_suppresses_near_duplicates():
    primary = [word("people", 0.77, 1.0)]
    recovered = [word("people", 0.80, 1.05, score=0.5),
                 word("do", 0.05, 0.2, score=0.5)]
    out = _merge_recovered(list(primary), recovered)
    assert [w["word"] for w in out].count("people") == 1
    assert any(w["word"] == "do" for w in out)


def test_voice_spans_silence_is_empty():
    audio = np.zeros(int(4.0 * SAMPLE_RATE), dtype=np.float32)
    assert _voice_spans(audio) == []
    assert _first_voice_time(audio) is None


# ── Full-pipeline integration (stubbed models, real wiring) ─────────────────
def test_transcribe_audio_first_word_under_0_3s(tmp_path):
    """End-to-end through transcribe_audio: primary starts at 0.77s, the
    recovery pass must pull the first word under ~0.3s and report stats."""
    import app.services.transcription as T

    audio = voiced_audio(8.0, voiced_until=6.0)
    clip = tmp_path / "intro.wav"
    import wave
    with wave.open(str(clip), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(SAMPLE_RATE)
        fh.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())

    primary = [{"text": "people be more", "start": 0.77, "end": 2.0}]
    recovery = [seg("do not judge", 0.02, 0.6)]

    calls = []

    class Pipe(FakePipeline):
        pass

    fake = FakePipeline(primary, recovery, record=calls)
    monkey = pytest.MonkeyPatch()
    monkey.setattr(T.whisperx, "load_audio", lambda path: audio.copy())
    monkey.setattr(T.whisperx, "load_model", lambda *a, **k: fake)
    monkey.setattr(T, "_load_align_model", lambda lang, dev: (None, None))
    # No ffmpeg needed: normalisation gracefully skips when binary missing.
    try:
        stats = {}
        words = T.transcribe_audio(str(clip), language="en", stats=stats)
    finally:
        monkey.undo()

    assert words, "expected words back"
    assert words[0]["start"] < 0.3, f"first word at {words[0]['start']}"
    assert stats.get("recovered_total", 0) >= 2, f"stats={stats}"
    assert calls, "recovery decode never ran"


# ── Recovery quality gates (P0: no silent junk merges) ──────────────────────
def test_decode_window_filters_garbled_segments():
    """faster-whisper's own no_speech_prob / avg_logprob must filter a
    'tollerent'-type hallucination that a words-per-second guard would miss."""
    audio = voiced_audio(4.0)
    inner = FakeInner([
        seg("tollerent", 0.1, 0.5, avg_logprob=-2.3, no_speech_prob=0.85),
        seg("be more", 0.6, 1.2, avg_logprob=-0.2, no_speech_prob=0.05),
    ])
    model = SimpleNamespace(model=inner)
    out = _decode_window(model, audio[: int(2.0 * SAMPLE_RATE)], 0.0,
                         align_model=None, metadata=None,
                         device="cpu", batch_size=16, origin="recovered-gap")
    texts = " ".join(w["word"] for w in out)
    assert "tollerent" not in texts
    assert "be" in texts and "more" in texts
    assert all(w.get("origin") == "recovered-gap" for w in out)


def test_merge_recovered_drops_fragments_and_low_scores():
    """Sub-80ms splinters and low-confidence tokens never merge; proportional
    (score 0.0) words survive to be flagged for review instead."""
    primary = [word("people", 0.77, 1.0)]
    recovered = [
        word("a", 0.30, 0.333, score=0.9),          # 33ms fragment → drop
        word("tollerent", 0.40, 0.70, score=0.2),   # low confidence → drop
        word("be", 0.10, 0.35, score=0.0),          # proportional → keep
        word("more", 0.40, 0.75, score=0.8),        # healthy → keep
    ]
    out = _merge_recovered(list(primary), recovered)
    texts = [w["word"] for w in out]
    assert "a" not in texts
    assert "tollerent" not in texts
    assert "be" in texts and "more" in texts


def test_recovered_words_carry_origin():
    """Every word a recovery pass adds is stamped for the review UI."""
    audio = voiced_audio(6.0)
    primary = [word("people", 0.77, 1.0), word("be", 1.05, 1.2)]
    inner = FakeInner([seg("do not judge", 0.02, 0.6)])
    model = SimpleNamespace(model=inner)
    out = _recover_head(model, audio, primary, cut=0.02,
                        align_model=None, metadata=None,
                        device="cpu", batch_size=16)
    added = [w for w in out if w["start"] < 0.7]
    assert added, "expected restored intro words"
    assert all(w.get("origin") == "recovered-head" for w in added)
