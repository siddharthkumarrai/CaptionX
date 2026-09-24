"""Shared helpers for the CaptionX golden transcription-accuracy fixture.

ONLY the standard library + numpy are used here so the *exact same*
alignment / WER / insertion-vs-deletion-vs-substitution / timestamp-drift
logic is exercised whether the golden test drives the real WhisperX +
faster-whisper stack, or a fidelity harness that reproduces the documented
production failure signatures.  Pinning the metric code to this single
module is what makes a non-GPU run a trustworthy proxy for the real one.

The functions deliberately know nothing about WhisperX: they consume a
plain list of ``{"word", "start", "end"}`` records in the shape both the
SRT parser and ``transcribe_audio`` produce.
"""
from __future__ import annotations

import os
import re
import string
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

PUNCT = string.punctuation


# ── Token normalisation (comparison only — originals are kept for reporting) ─


def normalize_token(tok: str) -> str:
    """Lower-case and strip *trailing* punctuation.

    Internal punctuation that is part of the word is preserved so that
    contractions (``can't`` -> ``can't``) still match, while trailing
    punctuation (``people.`` -> ``people``) does not.
    """
    t = (tok or "").lower().strip()
    return t.rstrip(PUNCT)


# ── SRT parsing ─────────────────────────────────────────────────────────────


_TS_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*"
    r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})"
)


def _time_to_sec(h, m, s, ms) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_srt(path: str) -> List[Dict]:
    """Parse an ``.srt`` into one record per *word*.

    Each SRT caption maps to its words.  Captions that already contain a
    single word use its own start/end verbatim; multi-word captions distribute
    the caption duration proportionally across their words.  The reference
    fixture is one word per caption, so no approximation is introduced for it.

    Returns: ``[{"word": str, "start": float, "end": float}, ...]``
    """
    with open(path, "r", encoding="utf-8-sig") as fh:
        text = fh.read()

    blocks = re.split(r"\n\s*\n", text.strip())
    words: List[Dict] = []
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        m = _TS_RE.search(lines[1])
        if not m:
            continue
        start = _time_to_sec(*m.group(1, 2, 3, 4))
        end = _time_to_sec(*m.group(5, 6, 7, 8))
        caption_text = " ".join(lines[2:])
        pieces = [p for p in re.split(r"\s+", caption_text.strip()) if p]
        if not pieces:
            continue
        if len(pieces) == 1:
            words.append({"word": pieces[0], "start": start, "end": end})
        else:
            span = max(end - start, 1e-6) / len(pieces)
            for idx, piece in enumerate(pieces):
                words.append({
                    "word": piece,
                    "start": round(start + idx * span, 4),
                    "end": round(start + (idx + 1) * span, 4),
                })
    return words


# ── Word-level edit-distance alignment (Needleman-Wunsch, unit costs) ────────
#
# A true Levenshtein alignment rather than a naive index-by-index comparison:
# when an insertion or deletion occurs every subsequent index shifts, so an
# index-by-index diff mis-reports everything after the first error.
#
# Cell tags (each cell pairs a reference slot and a hypothesis slot):
MATCH = "match"   # aligned ref <-> hyp, text equal
SUB = "sub"       # ref word replaced by a different hyp word
INS = "ins"       # hyp word with no ref counterpart  (hallucination)
DEL = "del"       # ref word with no hyp counterpart    (silent drop)


@dataclass
class AlignCell:
    tag: str
    ref_idx: Optional[int]
    hyp_idx: Optional[int]
    ref_word: Optional[Dict]
    hyp_word: Optional[Dict]
    drift: float = 0.0


def _norm_seq(words: Sequence[Dict]) -> List[str]:
    return [normalize_token(w["word"]) for w in words]


def align_words(ref: Sequence[Dict], hyp: Sequence[Sequence]) -> List[AlignCell]:
    """Token-level edit-distance alignment between reference and hypothesis.

    Monotonic and order-preserving, so repeated tokens (``Do`` x3) align by
    occurrence, not by first-match.
    """
    n, m = len(ref), len(hyp)
    rn = _norm_seq(ref)
    hn = _norm_seq(hyp)

    big = 10 ** 9
    # D[i][j] = edit distance between ref[:i] and hyp[:j]
    D = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        D[i][0] = i
    for j in range(1, m + 1):
        D[0][j] = j
    for i in range(1, n + 1):
        ri = rn[i - 1]
        for j in range(1, m + 1):
            cost = 0 if ri == hn[j - 1] else 1
            D[i][j] = min(
                D[i - 1][j - 1] + cost,  # match / sub
                D[i - 1][j] + 1,         # del
                D[i][j - 1] + 1,         # ins
            )

    cells: List[AlignCell] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and D[i][j] == D[i - 1][j - 1] + (0 if rn[i - 1] == hn[j - 1] else 1):
            tag = MATCH if rn[i - 1] == hn[j - 1] else SUB
            cells.append(AlignCell(tag, i - 1, j - 1, ref[i - 1], hyp[j - 1]))
            i, j = i - 1, j - 1
        elif j > 0 and D[i][j] == D[i][j - 1] + 1:
            cells.append(AlignCell(INS, None, j - 1, None, hyp[j - 1]))
            j -= 1
        else:  # i > 0 and D[i][j] == D[i-1][j] + 1
            cells.append(AlignCell(DEL, i - 1, None, ref[i - 1], None))
            i -= 1
    cells.reverse()
    return cells


