"""Compare Whisper model quality/speed on one file (run inside the worker).

Usage::

    docker exec <worker> /usr/bin/python3 /app/model_bench.py /tmp/head-test.mp4 base small medium large-v3-turbo

Prints word count, first/last timestamps and the leading words for each model so
a clipped intro or a too-small model is obvious at a glance.
"""
import json
import logging
import os
import sys
import time

logging.basicConfig(level=logging.WARNING)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: model_bench.py <media> [model ...]")
        return 2

    path = sys.argv[1]
    models = sys.argv[2:] or ["base"]

    from app.services import transcription as T  # noqa: E402

    for name in models:
        os.environ["WHISPER_MODEL"] = name
        try:
            from app.core import config
            config.settings.WHISPER_MODEL = name
        except Exception as exc:
            print("could not override settings:", exc)

        t0 = time.time()
        try:
            words = T.transcribe_audio(path, "auto")
        except Exception as exc:
            print(f"\n### {name}: FAILED -> {type(exc).__name__}: {exc}")
            continue
        dt = time.time() - t0

        first = min(w["start"] for w in words) if words else -1
        last = max(w["end"] for w in words) if words else -1
        print(f"\n### {name}: words={len(words)} first={first:.3f}s last={last:.3f}s time={dt:.1f}s")
        print("LEAD:", json.dumps(words[:10], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
