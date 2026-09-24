import React, { useEffect, useMemo, useRef, useState } from "react";
import useCaptionEdits from "../hooks/useCaptionEdits";
import TimelineStrip, { findWordGaps } from "./TimelineStrip";

/**
 * TimingPanel — Step 2 (Timing & Gaps) of the caption studio.
 * Visual word-block timeline (strip) is the primary surface; raw
 * timecode/frame fields are the precise fallback. Gap click → prefilled
 * add form. List view toggles the same data as compact phrases.
 */

function toTC(sec, fps) {
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const t = Math.max(0, Number(sec) || 0);
  const fr = Math.round((t - Math.floor(t)) * rate);
  const s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(Math.min(rate - 1, fr))}`;
}

function fromTC(str, fps) {
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const s = String(str || "").trim().replace(";", ":");
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?([0-5]?\d):([0-5]?\d)[:.](\d{1,3})$/);
  if (!m) return NaN;
  const fr = Number(m[4].padEnd(2, "0").slice(0, 2));
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + fr / rate;
}

const inputStyle = {
  width: "100%", fontSize: 12, fontFamily: "monospace",
  color: "#e0e0e0", background: "#1e1e1e",
  border: "1px solid #3a3a3a", borderRadius: 4, padding: "4px 6px",
};

export default function TimingPanel({
  jobResult, fps = 30, duration = 0, time = 0, onSeek,
  previewUrl = "", onSaveTranscript,
}) {
  const ed = useCaptionEdits({ jobResult, onSaveTranscript, fps });
  const { phrases } = ed;
  const [selected, setSelected] = useState(null); // {pi, wi}
  const [zoom, setZoom] = useState(1);
  const [listView, setListView] = useState(false);
  const [gapForm, setGapForm] = useState(null); // {start, end, text, mode, refPi}
  const [hint, setHint] = useState("");
  const [envelope, setEnvelope] = useState(null);
  const [dismissedGap, setDismissedGap] = useState(null); // "start-end" key
  const listRef = useRef(null);
  const lastScrollRef = useRef(0);

  const maxEnd = phrases.length ? phrases[phrases.length - 1].end : (duration || 0);

  // Energy envelope from the preview audio (visual only; failures → baseline).
  useEffect(() => {
    if (!previewUrl) { setEnvelope(null); return; }
    let dead = false;
    (async () => {
      try {
        const res = await fetch(previewUrl);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = new AC();
        let decoded;
        try {
          decoded = await ctx.decodeAudioData(buf);
        } finally {
          try { await ctx.close(); } catch { /* noop */ }
        }
        const ch = decoded.getChannelData(0);
        const N = 240, out = new Array(N).fill(0);
        const per = Math.max(1, Math.floor(ch.length / N));
        let peak = 0;
        for (let i = 0; i < N; i++) {
          let s = 0, n = 0;
          for (let j = i * per; j < Math.min((i + 1) * per, ch.length); j += 7) { s += ch[j] * ch[j]; n++; }
          const r = Math.sqrt(s / Math.max(1, n));
          out[i] = r;
          if (r > peak) peak = r;
        }
        if (!dead) setEnvelope(out.map((v) => (peak > 0 ? Math.min(1, v / peak) : 0)));
      } catch {
        if (!dead) setEnvelope(null);
      }
    })();
    return () => { dead = true; };
  }, [previewUrl, jobResult?.job_id]);

  const flat = useMemo(() => {
    const out = [];
    phrases.forEach((p, pi) => (p.words || []).forEach((w, wi) => out.push({ w, pi, wi })));
    return out.sort((a, b) => a.w.start - b.w.start);
  }, [phrases]);

  const selEntry = selected ? flat.find((f) => f.pi === selected.pi && f.wi === selected.wi) : null;
  const selWord = selEntry?.w || null;

  const frame = 1 / (Number(fps) > 0 ? Number(fps) : 30);

  // ── Karaoke: phrase containing the playhead + throttled auto-scroll ──
  const sortedWords = useMemo(
    () => flat.map((f) => f.w).sort((a, b) => a.start - b.start),
    [flat]
  );
  const gaps = useMemo(() => findWordGaps(sortedWords), [sortedWords]);
  const activePhrase = useMemo(() => {
    const idx = phrases.findIndex((p) => time >= p.start && time < p.end);
    return idx >= 0 ? idx : -1;
  }, [phrases, time]);
  const playGap = useMemo(
    () => gaps.find((g) => time >= g.start && time < g.end) || null,
    [gaps, time]
  );
  const playGapKey = playGap ? `${playGap.start.toFixed(2)}-${playGap.end.toFixed(2)}` : null;

  useEffect(() => {
    if (!listView || activePhrase < 0) return;
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (now - lastScrollRef.current < 200) return; // ~5 updates/sec max, no jank
    lastScrollRef.current = now;
    try {
      listRef.current?.querySelector('[data-karaoke="1"]')?.scrollIntoView({ block: "nearest" });
    } catch { /* container missing — harmless */ }
  }, [activePhrase, listView]);

  // Clamp a word's new bounds against its chronological neighbours
  // (mirror of the backend _dedupe_words clamp-not-drop philosophy).
  function clampBounds(gi, ns, ne) {
    const prevEnd = gi > 0 ? flat[gi - 1].w.end : 0;
    const nextStart = gi < flat.length - 1 ? flat[gi + 1].w.start : Infinity;
    const notes = [];
    let s = Math.max(0, ns);
    if (s < prevEnd - 1e-9) { s = prevEnd; notes.push(`start clamped to previous end ${prevEnd.toFixed(2)}s`); }
    let e = Math.max(s + frame, ne);
    if (e > nextStart + 1e-9) {
      e = Math.max(s + frame, nextStart);
      notes.push(nextStart === Infinity ? "" : `end clamped to next start ${nextStart.toFixed(2)}s`);
    }
    return { start: s, end: e, hint: notes.filter(Boolean).join(" · ") };
  }

  function applyBounds(patch) {
    if (!selEntry) return;
    const gi = flat.indexOf(selEntry);
    const ns = patch.start != null ? patch.start : selWord.start;
    const ne = patch.end != null ? patch.end : selWord.end;
    const { start, end, hint: h } = clampBounds(gi, ns, ne);
    setHint(h ? `⚠ ${h}` : "");
    ed.editWord(selEntry.pi, selEntry.wi, { ...("word" in patch ? { word: patch.word } : {}), start, end });
  }

  function saveGapForm() {
    if (!gapForm) return;
    const text = (gapForm.text || "").trim() || "New caption";
    const mode = gapForm.mode || "new";
    const refP = gapForm.refPi != null ? phrases[gapForm.refPi] : null;
    const est = Math.max(0.3, text.split(/\s+/).filter(Boolean).length * 0.3);
    let s, e, removePi = -1;
    if (mode === "replace" && refP) {
      // Take over the referenced entry's exact span.
      s = refP.start;
      e = Math.max(s + frame, refP.end);
      removePi = gapForm.refPi;
    } else if (mode === "before" && refP) {
      e = Math.max(frame, refP.start - 0.03);
      s = Math.max(0, e - est);
      const prevEnd = sortedWords.reduce((m, w) => (w.end <= refP.start + 1e-9 ? Math.max(m, w.end) : m), 0);
      if (s < prevEnd) s = prevEnd;
      if (e <= s) e = s + Math.max(frame * 2, 0.3);
    } else if (mode === "after" && refP) {
      s = Math.max(0, refP.end + 0.03);
      e = s + est;
      const nextStart = sortedWords.reduce((m, w) => (w.start >= refP.end - 1e-9 ? Math.min(m, w.start) : m), Infinity);
      if (e > nextStart) e = Math.max(s + frame * 2, nextStart);
    } else {
      s = Math.max(0, Number(gapForm.start) || 0);
      e = Math.max(s + frame, Number(gapForm.end) || s + 0.6);
    }
    const parts = text.split(/\s+/).filter(Boolean);
    const per = (e - s) / parts.length;
    const words = parts.map((word, k) => ({
      word, start: Math.round((s + k * per) * 10000) / 10000,
      end: Math.round((s + (k + 1) * per) * 10000) / 10000, score: 1,
    }));
    // Insert as its own phrase at the right chronological slot (dropping the
    // replaced phrase first when in replace mode).
    const base = removePi >= 0 ? phrases.filter((_, i) => i !== removePi) : phrases;
    const host = base.findIndex((p) => p.start > s + 0.01);
    const np = { phrase: text, words, start: s, end: e, duration: e - s };
    const next = host === -1 ? [...base, np] : [...base.slice(0, host), np, ...base.slice(host)];
    ed.commit(next);
    setGapForm(null);
    setHint("");
    if (onSeek) onSeek(s);
  }

  if (!phrases.length) {
    return (
      <div style={{ textAlign: "center", padding: "24px 12px", color: "#888", fontSize: 12 }}>
        No captions yet — transcribe first, then fix timing here.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <p className="section-header" style={{ margin: 0, flex: 1 }}>Timing &amp; gaps</p>
        <label style={{ fontSize: 10, color: "#888" }} title="Zoom the timeline for long videos">
          Zoom{" "}
          <input type="range" min={1} max={8} step={1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ width: 70, verticalAlign: "middle" }} aria-label="Timeline zoom" />
        </label>
        <button className="btn-ghost" onClick={() => setListView((v) => !v)} title="Toggle list view">
          {listView ? "◫ Timeline" : "☰ List"}
        </button>
      </div>

      {!listView && (
        <TimelineStrip
          phrases={phrases} duration={Math.max(duration || 0, maxEnd)} time={time} onSeek={onSeek}
          fps={fps} envelope={envelope} selected={selected}
          onSelectWord={(pi, wi) => { setSelected({ pi, wi }); setHint(""); }}
          onRetimeWord={(pi, wi, patch) => {
            const gi = flat.findIndex((f) => f.pi === pi && f.wi === wi);
            if (gi < 0) return;
            const cur = flat[gi].w;
            const { start, end, hint: h } = clampBounds(
              gi,
              patch.start != null ? patch.start : cur.start,
              patch.end != null ? patch.end : cur.end
            );
            setHint(h ? `⚠ ${h}` : "");
            ed.editWord(pi, wi, { start, end });
          }}
          onGapClick={(s, e) => setGapForm({ start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100, text: "" })}
          zoom={zoom}
        />
      )}

      {hint && <p style={{ fontSize: 10, color: "#b99a4a", margin: "6px 0" }}>{hint}</p>}

      {/* gap-fill form */}
      {gapForm && (
        <div style={{ background: "#2a2a2a", borderRadius: 8, padding: 10, marginBottom: 8, border: "1px solid #6b5c00" }}>
          <p style={{ fontSize: 10, color: "#c8b830", fontWeight: 700, margin: "0 0 8px" }}>
            ➕ Fill gap {Number(gapForm.start).toFixed(2)}s → {Number(gapForm.end).toFixed(2)}s
          </p>
          <input
            value={gapForm.text} autoFocus
            onChange={(e) => setGapForm({ ...gapForm, text: e.target.value })}
            placeholder="Caption text…"
            style={{ ...inputStyle, marginBottom: 6 }}
            aria-label="New caption text"
          />
          {gapForm.refPi != null && phrases[gapForm.refPi] && (
            <label style={{ display: "block", fontSize: 10, color: "#888", marginBottom: 6 }}>
              Place relative to entry {gapForm.refPi + 1} (“{(phrases[gapForm.refPi].phrase || "").slice(0, 24)}”)
              <select
                value={gapForm.mode || "new"}
                onChange={(e) => setGapForm({ ...gapForm, mode: e.target.value })}
                style={{ ...inputStyle, marginTop: 4 }}
                aria-label="Placement relative to nearby entry"
              >
                <option value="new">As its own entry (auto-clamped)</option>
                <option value="before">Before entry {gapForm.refPi + 1}</option>
                <option value="after">After entry {gapForm.refPi + 1}</option>
                <option value="replace">Replace entry {gapForm.refPi + 1}</option>
              </select>
            </label>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn-primary" style={{ flex: 1 }} onClick={saveGapForm}>Save caption</button>
            <button className="btn-ghost" onClick={() => setGapForm(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* playback gap prompt: non-blocking, never pauses */}
      {playGap && playGapKey !== dismissedGap && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", background: "rgba(224,82,82,0.10)", border: "1px solid #6b2020", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#e8a184", flex: 1 }}>
            Nothing captioned here ({playGap.start.toFixed(1)}s → {playGap.end.toFixed(1)}s) — add?
          </span>
          <button
            className="btn-ghost"
            onClick={() => setGapForm({
              start: Math.round(playGap.start * 100) / 100,
              end: Math.round(playGap.end * 100) / 100,
              text: "", mode: "new", refPi: activePhrase >= 0 ? activePhrase : null,
            })}
          >
            + Add
          </button>
          <button className="btn-ghost" onClick={() => setDismissedGap(playGapKey)} title="Dismiss until the playhead leaves and re-enters">✕</button>
        </div>
      )}

      {/* selected-word popover (inline card) */}
      {selWord && !listView && (
        <div style={{ background: "#2a2a2a", borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <p style={{ fontSize: 10, color: "#888", fontWeight: 700, textTransform: "uppercase", margin: "0 0 6px" }}>
            “{selWord.word}” — precise adjust
          </p>
          <input
            value={selWord.word}
            onChange={(e) => applyBounds({ word: e.target.value })}
            style={{ ...inputStyle, marginBottom: 6, fontWeight: 700 }}
            aria-label="Word text"
          />
          <div style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 10, color: "#888" }}>
            <label style={{ flex: 1 }}>
              Start (tc)
              <input
                defaultValue={toTC(selWord.start, fps)} key={`s${selEntry.pi}-${selEntry.wi}-${selWord.start}`}
                onBlur={(e) => { const v = fromTC(e.target.value, fps); if (Number.isFinite(v)) applyBounds({ start: v }); }}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                style={{ ...inputStyle }} aria-label="Start timecode"
              />
            </label>
            <label style={{ flex: 1 }}>
              End (tc)
              <input
                defaultValue={toTC(selWord.end, fps)} key={`e${selEntry.pi}-${selEntry.wi}-${selWord.end}`}
                onBlur={(e) => { const v = fromTC(e.target.value, fps); if (Number.isFinite(v)) applyBounds({ end: v }); }}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                style={{ ...inputStyle }} aria-label="End timecode"
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 10, color: "#888" }}>
            <label style={{ flex: 1 }}>
              Start (frame)
              <input
                type="number" step={1} min={0}
                defaultValue={Math.round(selWord.start * fps)} key={`sf${selEntry.pi}-${selEntry.wi}-${selWord.start}`}
                onBlur={(e) => applyBounds({ start: (Number(e.target.value) || 0) / fps })}
                style={{ ...inputStyle }} aria-label="Start frame"
              />
            </label>
            <label style={{ flex: 1 }}>
              End (frame)
              <input
                type="number" step={1} min={0}
                defaultValue={Math.round(selWord.end * fps)} key={`ef${selEntry.pi}-${selEntry.wi}-${selWord.end}`}
                onBlur={(e) => applyBounds({ end: (Number(e.target.value) || 0) / fps })}
                style={{ ...inputStyle }} aria-label="End frame"
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <button className="btn-ghost" onClick={() => ed.nudgeWord(selEntry.pi, selEntry.wi, -frame, 0)} title="Nudge start 1 frame earlier">◀| start</button>
            <button className="btn-ghost" onClick={() => ed.nudgeWord(selEntry.pi, selEntry.wi, frame, 0)} title="Nudge start 1 frame later">start |▶</button>
            <button className="btn-ghost" onClick={() => ed.nudgeWord(selEntry.pi, selEntry.wi, 0, -frame)} title="Nudge end 1 frame earlier">◀‖ end</button>
            <button className="btn-ghost" onClick={() => ed.nudgeWord(selEntry.pi, selEntry.wi, 0, frame)} title="Nudge end 1 frame later">end ‖▶</button>
            <button className="btn-ghost" onClick={() => { ed.deleteWord(selEntry.pi, selEntry.wi); setSelected(null); }} title="Delete this word">🗑</button>
            <button className="btn-ghost" onClick={() => ed.mergeWithNext(selEntry.pi)} disabled={selEntry.pi >= phrases.length - 1} title="Merge phrase with next">⛓ Merge↓</button>
          </div>
        </div>
      )}

      {/* list view: same data, compact phrases, karaoke-synced */}
      {listView && (
        <div ref={listRef} style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {phrases.map((p, pi) => {
            const karaoke = pi === activePhrase;
            return (
              <button
                key={pi}
                data-pi={pi}
                data-karaoke={karaoke ? "1" : "0"}
                className="btn-ghost"
                style={{
                  textAlign: "left", display: "flex", gap: 8, alignItems: "baseline",
                  ...(karaoke ? { borderColor: "#52b788", background: "rgba(82,183,136,0.12)", color: "#e0e0e0" } : {}),
                }}
                onClick={() => { setSelected({ pi, wi: 0 }); if (onSeek) onSeek(p.start); }}
                title={karaoke ? "Now playing — click to edit" : "Select first word"}
              >
                <span style={{ fontFamily: "monospace", color: karaoke ? "#52b788" : "#888", flexShrink: 0 }}>{toTC(p.start, fps)}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.phrase}</span>
                {karaoke && <span style={{ fontSize: 9, flexShrink: 0 }}>▶</span>}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button className="btn-primary" style={{ flex: 1 }} onClick={() => ed.insertPhraseAt(time)} title="Add a new caption starting at the current playhead">
          ＋ Caption at playhead
        </button>
      </div>
      {(ed.saveMsg || ed.saveError) && (
        <p style={{ fontSize: 10, color: ed.saveError ? "#e05252" : "#52b788", marginTop: 6 }}>
          {ed.saveError ? `⚠ ${ed.saveError}` : `✓ ${ed.saveMsg}`}
        </p>
      )}
    </div>
  );
}
