"""Pytest bootstrap for the root-level golden transcription fixture.

Intentionally does NOT stub torch/whisperx — the golden fixture must drive the
REAL WhisperX + faster-whisper stack.  The stubbed transcription-*unit* tests
live under ``backend/tests/`` (with their own conftest that injects fakes) and
are run as a separate, CPU-bound suite so the two never contaminate each other.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_BACKEND = os.path.join(_ROOT, "backend")
for _p in (_BACKEND, _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)
