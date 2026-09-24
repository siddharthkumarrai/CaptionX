"""Diagnostic probe: run the REAL transcribe_audio and dump per-word provenance.

Shows, for every output word: start/end, alignment score, origin stamp
(primary / recovered-head / recovered-gap / recovered-tail), and groups
counts by origin + segment. Run with the cached model for a fast loop::

    .venv_py311\\Scripts\\python tests\\probe_pipeline.py
"""
import os
import sys
from collections import Counter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

os.environ.setdefault("WHISPER_MODEL", os.environ.get("GOLDEN_WHISPER_MODEL", "base"))

from transcription_golden_lib import setup_ffmpeg_on_path  # noqa: E402
setup_ffmpeg_on_path()

from app.services.transcription import transcribe_audio  # noqa: E402

VIDEO = os.path.join(ROOT, "assets", "Hrithik Roshan Raw Video.mp4")


def main() -> int:
    stats: dict = {}
    words = transcribe_audio(VIDEO, language="en", stats=stats)
    print("STATS:", stats)
    print("TOTAL WORDS:", len(words))
    print("BY ORIGIN:", dict(Counter(w.get("origin", "primary") for w in words)))
    print("BY SEGMENT:", dict(Counter(w.get("segment_id", "?") for w in words)))
    print("SCORES:", [round(w.get("score", 0.0), 2) for w in words])
    print("---- per word: start end score origin word ----")
    for w in words:
        print(
            f"{w['start']:>8.3f}->{w['end']:>8.3f} "
            f"sc={w.get('score', 0.0):.2f} "
            f"{w.get('origin', 'primary'):<15} {w['word']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
