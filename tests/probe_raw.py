"""Deep diagnostic: raw model + aligner output (bypasses recovery/merge).

Shows the WhisperX segment texts and per-word alignments the pipeline
consumes, so we can tell model-level drops (missing from segment.text) from
alignment-level timing corruption (good text, wrong word spans). Uses base
model (cached) for speed.

    .venv_py311\\Scripts\\python tests\\probe_raw.py
"""
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

os.environ.setdefault("WHISPER_MODEL", os.environ.get("GOLDEN_WHISPER_MODEL", "base"))
from transcription_golden_lib import setup_ffmpeg_on_path  # noqa: E402
setup_ffmpeg_on_path()

import numpy as np  # noqa: E402
import whisperx  # noqa: E402
from app.services.transcription import _asr_options, _vad_options  # noqa: E402

VIDEO = os.path.join(ROOT, "assets", "Hrithik Roshan Raw Video.mp4")


def main() -> int:
    audio = whisperx.load_audio(VIDEO)
    print("audio", audio.shape, round(audio.size / 16000, 2), "s")
    model = whisperx.load_model(
        "base", "cpu", compute_type="int8",
        asr_options=_asr_options(), vad_options=_vad_options(), language="en",
    )
    res = model.transcribe(audio, batch_size=8)
    segs = res.get("segments", [])
    print("n_segs", len(segs), "lang", res.get("language"))
    for s in segs:
                print(
            f"[{s.get('start', 0):.3f}->{s.get('end', 0):.3f}] "
            f"avg_lp={s.get('avg_logprob', '?')} "
            f"nsp={s.get('no_speech_prob', '?')} "
            f"cr={s.get('compression_ratio', '?')} "
            f"prealign_words={len(s.get('words', []) or [])}\n"
            f"   TEXT: {s.get('text', '')!r}"
        )

    am, meta = whisperx.load_align_model(language_code="en", device="cpu")
    aligned = whisperx.align(segs, am, meta, audio, "cpu",
                             return_char_alignments=False, print_progress=False)
    print("=== aligned words (first 25) ===")
    n = 0
    for seg in aligned.get("segments", []):
        for w in seg.get("words", []):
            print(f"  {w['start']:>8.3f}->{w['end']:>8.3f} sc={w.get('score')} {w['word']}")
            n += 1
            if n >= 25:
                return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
