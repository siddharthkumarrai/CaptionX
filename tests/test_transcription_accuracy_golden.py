"""Golden-fixture regression test for the real WhisperX transcription pipeline.

Drives the REAL WhisperX + faster-whisper stack (no stubs injected here) against
``assets/Hrithik Roshan Raw Video.mp4`` with ground-truth ``assets/captions_.srt``
and asserts the production accuracy gates:

    WER                         <  2 %   (MAX_WER)
    hallucinated insertions     == 0    (MAX_INSERTIONS)
    silent deletions            == 0    (MAX_DELETIONS)
    max word timestamp drift    <  0.15s (MAX_TIMESTAMP_DRIFT_S)

Run under the real-stack venv (the only place the stack is importable):

    .venv_py311\\Scripts\\python -m pytest tests/test_transcription_accuracy_golden.py -s

If the real stack / ffmpeg is not present the test SKIPS (it never erreps) so
the same tree is healthy on CPU-dev machines and on a GPU CI runner.
"""
import os

import pytest

# Model selection via env, honoured before the backend is imported.  Defaults
# to the production model (large-v3-turbo); override for fast iteration with
# GOLDEN_WHISPER_MODEL=base — the gate stays the same either way.
os.environ.setdefault(
    "WHISPER_MODEL",
    os.environ.get("GOLDEN_WHISPER_MODEL", "large-v3-turbo"),
)

# ── Pass / gate thresholds (named constants, not magic numbers in asserts) ─────
from transcription_golden_lib import (  # noqa: E402
    MAX_DELETIONS,
    MAX_INSERTIONS,
    MAX_TIMESTAMP_DRIFT_S,
    MAX_WER,
    real_stack_available,
    run_golden,
)

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(_HERE)
VIDEO_PATH = os.path.join(REPO, "assets", "Hrithik Roshan Raw Video.mp4")
SRT_PATH = os.path.join(REPO, "assets", "captions_.srt")
REPORT_PATH = os.path.join(_HERE, "golden_last_report.txt")

_REAL_STACK_OK, _REAL_STACK_REASON = real_stack_available()


def _real_model_url() -> str:
    """Where the transcription.py module lives, for the skip reason."""
    import app.services.transcription as T  # noqa: F401
    return f"real WhisperX + faster-whisper on {T.settings.WHISPER_MODEL}"


@pytest.mark.skipif(
    not _REAL_STACK_OK,
    reason=f"real stack unavailable: {_REAL_STACK_REASON}",
)
def test_golden_transcription_accuracy(request):
    """End-to-end accuracy gate against the real WhisperX pipeline."""
    result = run_golden(
        VIDEO_PATH,
        SRT_PATH,
        language="en",
        report_path=REPORT_PATH,
    )
    # Stash the full result so a post-mortem hook / fixture can grab it.
    request.config._golden_result = result
    # Always emit the diff so `pytest -s` shows it, pass or fail.
    print(result.diff_text)

    # Assert every gate. On failure the assertion message carries the full
    # human-readable diff report (also written to golden_last_report.txt).
    assert not result.failures, "Golden fixture FAILED:\n\n" + result.diff_text


def test_fixture_assets_exist():
    """Sanity: the gold assets are where the harness expects them."""
    assert os.path.exists(VIDEO_PATH), f"fixture video missing: {VIDEO_PATH}"
    assert os.path.exists(SRT_PATH), f"fixture SRT missing: {SRT_PATH}"
