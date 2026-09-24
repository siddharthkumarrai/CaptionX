import React, { useRef, useState } from "react";
import { apiClient } from "../api/client";
import { getActiveSequenceAudioFile } from "../api/cep";
import useJobPolling from "../hooks/useJobPolling";

export default function TranscribePanel({ styleConfig, sequenceName = "Active sequence", hasSequence = false, hasTranscript = false, onContinue, onJobComplete, onRemove }) {
  const [language, setLanguage] = useState("auto");
  const [jobId, setJobId] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  // `submitting` flips to true synchronously on click so the button disables
  // immediately (before any await) — prevents double-clicks and shows feedback.
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const submitLock = useRef(false);

  // Defined before handleTranscribe so the guard never hits a TDZ reference.
  const isProcessing = uploading || !!jobId || submitting;

  // Poll job status until complete
  const { status, progress, message } = useJobPolling(jobId, {
    onComplete: (result) => {
      // Validate the result before surfacing it as success
      const phrases = result?.phrases || [];
      const words = result?.words || [];
      if (!phrases.length || !words.length) {
        setError("Transcription completed but no usable words were found. The audio may contain no speech.");
        setJobId(null);
        return;
      }
      setJobId(null);
      onJobComplete(result);
    },
    onError: (msg) => {
      setError(msg);
      setJobId(null);
    },
  });

  // Human-readable stage for the loading animation during processing
  const processingStage = (() => {
    if (uploading) return "Uploading audio…";
    if (!status) return "Preparing…";
    if (status === "pending") return message || "Queued — waiting for worker…";
    if (status === "running") return message || "Transcribing with WhisperX…";
    if (status === "done") return "Done!";
    if (status === "error") return "Failed";
    return message || "Working…";
  })();

   async function handleTranscribe() {
    if (submitLock.current || isProcessing) return;
    submitLock.current = true;
    setSubmitting(true);
    setError("");

    // Validation: there must be an active Premiere sequence to read audio from.
    if (!hasSequence) {
      setError("Drop a clip onto the Premiere timeline first — CaptionX needs an active sequence to read audio from.");
      submitLock.current = false;
      setSubmitting(false);
      return;
    }

    setUploadProgress(0);
    try {
      // This is the slow step: ExtendScript reads the first media clip's file.
      // We validate the sequence/audio path here before kicking off the upload.
      const file = await getActiveSequenceAudioFile();
      const formData = new FormData();
      formData.append("file", file.blob, file.name);
      formData.append("language", language);
      formData.append("caption_mode", styleConfig.caption_mode);

      setUploading(true);
      const res = await apiClient.post("/api/jobs/transcribe", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (evt) => {
          setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        },
      });

      setUploading(false);
      setJobId(res.data.job_id);
    } catch (err) {
      setUploading(false);
      setError(err.response?.data?.detail ?? err.message ?? "Upload failed. Check connection to the CaptionX backend.");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  function handleClear() {
    setJobId(null);
    setError("");
    setUploadProgress(0);
  }

  async function handleRemove() {
    if (removing || isProcessing || !onRemove) return;
    // Native confirm keeps this destructive action explicit in the CEP panel.
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      if (!window.confirm("Remove this transcript? Captions and edits for this sequence will be discarded.")) return;
    }
    setRemoving(true);
    try {
      await onRemove();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div>
      <p className="section-header">Transcribe & Generate Captions</p>

      <div className="sequence-source-card">
        <span className="feature-icon">▶</span>
        <div><strong>{sequenceName}</strong><small>Audio is read automatically from the active Premiere timeline.</small></div>
        <span className="ready-badge">LIVE</span>
      </div>

      {/* Existing transcript — shown when the user comes back to this page */}
      {hasTranscript && !jobId && (
        <div style={{ marginBottom: "12px", background: "#1d3326", border: "1px solid #2e5c40", padding: "10px", borderRadius: "8px" }}>
          <p style={{ fontSize: "11px", color: "#7fd8a4", margin: "0 0 6px" }}>
            ✓ Existing transcript loaded — your captions and edits are intact.
          </p>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="btn-primary" style={{ flex: 2 }} onClick={onContinue}>
              Continue to captions →
            </button>
            <button className="btn-ghost" onClick={handleClear} disabled={isProcessing} title="Not applicable — transcript is kept until re-transcription">
              Keep
            </button>
            {onRemove && (
              <button className="btn-ghost btn-danger" onClick={handleRemove} disabled={isProcessing || removing} title="Delete this transcript from the server and this panel">
                {removing ? "Removing…" : "Remove"}
              </button>
            )}
          </div>
          <p style={{ fontSize: "10px", color: "#888", margin: "6px 0 0" }}>
            Re-transcribe below only if the timeline audio changed — it replaces the current transcript.
          </p>
        </div>
      )}

      {/* Language */}
      <div className="field-group">
        <label className="field-label">Language</label>
        <select
          className="field-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          disabled={isProcessing}
        >
          <option value="auto">Auto-detect</option>
          <option value="en">English</option>
          <option value="hi">Hindi</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="pt">Portuguese</option>
          <option value="ja">Japanese</option>
          <option value="ko">Korean</option>
          <option value="zh">Chinese</option>
          <option value="ar">Arabic</option>
        </select>
      </div>

      {/* Upload Progress */}
      {uploading && (
        <div style={{ marginBottom: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
            <span style={{ fontSize: "10px", color: "#888" }}>Uploading…</span>
            <span style={{ fontSize: "10px", color: "#888" }}>{uploadProgress}%</span>
          </div>
          <div className="progress-bar-wrap">
            <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {/* Job Status */}
      {jobId && status && (
        <div className="loading-overlay">
          <div className="loading-stage">
            <span className="spinner" />
            <span>{processingStage}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <span className={`status-chip status-${status}`}>
              {status === "running" ? "⚡ " : status === "done" ? "✓ " : "○ "}
              {status}
            </span>
            <span style={{ fontSize: "10px", color: "#888" }}>{progress}%</span>
          </div>
          <div className="progress-bar-wrap">
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          {message && (
            <p style={{ fontSize: "10px", color: "#888", marginTop: "4px" }}>{message}</p>
          )}
        </div>
      )}

      {/* WebSocket fallback notice */}
      {jobId && status === "error" && /retrying|connection/i.test(message || "") && (
        <p style={{ fontSize: "10px", color: "#b99a4a", marginTop: "4px" }}>
          ⚠ Real-time updates unavailable — polling the server as a fallback. This tab can be closed safely.
        </p>
      )}

      {/* Error */}
      {error && (
        <p style={{ fontSize: "11px", color: "#e05252", marginBottom: "10px", background: "#3a1e1e", padding: "8px", borderRadius: "6px" }}>
          ⚠ {error}
        </p>
      )}

      {/* Sequence validation */}
      {!hasSequence && (
        <p style={{ fontSize: "11px", color: "#b99a4a", marginBottom: "10px", background: "#3a301e", padding: "8px", borderRadius: "6px" }}>
          ⚠ No active sequence detected. Drop a clip on the timeline (or open a sequence) and click Refresh. Transcribe is disabled until a sequence is active.
        </p>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          className="btn-primary"
          onClick={handleTranscribe}
          disabled={!hasSequence || isProcessing}
          style={{ flex: 3 }}
        >
          {!hasSequence
            ? "Drop a clip to start"
            : submitting && !uploading && !jobId
            ? "Starting…"
            : uploading
            ? `Uploading… ${uploadProgress}%`
            : jobId
            ? `Processing… ${progress}%`
            : "🎤 Transcribe & Generate"}
        </button>
        <button className="btn-ghost" onClick={handleClear} disabled={isProcessing}>Clear</button>
      </div>

      {/* Info */}
      <p style={{ fontSize: "10px", color: "#666", marginTop: "12px", lineHeight: "1.5" }}>
        Powered by WhisperX — the active timeline audio is exported automatically. Word-level accuracy target: ±30ms.
        Processing time: ~1 min per 10 min of audio.
      </p>
    </div>
  );
}
