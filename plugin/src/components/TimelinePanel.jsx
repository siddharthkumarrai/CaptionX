import React, { useState, useEffect, useMemo, useRef } from "react";
import { apiClient } from "../api/client";
import { importAndPlaceCaptions, importAndPlaceSFX, downloadFileToTemp } from "../hooks/usePremiere";
import useJobPolling from "../hooks/useJobPolling";
import RenderOverlay from "./RenderOverlay";

// Animates a number from current value -> `to` over `duration`ms.
// Fixed: never include the animated value itself in the dep array (that
// caused setVal -> effect -> setVal render loops) and never call setState
// synchronously for the idle case without a guard.
function useCountUp(to, running, duration = 600) {
  const [val, setVal] = useState(to);
  const raf = useRef(0);
  const fromRef = useRef(to);
  useEffect(() => {
    if (!running) {
      cancelAnimationFrame(raf.current);
      fromRef.current = to;
      if (val !== to) setVal(to);
      return;
    }
    const start = performance.now();
    const from = fromRef.current;
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const next = Math.round(from + (to - from) * p);
      fromRef.current = next;
      setVal(next);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
    // NOTE: `val` intentionally omitted — including it retriggers the effect
    // on every animation frame and causes an infinite render loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, running, duration]);
  return val;
}

export default function TimelinePanel({ jobResult, styleConfig, captionLayout, hasSequence = false, sequenceName = "", binName = "", onBinNameChange }) {
  const [captionTrack, setCaptionTrack] = useState(1);
  const [sfxTrack, setSfxTrack] = useState(3);
  const [rendering, setRendering] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [renderJobId, setRenderJobId] = useState(null);
  const [placedCount, setPlacedCount] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [notice, setNotice] = useState("");
  // Best-effort cancel: detaches the panel from the server job (polling stops,
  // states reset). The server job itself keeps running; placed clips stay.
  const cancelledRef = useRef(false);

  const hasJob = jobResult && jobResult.phrases && jobResult.phrases.length > 0;
  const transcribeJobId = jobResult?.job_id;

  // Bin preview: CaptionX / <Video> / <job> / {Captions, SFX}. The job
  // segment defaults to a render timestamp; the rename field overrides it.
  const sanitizeBin = (s) => String(s || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60);
  const autoStamp = useMemo(() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
  }, [transcribeJobId]);
  const videoTitle = sanitizeBin(sequenceName) || "Sequence";
  const jobLabel = sanitizeBin(binName) || autoStamp;
  const binSpec = { root: "CaptionX", video: videoTitle, job: jobLabel, captions: "Captions", sfx: "SFX" };

  // Poll the render job with WebSocket + automatic HTTP fallback (from the hook)
  const { status: renderStatus, progress, message } = useJobPolling(renderJobId, {
    onComplete: async (timelinePayload) => {
      // Detached via Cancel while the job finished — leave states cleared.
      if (cancelledRef.current) {
        setRenderJobId(null);
        return;
      }
      setRendering(false);
      setPlacing(true);
      setError("");
      if (!timelinePayload) {
        setPlacing(false);
        setRenderJobId(null);
        setError("Render finished but no timeline data was returned. Reload and try again.");
        return;
      }
      try {
        const localCaptionAssets = await downloadFileToTemp(timelinePayload.caption_clips || []);
        if (cancelledRef.current) {
          setPlacing(false);
          setRenderJobId(null);
          return;
        }
        // SFX is garnish — a failed pop-sound download (e.g. 404 from the
        // asset server) must never abort caption placement.
        let localSfxAssets = [];
        let sfxSkipped = "";
        if (styleConfig.sfx_enabled && (timelinePayload.sfx_clips || []).length) {
          try {
            localSfxAssets = await downloadFileToTemp(timelinePayload.sfx_clips || []);
          } catch (sfxErr) {
            sfxSkipped = sfxErr?.message || "SFX download failed";
            localSfxAssets = [];
          }
        }

        const capRes = await importAndPlaceCaptions(
          localCaptionAssets.map((a, i) => ({
            ...a,
            trackIndex: captionTrack,
            label: (jobResult?.phrases || [])[i]?.phrase || "",
          })),
          { bin: binSpec }
        );
        if (styleConfig.sfx_enabled && localSfxAssets.length > 0) {
          await importAndPlaceSFX(
            localSfxAssets.map((a) => ({ ...a, trackIndex: sfxTrack })),
            { bin: binSpec }
          );
        }

        setPlacing(false);
        setPlacedCount(timelinePayload.total_clips);
        if (sfxSkipped) {
          setNotice(`Captions placed without the word-pop sound (${sfxSkipped}).`);
        }
        // Stale-host detection: the bin-aware host echoes `bin` back. A
        // missing field means Premiere is still running the old ExtendScript
        // (loaded once per session) — clips landed, but in the project root.
        if (capRes && !capRes.bin && !sfxSkipped) {
          setNotice(
            "Placed, but outside the CaptionX bins — Premiere is still running the old host script. Restart Premiere and place again for organized bins."
          );
        }
        setSuccess(
          `✅ ${timelinePayload.total_clips} caption clips placed on V${captionTrack + 1}` +
          (localSfxAssets.length > 0 ? ` + ${localSfxAssets.length} SFX on A${sfxTrack + 1}` : "") +
          (capRes && capRes.bin ? ` in 📁 ${capRes.bin}` : "")
        );
        setRenderJobId(null);
      } catch (placeErr) {
        setPlacing(false);
        setRenderJobId(null);
        setError(placeErr?.message ?? "Failed to place captions on the timeline.");
      }
    },
    onError: (msg) => {
      setRendering(false);
      setPlacing(false);
      setRenderJobId(null);
      setError(msg);
    },
  });

  async function handleRenderAndPlace() {
    // Validation before touching the backend
    if (!hasSequence) {
      setError("No active sequence — drop a clip on the timeline or open a sequence first.");
      return;
    }
    if (!hasJob) { setError("No transcript found — go to Transcribe first."); return; }
    if (!transcribeJobId) { setError("Transcript job ID is missing — re-run transcription."); return; }
    if (String(transcribeJobId).startsWith("imported-")) {
      setError("This transcript was imported from an SRT file, so the backend has no media job for it. Run Transcribe once, then render.");
      return;
    }

    setError("");
    setSuccess("");
    setNotice("");
    cancelledRef.current = false;
    setRendering(true);
    setPlacedCount(0);

    try {
      const renderRes = await apiClient.post("/api/jobs/render", {
        job_id: transcribeJobId,
        // caption_position rides in style_config so the worker renders the
        // MOVs with the exact X/Y dragged in the preview panel.
        style_config: {
          ...styleConfig,
          caption_position: captionLayout || { x: 960, y: 830 },
        },
      });
      const id = renderRes.data?.render_job_id;
      if (!id) throw new Error("Render job was not created.");
      setRenderJobId(id);
    } catch (err) {
      setRendering(false);
      setError(err.response?.data?.detail ?? err.message ?? "Failed to start rendering.");
    }
  }

  const isProcessing = rendering || placing;

  function handleCancel() {
    // Detach from the job: clearing the job id stops the hook's WebSocket +
    // HTTP polling via its cleanup; the in-flight async steps check the flag
    // and bail out without touching state or the timeline.
    cancelledRef.current = true;
    setRenderJobId(null);
    setRendering(false);
    setPlacing(false);
    setNotice("Cancelled — the server keeps the job. Start again to re-attach and place.");
  }

  const overlayHeadline = placing
    ? `Placing captions on V${captionTrack + 1}…`
    : message || "Generating animated captions…";
  const overlaySubline = placing
    ? "Importing clips onto your timeline — Premiere may take a moment."
    : "Turning every spoken moment into editable text";
  // Hooks must run unconditionally at the top level, before any early return
  // in the render output below. `useCountUp`/`useJobPolling` already ran
  // above, so hook order is stable across renders.
  const pct = useCountUp(progress || 0, isProcessing);
  const overallProgress = rendering
    ? Math.round((progress || 0) * 0.85)
    : placing
    ? 90
    : placedCount > 0
    ? 100
    : 0;

  const stage = placing
    ? "Placing captions on timeline…"
    : rendering
    ? message || `Generating animated captions… ${pct}%`
    : renderStatus === "error"
    ? "Failed"
    : "Ready to render";

  return (
    <div>
      <p className="section-header">Place on Timeline</p>

      {!hasJob && (
        <div className="render-stage" style={{ background: "rgba(126, 86, 189, 0.14)", borderColor: "#6b5c00", color: "#c8b830" }}>
          ⚠ No captions generated yet. Go to <strong>Transcribe</strong> tab first.
        </div>
      )}

      {/* Confirmation card: summary + tracks + bin destination */}
      {hasJob && (
        <div
          style={{
            background: "#2a2a2a",
            borderRadius: "8px",
            padding: "10px",
            marginBottom: "14px",
            fontSize: "11px",
            color: "#888",
            lineHeight: "1.6",
          }}
        >
          <div>📝 <strong style={{ color: "#e0e0e0" }}>{jobResult.phrases.length}</strong> captions to place</div>
          <div>🎨 Style: <strong style={{ color: "#e0e0e0" }}>{styleConfig.animation_preset}</strong></div>
          <div>🔤 Font: <strong style={{ color: "#e0e0e0" }}>{styleConfig.font_family}</strong></div>
          <div>📍 Position: <strong style={{ color: "#e0e0e0" }}>X {(captionLayout?.x ?? 960)}px · Y {(captionLayout?.y ?? 830)}px</strong></div>
          {styleConfig.sfx_enabled && (
            <div>🔊 SFX: <strong style={{ color: "#e0e0e0" }}>Word pop on each word</strong></div>
          )}
          <div style={{ marginTop: 8 }}>
            <label className="field-label">Caption Track (Video)</label>
            <select
              className="field-select"
              value={captionTrack}
              onChange={(e) => setCaptionTrack(Number(e.target.value))}
              disabled={isProcessing}
            >
              {[1, 2, 3, 4, 5].map((t) => (
                <option key={t} value={t}>
                  V{t + 1} (Track {t})
                </option>
              ))}
            </select>
          </div>
          {styleConfig.sfx_enabled && (
            <div style={{ marginTop: 6 }}>
              <label className="field-label">SFX Track (Audio)</label>
              <select
                className="field-select"
                value={sfxTrack}
                onChange={(e) => setSfxTrack(Number(e.target.value))}
                disabled={isProcessing}
              >
                {[2, 3, 4, 5, 6].map((t) => (
                  <option key={t} value={t}>
                    A{t} (Track {t})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div style={{ marginTop: 8, background: "#1e1e1e", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
              Captions will be placed into:
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 11, color: "#e0e0e0", lineHeight: 1.7 }}>
              <div>📁 CaptionX / {videoTitle} / {jobLabel}</div>
              <div style={{ paddingLeft: 16 }}>📁 Captions <span style={{ color: "#666" }}>→ V{captionTrack + 1}</span></div>
              <div style={{ paddingLeft: 16 }}>📁 SFX <span style={{ color: "#666" }}>→ A{sfxTrack}</span></div>
            </div>
            <label className="field-label" style={{ marginTop: 6 }}>Rename job folder (optional)</label>
            <input
              className="field-input"
              value={binName}
              onChange={(e) => onBinNameChange && onBinNameChange(e.target.value)}
              placeholder={autoStamp}
              disabled={isProcessing}
              aria-label="Custom job folder name"
            />
          </div>
        </div>
      )}

      {/* Processing Stage (spinner + animated percentage) */}
      {isProcessing && (
        <div style={{ marginBottom: "12px" }}>
          <div className="render-stage">
            <span className={`spinner ${rendering ? "" : "pulse-ring"}`} />
            <span>{stage}</span>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "4px",
              fontSize: "10px",
              color: "#888",
            }}
          >
            <span className="percent-value">{overallProgress}%</span>
            <span style={{ fontSize: "10px", color: "#888" }}>{message || ""}</span>
          </div>
          <div className="progress-bar-wrap">
            <div className={`progress-bar-fill ${rendering ? "active" : ""}`} style={{ width: `${overallProgress}%` }} />
          </div>
        </div>
      )}

      {/* Error / Success */}
      {error && (
        <div
          style={{
            background: "#3a1e1e",
            border: "1px solid #6b2020",
            borderRadius: "8px",
            padding: "10px",
            marginBottom: "12px",
            fontSize: "11px",
            color: "#e05252",
          }}
        >
          ⚠ {error}
        </div>
      )}
      {success && (
        <div
          style={{
            background: "#1e3a2a",
            border: "1px solid #20502a",
            borderRadius: "8px",
            padding: "10px",
            marginBottom: "12px",
            fontSize: "11px",
            color: "#52b788",
          }}
        >
          {success}
        </div>
      )}
      {notice && (
        <div
          style={{
            background: "#2c2836",
            border: "1px solid #4a3f66",
            borderRadius: "8px",
            padding: "10px",
            marginBottom: "12px",
            fontSize: "11px",
            color: "#b3a6cc",
          }}
        >
          {notice}
        </div>
      )}

      {/* Main Action */}
      <button
        className="btn-success"
        onClick={handleRenderAndPlace}
        disabled={!hasSequence || !hasJob || isProcessing}
      >
        {!hasSequence
          ? "⚠ No active sequence"
          : isProcessing
          ? rendering
            ? "⚙ Generating…"
            : "📍 Placing on timeline…"
          : "🚀 Render & Place on Timeline"}
      </button>

      <p
        style={{
          fontSize: "10px",
          color: "#666",
          marginTop: "10px",
          lineHeight: "1.5",
          textAlign: "center",
        }}
      >
        Captions placed as transparent MOV clips on V{captionTrack + 1}.
        Undo with Ctrl+Z if needed.
      </p>

      {isProcessing && (
        <RenderOverlay
          mode={placing ? "placing" : "rendering"}
          headline={overlayHeadline}
          percent={overallProgress}
          subline={overlaySubline}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}
