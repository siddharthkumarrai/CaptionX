import React, { useEffect, useMemo, useRef, useState } from "react";
import useTimelineFrame from "../hooks/useTimelineFrame";

const CANVAS_W = 1920;
const CANVAS_H = 1080;
// Fallback frame rate when Premiere can't report the sequence rate. The real
// rate arrives as a prop so frame-stepping matches the project exactly.
const DEFAULT_FPS = 30;

// Style presets researched from viral-caption UX (Hormozi / Ali Abdaal /
// Captions-app style): bold condensed word-pop with high-contrast highlight.
const STYLE_PRESETS = [
  { id: "kinetic", name: "Kinetic Focus", font_family: "Montserrat-ExtraBold", font_size: 96, text_color: "#FFFFFF", highlight_color: "#FFD700", bg_color: "#000000", bg_opacity: 0, animation_preset: "pop_scale" },
  { id: "clean", name: "Clean Word Progress", font_family: "Poppins-Bold", font_size: 80, text_color: "#1A1A1A", highlight_color: "#1A1A1A", bg_color: "#FFFFFF", bg_opacity: 0.95, animation_preset: "fade_in" },
  { id: "impact", name: "Impact Pulse", font_family: "Anton", font_size: 110, text_color: "#00E5FF", highlight_color: "#FFFFFF", bg_color: "#000000", bg_opacity: 0.55, animation_preset: "bounce" },
  { id: "editorial", name: "Editorial Serif", font_family: "Poppins-Bold", font_size: 72, text_color: "#FFFFFF", highlight_color: "#FFB84D", bg_color: "#000000", bg_opacity: 0.35, animation_preset: "slide_up" },
];

