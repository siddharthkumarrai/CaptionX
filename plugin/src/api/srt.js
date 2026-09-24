/**
 * srt.js — SRT import for the transcript screen.
 *
 * Parses a SubRip file into the same { words, phrases } shape the backend
 * returns, so an imported file flows through preview / editing / export
 * exactly like a fresh transcription. Word timings are spread evenly across
 * each cue (the SRT format only carries cue-level timestamps).
 */

function parseTimestamp(raw) {
  const m = String(raw || "")
    .trim()
    .replace(".", ",")
    .match(/(\d+):(\d+):([\d,]+)\s*-->\s*(\d+):(\d+):([\d,]+)/);
  if (!m) return null;
  const toSec = (h, min, sec) =>
    Number(h) * 3600 + Number(min) * 60 + Number(String(sec).replace(",", "."));
  return { start: toSec(m[1], m[2], m[3]), end: toSec(m[4], m[5], m[6]) };
}

function cleanLine(line) {
  return String(line || "")
    .replace(/<[^>]*>/g, "") // strip <i>, <b>, <font> tags
    .replace(/\{[^}]*\}/g, "")
    .trim();
}

export function parseSrt(text) {
  const cues = [];
  const blocks = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // First line may be a numeric counter — skip it when present.
    let head = 0;
    if (/^\d+$/.test(lines[0])) head = 1;
    if (head >= lines.length) continue;
    const range = parseTimestamp(lines[head]);
    if (!range || !(range.end > range.start)) continue;
    const caption = lines
      .slice(head + 1)
      .map(cleanLine)
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!caption) continue;
    cues.push({ start: range.start, end: range.end, text: caption });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);

  const words = [];
  const phrases = [];
  cues.forEach((cue, segIdx) => {
    const pieces = cue.text.split(/\s+/).filter(Boolean);
    if (!pieces.length) return;
    const span = Math.max(cue.end - cue.start, 0.01) / pieces.length;
    const chunk = pieces.map((piece, k) => ({
      word: piece,
      start: Math.round((cue.start + k * span) * 10000) / 10000,
      end: Math.round((cue.start + (k + 1) * span) * 10000) / 10000,
      score: 0,
      segment_id: segIdx,
    }));
    words.push(...chunk);
    phrases.push({
      phrase: cue.text,
      words: chunk,
      start: cue.start,
      end: cue.end,
      duration: Math.round((cue.end - cue.start) * 10000) / 10000,
    });
  });
  return { words, phrases };
}
