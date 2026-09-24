"""Standalone runner for the golden transcription fixture (no pytest needed).

Usage (real-stack venv):
    .venv_py311\\Scripts\\python tests\\run_golden.py            # default model (large-v3-turbo)
    .venv_py311\\Scripts\\python tests\\run_golden.py --model base
    .venv_py311\\Scripts\\python tests\\run_golden.py --model turbo  --language en

Prints the human-readable diff, writes ``tests/golden_last_report.txt``, and
exits non-zero when any accuracy gate is breached.  Skips cleanly (exit 0) when
the real stack / ffmpeg is unavailable.
"""
import argparse
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, ROOT)
sys.path.insert(0, _HERE)

from transcription_golden_lib import (  # noqa: E402
    real_stack_available,
    run_golden,
)

VIDEO = os.path.join(ROOT, "assets", "Hrithik Roshan Raw Video.mp4")
SRT = os.path.join(ROOT, "assets", "captions_.srt")
REPORT = os.path.join(_HERE, "golden_last_report.txt")

# Default model mirrors the production setting; allow quick iteration.
DEFAULT_MODEL = os.environ.get("GOLDEN_WHISPER_MODEL", "large-v3-turbo")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help="WhisperX model name (default: %(default)s)")
    ap.add_argument("--language", default="en")
    ap.add_argument("--report", default=REPORT)
    ns = ap.parse_args(argv)

    ok, reason = real_stack_available()
    if not ok:
        print(f"SKIP golden run — {reason}")
        return 0

    if not os.path.exists(VIDEO):
        print(f"FAIL: fixture video missing: {VIDEO}")
        return 2
    if not os.path.exists(SRT):
        print(f"FAIL: fixture SRT missing: {SRT}")
        return 2

    print(f"Driving REAL WhisperX pipeline: model={ns.model} "
          f"video={os.path.basename(VIDEO)} srt={os.path.basename(SRT)}")
    result = run_golden(
        VIDEO, SRT, language=ns.language, model=ns.model,
        report_path=ns.report,
    )
    print(result.diff_text)
    print("\n" + "=" * 92)
    verdict = "PASS" if result.passed else "FAIL"
    print(f"VERDICT: {verdict}")
    if result.failures:
        print("  gates breached:")
        for f in result.failures:
            print(f"    - {f}")
    print(f"  report written to: {ns.report}")
    return 0 if result.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
