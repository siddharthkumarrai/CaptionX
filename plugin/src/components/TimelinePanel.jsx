import React, { useState } from "react";
import { apiClient } from "../api/client";
import { importAndPlaceCaptions, importAndPlaceSFX, downloadFileToTemp } from "../hooks/usePremiere";

export default function TimelinePanel({ jobResult, styleConfig }) {
  const [captionTrack, setCaptionTrack] = useState(1);  // V2 (0-indexed = 1)
  const [sfxTrack, setSfxTrack] = useState(3);
  const [rendering, setRendering] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderJobId, setRenderJobId] = useState(null);
  const [placedCount, setPlacedCount] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const hasJob = jobResult && jobResult.phrases && jobResult.phrases.length > 0;

  async function handleRenderAndPlace() {
    if (!hasJob) return;
    setError("");
    setSuccess("");
    setRendering(true);
    setRenderProgress(0);

    try {
      // Step 1: Submit render job to backend
      const renderRes = await apiClient.post("/api/jobs/render", {
        job_id: jobResult.job_id,
        style_config: styleConfig,
      });
      const renderJobId = renderRes.data.render_job_id;
      setRenderJobId(renderJobId);

      // Step 2: Poll render status with WebSocket
      const timelinePayload = await pollRenderJob(renderJobId, setRenderProgress);

      setRendering(false);
      setPlacing(true);

      // Step 3: Download rendered assets to local temp dir
      const localCaptionAssets = await downloadFileToTemp(
        timelinePayload.caption_clips
      );
      const localSfxAssets = await downloadFileToTemp(
        timelinePayload.sfx_clips
      );

      // Step 4: Place on Premiere timeline via UXP API
      const captionAssetsWithTrack = localCaptionAssets.map((a) => ({
        ...a,
        trackIndex: captionTrack,
      }));
      await importAndPlaceCaptions(captionAssetsWithTrack);

      if (styleConfig.sfx_enabled && localSfxAssets.length > 0) {
        const sfxAssetsWithTrack = localSfxAssets.map((a) => ({
          ...a,
          trackIndex: sfxTrack,
        }));
        await importAndPlaceSFX(sfxAssetsWithTrack);
      }

      setPlacing(false);
      setPlacedCount(timelinePayload.total_clips);
      setSuccess(
        `✅ ${timelinePayload.total_clips} caption clips placed on V${captionTrack + 1}` +
        (styleConfig.sfx_enabled ? ` + ${timelinePayload.total_sfx} SFX on A${sfxTrack + 1}` : "")
      );
    } catch (err) {
      setRendering(false);
      setPlacing(false);
      setError(err.message ?? "Failed to render or place captions.");
      console.error("[CaptionX] Timeline placement error:", err);
    }
  }

  function pollRenderJob(jobId, onProgress) {
    return new Promise((resolve, reject) => {
      const WS_BASE = process.env.WS_URL || "wss://api.captionx.app";
      const ws = new WebSocket(`${WS_BASE}/ws/jobs/${jobId}`);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.progress !== undefined) onProgress(data.progress);
          if (data.status === "done") {
            ws.close();
            resolve(data.result); // timelinePayload
          }
          if (data.status === "error") {
            ws.close();
            reject(new Error(data.message ?? "Render job failed"));
          }
        } catch (e) {
          reject(e);
        }
      };
      ws.onerror = (e) => reject(new Error("WebSocket connection error"));
      ws.onclose = (e) => {
        if (!e.wasClean) reject(new Error("WebSocket closed unexpectedly"));
      };
    });
  }

  const isProcessing = rendering || placing;
  const overallProgress = rendering
    ? Math.round(renderProgress * 0.8)  // render = 0–80%
    : placing
    ? 90
    : placedCount > 0
    ? 100
    : 0;

  return (
    <div>
      <p className="section-header">Place on Timeline</p>

      {!hasJob && (
        <div
          style={{
            background: "#2a2a1e",
            border: "1px solid #6b5c00",
            borderRadius: "8px",
            padding: "12px",
            marginBottom: "14px",
          }}
        >
          <p style={{ fontSize: "11px", color: "#c8b830" }}>
            ⚠ No captions generated yet. Go to <strong>Transcribe</strong> tab first.
          </p>
        </div>
      )}

      {/* Track Selector */}
      <div className="field-group">
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
        <div className="field-group">
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

      {/* Summary */}
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
          {styleConfig.sfx_enabled && (
            <div>🔊 SFX: <strong style={{ color: "#e0e0e0" }}>Word pop on each word</strong></div>
          )}
        </div>
      )}

      {/* Progress */}
      {isProcessing && (
        <div style={{ marginBottom: "12px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "4px",
              fontSize: "10px",
              color: "#888",
            }}
          >
            <span>
              {rendering
                ? `Rendering captions… ${renderProgress}%`
                : "Placing on timeline…"}
            </span>
            <span>{overallProgress}%</span>
          </div>
          <div className="progress-bar-wrap">
            <div className="progress-bar-fill" style={{ width: `${overallProgress}%` }} />
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
          {error}
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

      {/* Main Action */}
      <button
        className="btn-success"
        onClick={handleRenderAndPlace}
        disabled={!hasJob || isProcessing}
      >
        {isProcessing
          ? rendering
            ? "⚙ Rendering…"
            : "📍 Placing on Timeline…"
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
    </div>
  );
}
