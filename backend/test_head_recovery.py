"""Manual end-to-end check for the Whisper leading-word fix.

Usage (inside a worker container):
    python test_head_recovery.py /path/to/video.mp4 [start] [duration]

Prints the first words Whisper produced so the intro-loss regression
("transcription starts at 0.77s, first seven seconds missing") can be verified
against a known-good reference.

This file is a debugging harness, not part of the app or the test suite.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services.transcription import transcribe_audio  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python test_head_recovery.py <video-or-audio> [start] [duration]")
        return 2

    path = sys.argv[1]
    start = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    duration = float(sys.argv[3]) if len(sys.argv) > 3 else 16.0

    import subprocess
    import tempfile

    fd, clip = tempfile.mkstemp(prefix="clip-", suffix=".wav")
    os.close(fd)
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-ss", str(start), "-t", str(duration), "-i", path,
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", clip],
        check=True,
    )

    try:
        words = transcribe_audio(clip)
    finally:
        try:
            os.unlink(clip)
        except OSError:
            pass

    print("=" * 62)
    print(f"WORDS: {len(words)}")
    print(f"FIRST WORD START: {words[0]['start']:.3f}s  (was 0.770s before the fix)")
    print(f"LAST  WORD END:   {words[-1]['end']:.3f}s")
    print("=" * 62)
    for w in words[:20]:
        print(f"{w['start']:>7.3f} -> {w['end']:>7.3f}  {w['score']:.2f}  {w['word']}")
    print("=" * 62)
    print("EXPECTED opening: Do not judge people. Be more tolerant.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
