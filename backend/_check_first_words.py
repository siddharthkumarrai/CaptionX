"""Temporary diagnostic: prove the head-recovery fix recovers leading words.

Run inside the worker container:
    python _check_first_words.py "/app/assets/Hrithik Roshan Raw Video.mp4"
"""
import sys

from app.services.transcription import transcribe_audio

import glob
import os

if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
    path = sys.argv[1]
else:
    candidates = sorted(glob.glob("/app/assets/*.mp4")) or sorted(glob.glob("/app/assets/*"))
    if not candidates:
        print("NO_ASSET_FOUND")
        sys.exit(1)
    path = candidates[0]

print("ASSET", path)
words = transcribe_audio(path)

print("WORDS", len(words))
print("T0", round(words[0]["start"], 3) if words else None)
print("T_END", round(words[-1]["end"], 3) if words else None)
print("FIRST12", [w["word"] for w in words[:12]])
print("HEAD_DATA", words[:6])