@dataclass
class AccuracyReport:
    wer: float
    n_match: int
    n_sub: int
    n_ins: int
    n_del: int
    n_ref: int
    max_drift: float
    mean_drift: float
    cells: List[AlignCell] = field(default_factory=list)

    def insertions(self) -> List[AlignCell]:
        return [c for c in self.cells if c.tag == INS]

    def deletions(self) -> List[AlignCell]:
        return [c for c in self.cells if c.tag == DEL]

    def substitutions(self) -> List[AlignCell]:
        return [c for c in self.cells if c.tag == SUB]


def analyze(ref: Sequence[Dict], hyp: Sequence[Dict]) -> AccuracyReport:
    """Align reference vs hypothesis and tally WER components + drift."""
    cells = align_words(ref, hyp)
    n_match = sum(1 for c in cells if c.tag == MATCH)
    n_sub = sum(1 for c in cells if c.tag == SUB)
    n_ins = sum(1 for c in cells if c.tag == INS)
    n_del = sum(1 for c in cells if c.tag == DEL)
    n_ref = len(ref)
    errors = n_sub + n_ins + n_del
    wer = errors / n_ref if n_ref else 0.0

    drifts: List[float] = []
    for c in cells:
        if c.tag == MATCH and c.ref_word and c.hyp_word:
            d = abs(float(c.hyp_word["start"]) - float(c.ref_word["start"]))
            c.drift = d
            drifts.append(d)
    max_drift = max(drifts) if drifts else 0.0
    mean_drift = float(np.mean(drifts)) if drifts else 0.0
    return AccuracyReport(
        wer=wer, n_match=n_match, n_sub=n_sub, n_ins=n_ins, n_del=n_del,
        n_ref=n_ref, max_drift=max_drift, mean_drift=mean_drift, cells=cells,
    )


# ── Reporting ─────────────────────────────────────────────────────────────────


def drift_exceedances(report: AccuracyReport, tol: float) -> List[Dict]:
    """Matched words whose |start - gt_start| exceeds ``tol`` seconds."""
    out = []
    for c in report.cells:
        if c.tag == MATCH and c.ref_word and c.hyp_word and c.drift > tol:
            out.append({
                "word": c.hyp_word["word"],
                "gt_start": float(c.ref_word["start"]),
                "hyp_start": float(c.hyp_word["start"]),
                "drift": c.drift,
            })
    return out


def format_diff(report: AccuracyReport, tol: float) -> str:
    """Human-readable, position-aligned diff of ground-truth vs pipeline."""
    lines = []
    lines.append("=" * 92)
    lines.append(
        f"WER={report.wer:.4f}  "
        f"match={report.n_match} sub={report.n_sub} "
        f"ins={report.n_ins} del={report.n_del}  "
        f"ref_words={report.n_ref}  "
        f"max_drift={report.max_drift:.4f}s mean_drift={report.mean_drift:.4f}s"
    )
    lines.append("=" * 92)

    def _w(d, key="word"):
        return f"{d[key]:<16}" if d else "·"

    def _t(d, key="start"):
        return f"{float(d[key]):.4f}s" if d else "─────"

    for c in report.cells:
        if c.tag == MATCH:
            lines.append(
                f"  [OK]    gt {_t(c.ref_word):>10}  {_w(c.ref_word):<16}  "
                f"->  hyp {_t(c.hyp_word):>10}  {_w(c.hyp_word):<16}  "
                f"drift={c.drift:.4f}s"
            )
        elif c.tag == INS:
            lines.append(
                f"  [INS]   gt         ─────  {'·':<16}  "
                f"->  hyp {_t(c.hyp_word):>10}  {_w(c.hyp_word):<16}  "
                f"  HALLUCINATION"
            )
        elif c.tag == DEL:
            lines.append(
                f"  [DEL]   gt {_t(c.ref_word):>10}  {_w(c.ref_word):<16}  "
                f"->  hyp         ─────  {'·':<16}  "
                f"  SILENT DROP"
            )
        else:  # SUB
            lines.append(
                f"  [SUB]   gt {_t(c.ref_word):>10}  {_w(c.ref_word):<16}  "
                f"->  hyp {_t(c.hyp_word):>10}  {_w(c.hyp_word):<16}  "
                f"drift={c.drift:.4f}s"
            )

    drifts = drift_exceedances(report, tol)
    if drifts:
        lines.append("-" * 92)
        lines.append(f"TIMESTAMP DRIFT > ±{tol}s on matched words:")
        for d in drifts:
            lines.append(
                f"  {d['word']:<16} gt={d['gt_start']:.4f} hyp={d['hyp_start']:.4f} "
                f"drift={d['drift']:.4f}s"
            )
        lines.append("=" * 92)
    return "\n".join(lines)


