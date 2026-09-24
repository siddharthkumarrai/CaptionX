"""Diagnostic: proves the WhisperX head/tail recovery restores clipped intros.

Run inside the Celery worker image (which has torch + whisperx + ffmpeg)::

    docker cp "<video>" <worker>:/tmp/head-test.mp4
    docker cp backend/tools/head_recovery_check.py <worker>:/tmp/check.py
    docker exec <worker> sh -lc "cd /app && python /tmp/check.py /tmp/head-test.mp4"

It prints the first and last words with their absolute timestamps so a missing
intro (the "transcription starts at 0.77 s" bug) is immediately visible.
"""
import json
import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/head-test.mp4"

    from app.services.transcription import transcribe_audio  # noqa: E402

    words = transcribe_audio(path, "auto")

    print("\n=== RESULT ===")
    print("WORD_COUNT", len(words))
    if not words:
        print("NO_WORDS")
        return 1

    first_start = min(w["start"] for w in words)
    last_end = max(w["end"] for w in words)
    print("FIRST_START %.3f" % first_start)
    print("LAST_END %.3f" % last_end)
    print("FIRST_WORDS", json.dumps(words[:12], ensure_ascii=False))
    print("LAST_WORDS", json.dumps(words[-8:], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
