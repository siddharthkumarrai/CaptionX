import React, { useMemo, useRef, useState } from "react";

/**
 * TimelineStrip — visual word-block timeline for Step 2 (Timing & Gaps).
 * Shows an energy envelope, one block per word, gap markers, and the
 * playhead. Interactions: click block = select, drag block edges = retime
 * (live, no debounce), click gap = start gap-fill, click empty = seek.
 */
const H = 92;

// Shared gap detector: voice-coverage holes worth a re-decode or a manual
// fill. Leading hole only counts past 0.5s; inner holes past 0.4s (below
// that is alignment jitter, not a hole).
export function findWordGaps(sortedWords) {
  const out = [];
  if (sortedWords.length && sortedWords[0].start > 0.5) {
    out.push({ start: 0, end: sortedWords[0].start });
  }
  for (let i = 0; i + 1 < sortedWords.length; i++) {
    const g0 = sortedWords[i].end, g1 = sortedWords[i + 1].start;
    if (g1 - g0 > 0.4) out.push({ start: g0, end: g1 });
  }
  return out;
}

export default function TimelineStrip({
  phrases = [], duration = 0, time = 0, onSeek,
  fps = 30, envelope = null, selected = null, onSelectWord,
  onRetimeWord, onGapClick, zoom = 1,
}) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(null); // {pi, wi, edge, originX, origStart, origEnd}
  const flat = useMemo(() => {
    const out = [];
    (phrases || []).forEach((p, pi) => (p.words || []).forEach((w, wi) => out.push({ w, pi, wi })));
    return out.sort((a, b) => a.w.start - b.w.start);
  }, [phrases]);

  const total = Math.max(duration || 0, flat.length ? flat[flat.length - 1].w.end : 0, 1);
  const span = total / Math.max(1, zoom);
  let v0 = zoom <= 1 ? 0 : time - span / 2;
  v0 = Math.max(0, Math.min(total - span, v0));
  const v1 = v0 + span;

  const toPct = (t) => `${(((t - v0) / span) * 100).toFixed(3)}%`;
  const toT = (clientX) => {
    const r = ref.current.getBoundingClientRect();
    return v0 + ((clientX - r.left) / r.width) * span;
  };

  const gaps = useMemo(() => {
    const sorted = flat.map((f) => f.w).sort((a, b) => a.start - b.start);
    return findWordGaps(sorted);
  }, [flat]);

  const buckets = envelope && envelope.length ? envelope : null;
  const playPct = toPct(Math.max(v0, Math.min(v1, time)));

  function onPointerDown(e, f, edge) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ pi: f.pi, wi: f.wi, edge, origStart: f.w.start, origEnd: f.w.end, moved: false });
  }
  function onPointerMove(e) {
    if (!drag || !onRetimeWord) return;
    const t = Math.max(0, toT(e.clientX));
    const frame = 1 / (Number(fps) > 0 ? Number(fps) : 30);
    const snap = (v) => Math.round(v / frame) * frame;
    const patch = {};
    if (drag.edge === "start") patch.start = Math.max(0, Math.min(snap(t), drag.origEnd - frame));
    else patch.end = Math.max(snap(t), drag.origStart + frame);
    onRetimeWord(drag.pi, drag.wi, patch);
  }
  function onPointerUp() {
    setDrag(null);
  }

  function onKeyDown(e) {
    if (!flat.length || !onSelectWord) return;
    const cur = flat.findIndex((f) => selected && f.pi === selected.pi && f.wi === selected.wi);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = e.key === "ArrowRight"
        ? Math.min(flat.length - 1, cur + 1)
        : Math.max(0, cur === -1 ? 0 : cur - 1);
      onSelectWord(flat[n].pi, flat[n].wi);
      if (onSeek) onSeek(flat[n].w.start);
    }
  }

  return (
    <div>
      <svg
        ref={ref}
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        tabIndex={0}
        role="slider"
        aria-label="Caption timeline. Arrow keys move between words."
        aria-valuetext={`${flat.length} words`}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (drag || !onSeek) return;
          if (e.target.dataset.gap) return; // gap rects handle their own clicks
          onSeek(Math.max(0, toT(e.clientX)));
        }}
        style={{ display: "block", width: "100%", height: H, background: "#14131a", borderRadius: 8, border: "1px solid #333", cursor: "crosshair", touchAction: "none" }}
      >
        {/* energy envelope */}
        {buckets ? buckets.map((v, i) => {
          const n = buckets.length;
          const x = (i / n) * 100, w = 100 / n;
          const h = Math.max(1.5, v * (H - 34));
          return <rect key={i} x={x} y={H - 12 - h} width={Math.max(0.4, w * 0.8)} height={h} fill="#3d3654" opacity={0.9} />;
        }) : (
          <rect x={0} y={H - 14} width={100} height={2} fill="#2c2836" />
        )}
        {/* gap markers */}
        {gaps.map((g, i) => (
          <g key={`g${i}`}>
            <rect
              x={((g.start - v0) / span) * 100} y={6} width={Math.max(1.2, ((g.end - g.start) / span) * 100)} height={H - 26}
              fill="rgba(224,82,82,0.13)" stroke="#e05252" strokeWidth={0.35} strokeDasharray="1.2 0.8" rx={1}
              data-gap="1" style={{ cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); if (onGapClick) onGapClick(g.start, g.end); }}
            >
              <title>{`Gap ${(g.end - g.start).toFixed(2)}s — click to fill`}</title>
            </rect>
          </g>
        ))}
        {/* word blocks */}
        {flat.map((f, k) => {
          const x = ((f.w.start - v0) / span) * 100;
          const w = Math.max(0.5, ((f.w.end - f.w.start) / span) * 100);
          if (x + w < 0 || x > 100) return null;
          const sel = selected && f.pi === selected.pi && f.wi === selected.wi;
          return (
            <g key={k}>
              <rect
                x={x} y={10} width={w} height={H - 40} rx={1}
                fill={sel ? "#7a5cff" : "#4a4370"}
                stroke={sel ? "#c9b8ff" : "none"} strokeWidth={sel ? 0.4 : 0}
                style={{ cursor: "pointer" }}
                onClick={(e) => { e.stopPropagation(); if (onSelectWord) onSelectWord(f.pi, f.wi); if (onSeek) onSeek(f.w.start); }}
              >
                <title>{`${f.w.word} (${f.w.start.toFixed(2)}s → ${f.w.end.toFixed(2)}s)`}</title>
              </rect>
              {sel && (
                <>
                  <rect x={x - 0.7} y={10} width={1.4} height={H - 40} fill="#c9b8ff" style={{ cursor: "ew-resize" }}
                    onPointerDown={(e) => onPointerDown(e, f, "start")} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                  <rect x={x + w - 0.7} y={10} width={1.4} height={H - 40} fill="#c9b8ff" style={{ cursor: "ew-resize" }}
                    onPointerDown={(e) => onPointerDown(e, f, "end")} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                </>
              )}
            </g>
          );
        })}
        {/* playhead */}
        <line x1={parseFloat(playPct)} y1={2} x2={parseFloat(playPct)} y2={H - 4} stroke="#ffd700" strokeWidth={0.5} />
        <circle cx={parseFloat(playPct)} cy={5} r={1.4} fill="#ffd700" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#666", marginTop: 4, fontFamily: "monospace" }}>
        <span>{gaps.length ? `⚠ ${gaps.length} gap${gaps.length > 1 ? "s" : ""} — click red region to fill` : `${flat.length} words · no gaps`}</span>
        <span>{zoom > 1 ? "zoomed" : "full"}</span>
      </div>
    </div>
  );
}