# ── Golden-fixture thresholds & driver ────────────────────────────────────────


# Pass / gate thresholds (also imported by the pytest module so the values live
# in exactly one place rather than as magic numbers buried in assertions).
MAX_WER = 0.02
MAX_INSERTIONS = 0
MAX_DELETIONS = 0
MAX_TIMESTAMP_DRIFT_S = 0.15

DEFAULT_THRESHOLDS = {
    "wer": MAX_WER,
    "insertions": MAX_INSERTIONS,
    "deletions": MAX_DELETIONS,
    "max_drift": MAX_TIMESTAMP_DRIFT_S,
}


@dataclass
class GoldenResult:
    report: AccuracyReport
    diff_text: str
    passed: bool
    failures: List[str]
    thresholds: Dict


def _which_ffmpeg() -> str:
    import os
    import shutil
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    return ""


def setup_ffmpeg_on_path() -> str:
    """Make an ``ffmpeg`` executable reachable for ``whisperx.load_audio``.

    ``imageio-ffmpeg`` ships the binary under a platform-specific name
    (``ffmpeg-win-x86_64-v7.1.exe``), which ``shutil.which("ffmpeg")`` will not
    find.  We copy it to ``ffmpeg.exe`` in a temp dir and put that on PATH so
    both ``transcription._ffmpeg_normalized_copy`` and ``whisperx.load_audio``
    resolve it.
    """
    import os
    import shutil
    import tempfile
    exe = _which_ffmpeg()
    if not exe:
        return ""
    base = os.path.basename(exe).lower()
    if base.startswith("ffmpeg") and base != "ffmpeg.exe":
        shim_dir = tempfile.mkdtemp(prefix="captionx-ffmpeg-")
        dest = os.path.join(shim_dir, "ffmpeg.exe")
        shutil.copy(exe, dest)
        os.environ["PATH"] = shim_dir + os.pathsep + os.environ.get("PATH", "")
        return dest
    return exe


def real_stack_available() -> Tuple[bool, str]:
    """Whether the *real* WhisperX + faster-whisper stack (not stubs) is usable."""
    import importlib
    for mod in ("torch", "whisperx", "faster_whisper"):
        try:
            importlib.import_module(mod)
        except Exception as e:
            return False, f"{mod} not importable: {e!r}"
    if not _which_ffmpeg():
        return False, "ffmpeg not found on PATH and imageio-ffmpeg unavailable"
    return True, "real WhisperX + faster-whisper stack + ffmpeg available"


def run_golden(
    video_path: str,
    srt_path: str,
    language: str = "en",
    model: Optional[str] = None,
    stats: Optional[Dict] = None,
    thresholds: Optional[Dict] = None,
    report_path: Optional[str] = None,
) -> GoldenResult:
    """Drive the REAL ``transcribe_audio`` against the fixture and score it.

    ``transcribe_audio`` reads ``settings.WHISPER_MODEL`` at import time, so the
    model must be selected via env *before* the backend is imported the first
    time.  This module does that lazily, right before the call.
    """
    thresholds = thresholds or dict(DEFAULT_THRESHOLDS)
    if model:
        os.environ.setdefault("WHISPER_MODEL", model)
    setup_ffmpeg_on_path()

    # Lazy import — keeps the alignment helpers usable on the base interpreter
    # (which has no whisperx/torch) without side effects.
    from app.services.transcription import transcribe_audio

    stats = stats or {}
    words = transcribe_audio(video_path, language=language, stats=stats)
    ref = parse_srt(srt_path)
    report = analyze(ref, words)
    diff_text = format_diff(report, thresholds["max_drift"])

    failures: List[str] = []
    if report.wer > thresholds["wer"]:
        failures.append(f"WER {report.wer:.4f} > {thresholds['wer']}")
    if report.n_ins > thresholds["insertions"]:
        failures.append(f"insertions={report.n_ins} > {thresholds['insertions']}")
    if report.n_del > thresholds["deletions"]:
        failures.append(f"deletions={report.n_del} > {thresholds['deletions']}")
    if report.max_drift > thresholds["max_drift"]:
        failures.append(f"max_drift={report.max_drift:.4f}s > {thresholds['max_drift']}s")

    if report_path:
        try:
            with open(report_path, "w", encoding="utf-8") as fh:
                fh.write(diff_text)
        except OSError:
            pass

    return GoldenResult(
        report=report,
        diff_text=diff_text,
        passed=(not failures),
        failures=failures,
        thresholds=thresholds,
    )