export default function PreviewPanel({ jobResult, styleConfig, captionLayout, onLayoutChange, videoUrl, previewUrl = "", onSaveTranscript, fps: projectFps = 0, sequenceWidth = 0, sequenceHeight = 0, sequenceName = "", time: timeProp, onTimeChange }) {
  // Project frame rate — drive every step/round so edits land on whole frames.
  const FPS = Number(projectFps) > 0 ? Number(projectFps) : DEFAULT_FPS;
  // Real sequence resolution so the stage matches what Premiere renders
  // (vertical reels → vertical stage, horizontal → horizontal). Falls back to
  // the 1920×1080 render canvas when the sequence dims aren't available yet.
  const seqW = sequenceWidth > 0 ? sequenceWidth : CANVAS_W;
  const seqH = sequenceHeight > 0 ? sequenceHeight : CANVAS_H;
  const seqAspect = seqW / seqH;
  // Render canvas dims — the renderer uses 1920×1080 by default but scales to
  // the sequence on vertical projects, so the px mapping here must match.
  const canvasW = Math.max(seqW, CANVAS_W);
  const canvasH = Math.max(seqH, CANVAS_H);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Playback clock: lifted to the studio when provided (so the Timing step's
  // strip stays in sync), otherwise local. Timing edits moved to TimingPanel;
  // this component is the sticky visual preview + position controls.
  const [innerTime, setInnerTime] = useState(0);
  const time = timeProp ?? innerTime;
  const setTime = onTimeChange ?? setInnerTime;
  const [duration, setDuration] = useState(0);
  // Set when the <video> element itself reports a load failure (bad file://
  // URL, missing file, unplayable codec). Without this the stage just stays
  // black with no explanation — the exact "video not showing" complaint.
  const [videoError, setVideoError] = useState("");
  const stageRef = useRef(null);
  const videoRef = useRef(null);
  // Timeline frame still exported by Premiere itself: shows the real video
  // pixels even when the source codec (e.g. HEVC/H.265) cannot be decoded by
  // the panel's Chromium <video> element at all.
  const { frameUrl, frameStatus, loadingFrame, refreshFrame } = useTimelineFrame(
    `${sequenceName || ""}|${videoUrl || ""}`
  );
  // A <video> that failed to load paints black over the stage — drop it so
  // the exported frame (or gradient) shows through instead. Some codecs
  // (HEVC) never even fire an error event, so the element additionally stays
  // invisible until its first frame actually decodes (onLoadedData).
  const [videoReady, setVideoReady] = useState(false);
  // Two-stage source: backend H.264 proxy first (real motion for any codec),
  // then the direct file:// URL. onError steps through the stages before
  // giving up with the visible warning.
  const sources = useMemo(() => [previewUrl, videoUrl].filter(Boolean), [previewUrl, videoUrl]);
  const [srcIdx, setSrcIdx] = useState(0);
  const activeSrc = sources[Math.min(srcIdx, Math.max(0, sources.length - 1))] || "";
  const showVideo = Boolean(activeSrc && !videoError);

  const layout = captionLayout || { x: Math.round(canvasW / 2), y: Math.round(canvasH * 0.75) };
  const phrases = jobResult?.phrases || [];

  useEffect(() => {
    setTime(0);
    setPlaying(false);
    setVideoError("");
    setVideoReady(false);
    setSrcIdx(0);
  }, [jobResult?.job_id, videoUrl, previewUrl]);

  // Derive the active phrase/word from the playback clock (video timeupdate
  // or the fallback timer) so playback and frame-stepping stay in sync.
  let safeIndex = 0;
  for (let i = 0; i < phrases.length; i++) {
    if (time + 0.001 >= phrases[i].start) safeIndex = i;
  }
  const current = phrases[safeIndex] || { phrase: "", words: [], start: 0, end: 0, duration: 0 };
  let activeWord = 0;
  for (let i = 0; i < current.words.length; i++) {
    if (time + 0.001 >= current.words[i].start) activeWord = i;
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(2).padStart(5, "0");
    return `${m}:${s}`;
  }

  const maxEnd = phrases.length ? phrases[phrases.length - 1].end : 0;

  // Fallback clock when previewing without a playable video source
  // (no file, or a codec Chromium can't decode — the exported frame still
  // shows while captions step through on this timer).
  useEffect(() => {
    if (!playing || (showVideo && videoReady)) return undefined;
    const id = setInterval(() => {
      setTime((t) => {
        const nt = t + 0.45;
        if (nt >= maxEnd) {
          setPlaying(false);
          return maxEnd;
        }
        return nt;
      });
    }, 450);
    return () => clearInterval(id);
  }, [playing, showVideo, videoReady, maxEnd]);

  function seekTo(t) {
    const limit = duration || maxEnd || t;
    const clamped = Math.max(0, Math.min(limit, t));
    setTime(clamped);
    if (videoRef.current) videoRef.current.currentTime = clamped;
  }

  function togglePlay() {
    const v = videoRef.current;
    if (playing) {
      setPlaying(false);
      if (v) v.pause();
    } else {
      setPlaying(true);
      if (v) v.play().catch(() => {});
    }
  }

  // Frame-by-frame stepping: snaps to whole frames at the project FPS.
  function stepFrame(dir) {
    if (playing) togglePlay();
    seekTo(Math.round(time * FPS) / FPS + dir / FPS);
  }

  // Phrase edit operations live in useCaptionEdits (Timing step) — this
  // sticky preview intentionally exposes no text/timing mutation UI.
  if (!jobResult || !jobResult.phrases || jobResult.phrases.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px 20px" }}>
        <div style={{ fontSize: "32px", marginBottom: "12px" }}>🎬</div>
        <p style={{ fontSize: "12px", color: "#888" }}>
          No captions yet. Go to <strong>Transcribe</strong> tab to generate.
        </p>
      </div>
    );
  }

    // Drag: move caption pixel-by-pixel on the render canvas. The canvas may be
  // larger than the sequence (e.g. 1920×1080 for a 1080×1920 reel), so the drag
  // mapping uses the render canvas dims to match what the renderer places.
  function stagePos(e) {
    const rect = stageRef.current.getBoundingClientRect();
    const px = Math.round(((e.clientX - rect.left) / rect.width) * canvasW);
    const py = Math.round(((e.clientY - rect.top) / rect.height) * canvasH);
    return {
      x: Math.max(0, Math.min(canvasW, px)),
      y: Math.max(0, Math.min(canvasH, py)),
    };
  }

  function nudge(dx, dy) {
    if (!onLayoutChange) return;
    onLayoutChange({
      x: Math.max(0, Math.min(canvasW, layout.x + dx)),
      y: Math.max(0, Math.min(canvasH, layout.y + dy)),
    });
  }

  const leftPct = (layout.x / canvasW) * 100;
  const topPct = (layout.y / canvasH) * 100;

  return (
    <div>
      <p className="section-header">
        Caption Preview — {phrases.length} phrase{phrases.length !== 1 ? "s" : ""}
      </p>
      {/* Transport: play/pause, frame-by-frame step, phrase jump */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "8px" }}>
        <button className="btn-ghost" onClick={() => seekTo(0)} title="Back to start">⏮</button>
        <button className="btn-ghost" onClick={() => stepFrame(-1)} title="Previous frame">◀❙</button>
        <button className="btn-primary" onClick={togglePlay} style={{ flex: 1 }}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button className="btn-ghost" onClick={() => stepFrame(1)} title="Next frame">❙▶</button>
        <button className="btn-ghost" onClick={() => seekTo(current.start)} title="Jump to phrase start">↺</button>
        <button className="btn-ghost" onClick={refreshFrame} disabled={loadingFrame} title="Refresh the timeline frame from Premiere">⟳</button>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#888", fontFamily: "monospace", marginBottom: "4px" }}>
        <span>{formatTime(time)}</span>
        <span>frame {Math.round(time * FPS)}{duration ? ` / ${Math.round(duration * FPS)}` : ""}</span>
      </div>
      <input
        type="range"
        min={0}
        max={duration || maxEnd || 1}
        step={1 / FPS}
        value={Math.min(time, duration || maxEnd || 1)}
        onChange={(e) => seekTo(Number(e.target.value))}
        style={{ width: "100%", marginBottom: "8px" }}
        aria-label="Scrub video"
      />
      {/* Draggable caption stage — aspect ratio follows the project sequence
          so vertical reels show a vertical stage and horizontal shows 16:9. */}
      {videoError && (
        <p style={{ fontSize: "10px", color: "#b99a4a", background: "#3a301e", padding: "8px", borderRadius: "6px", marginBottom: "8px" }}>
          ⚠ {videoError}
        </p>
      )}
      {frameStatus && !frameUrl && (
        <p style={{ fontSize: "10px", color: "#888", marginBottom: "8px" }}>
          {loadingFrame ? "Loading the current timeline frame…" : `Timeline frame: ${frameStatus}`}
        </p>
      )}
      <div
        ref={stageRef}
        onMouseDown={(e) => {
          setDragging(true);
          if (onLayoutChange) onLayoutChange(stagePos(e));
        }}
        onMouseMove={(e) => { if (dragging && onLayoutChange) onLayoutChange(stagePos(e)); }}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => setDragging(false)}
        title="Drag the caption to move it pixel-by-pixel"
        style={{
          background: "#000",
          borderRadius: "8px",
          aspectRatio: seqW && seqH ? `${seqW}/${seqH}` : "16/9",
          display: "flex",
          justifyContent: "center",
          marginBottom: "6px",
          position: "relative",
          overflow: "hidden",
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none",
        }}
      >
        {/* Stage backdrop: the real Premiere-exported timeline frame when
            available (correct for every codec and sequence aspect), plain
            gradient only while it loads or when the export is unavailable.
            The <video> sits on top and covers it whenever the file plays. */}
        {frameUrl ? (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "50%",
              transform: "translateX(-50%)",
              aspectRatio: seqW && seqH ? `${seqW}/${seqH}` : "9/16",
              height: "100%",
              width: "auto",
              maxWidth: "100%",
              backgroundImage: `url(${frameUrl})`,
              backgroundSize: "contain",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
              backgroundColor: "#000",
            }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "50%",
              transform: "translateX(-50%)",
              aspectRatio: seqW && seqH ? `${seqW}/${seqH}` : "9/16",
              width: "100%",
              maxWidth: "100%",
              background: "linear-gradient(135deg, #1a1a2e 0%, #3a2a4e 50%, #0f3460 100%)",
              opacity: 0.85,
            }}
          />
        )}
        {showVideo && (
          <video
            ref={videoRef}
            src={activeSrc}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
            onLoadedData={() => setVideoReady(true)}
            onEnded={() => setPlaying(false)}
            onError={() => {
              if (srcIdx + 1 < sources.length) {
                setSrcIdx(srcIdx + 1);
              } else {
                setVideoError(
                  "The sequence video could not be played in the panel (missing file or unplayable codec). Captions still preview on the stage — render & timeline placement are unaffected."
                );
              }
            }}
            playsInline
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "50%",
              transform: "translateX(-50%)",
              aspectRatio: seqW && seqH ? `${seqW}/${seqH}` : "9/16",
              height: "100%",
              width: "auto",
              maxWidth: "100%",
              objectFit: "contain",
              background: "#000",
              visibility: videoReady ? "visible" : "hidden",
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            left: `${leftPct}%`,
            top: `${topPct}%`,
            transform: "translate(-50%, -50%)",
            zIndex: 1,
            outline: dragging ? "1px dashed #8b7cf6" : "1px dashed transparent",
            outlineOffset: "6px",
            background:
              styleConfig.bg_opacity > 0
                ? `${styleConfig.bg_color}${Math.round(styleConfig.bg_opacity * 255)
                    .toString(16)
                    .padStart(2, "0")}`
                : "transparent",
            borderRadius: "8px",
            padding: styleConfig.bg_opacity > 0 ? "6px 14px" : "0",
            pointerEvents: "none",
            maxWidth: "90%",
          }}
        >
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "center" }}>
            {current.words.map((w, i) => (
              <span
                key={i}
                style={{
                  fontSize: `${Math.round(styleConfig.font_size * 0.22)}px`,
                  fontWeight: "900",
                  color: i <= activeWord ? styleConfig.highlight_color : styleConfig.text_color,
                  fontFamily: styleConfig.font_family.replace(/-/g, " "),
                  textShadow: "0 2px 8px rgba(0,0,0,0.8)",
                }}
              >
                {w.word}
              </span>
            ))}
          </div>
        </div>
      </div>
            <p style={{ fontSize: "10px", color: "#8b7cf6", marginBottom: "8px", textAlign: "center" }}>
        X {layout.x}px · Y {layout.y}px — drag caption or nudge below, render matches preview
      </p>
      <div style={{ display: "flex", gap: "4px", justifyContent: "center", marginBottom: "12px", flexWrap: "wrap" }}>
        <button className="btn-ghost" onClick={() => nudge(-1, 0)}>←1</button>
        <button className="btn-ghost" onClick={() => nudge(-10, 0)}>←10</button>
        <button className="btn-ghost" onClick={() => nudge(0, -1)}>↑1</button>
        <button className="btn-ghost" onClick={() => nudge(0, 1)}>↓1</button>
        <button className="btn-ghost" onClick={() => nudge(10, 0)}>10→</button>
        <button className="btn-ghost" onClick={() => nudge(1, 0)}>1→</button>
        <button className="btn-ghost" onClick={() => onLayoutChange && onLayoutChange({ x: Math.round(canvasW / 2), y: Math.round(canvasH * 0.75) })}>Reset</button>
      </div>

      {/* Timestamp */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "8px",
          fontSize: "10px",
          color: "#888",
          marginBottom: "12px",
          fontFamily: "monospace",
        }}
      >
        <span>{formatTime(current.start)}</span>
        <span>→</span>
        <span>{formatTime(current.end)}</span>
        <span style={{ color: "#666" }}>({current.duration.toFixed(2)}s)</span>
      </div>

      {/* Current phrase readout — editing lives in the Timing step */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
        <button
          className="btn-ghost"
          onClick={() => seekTo(phrases[Math.max(0, safeIndex - 1)].start)}
          disabled={safeIndex === 0}
          style={{ flex: 1 }}
          title="Previous phrase"
        >
          ← Prev
        </button>
        <span style={{ fontSize: "11px", color: "#888", flexShrink: 0 }}>
          {safeIndex + 1} / {phrases.length}
        </span>
        <button
          className="btn-ghost"
          onClick={() => seekTo(phrases[Math.min(phrases.length - 1, safeIndex + 1)].start)}
          disabled={safeIndex === phrases.length - 1}
          style={{ flex: 1 }}
          title="Next phrase"
        >
          Next →
        </button>
      </div>
      <p style={{ fontSize: "10px", color: "#666", textAlign: "center", margin: "0 0 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        “{current.phrase}”
      </p>
    </div>
  );
}
