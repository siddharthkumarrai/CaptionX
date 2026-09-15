import React, { useState, useRef, useCallback } from "react";
import { apiClient } from "../api/client";
import useJobPolling from "../hooks/useJobPolling";

const SUPPORTED_FORMATS = [".mp4", ".mov", ".avi", ".mkv", ".mp3", ".wav", ".m4a", ".aac"];

export default function TranscribePanel({ styleConfig, onJobComplete }) {
  const [file, setFile] = useState(null);
  const [language, setLanguage] = useState("auto");
  const [dragOver, setDragOver] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef();

  // Poll job status until complete
  const { status, progress, message } = useJobPolling(jobId, {
    onComplete: (result) => {
      setJobId(null);
      onJobComplete(result);
    },
    onError: (msg) => {
      setError(msg);
      setJobId(null);
    },
  });

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) validateAndSetFile(dropped);
  }

  function handleFileSelect(e) {
    const selected = e.target.files[0];
    if (selected) validateAndSetFile(selected);
  }

  function validateAndSetFile(f) {
    const ext = "." + f.name.split(".").pop().toLowerCase();
    if (!SUPPORTED_FORMATS.includes(ext)) {
      setError(`Unsupported format: ${ext}. Use: ${SUPPORTED_FORMATS.join(", ")}`);
      return;
    }
    if (f.size > 2 * 1024 * 1024 * 1024) { // 2GB limit
      setError("File too large. Maximum size: 2 GB.");
      return;
    }
    setError("");
    setFile(f);
  }

  async function handleTranscribe() {
    if (!file) return;
    setError("");
    setUploading(true);
    setUploadProgress(0);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("language", language);
      formData.append("caption_mode", styleConfig.caption_mode);

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
      setError(err.response?.data?.detail ?? "Upload failed. Check connection.");
    }
  }

  function handleClear() {
    setFile(null);
    setJobId(null);
    setError("");
    setUploadProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const isProcessing = uploading || !!jobId;

  return (
    <div>
      <p className="section-header">Transcribe & Generate Captions</p>

      {/* Drop Zone */}
      <div
        onClick={() => !isProcessing && fileInputRef.current.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{
          border: `2px dashed ${dragOver ? "#4a90d9" : file ? "#52b788" : "#444"}`,
          borderRadius: "8px",
          padding: "24px 12px",
          textAlign: "center",
          cursor: isProcessing ? "default" : "pointer",
          background: dragOver ? "#1a2a3a" : "#2a2a2a",
          marginBottom: "14px",
          transition: "all 0.15s",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={SUPPORTED_FORMATS.join(",")}
          onChange={handleFileSelect}
          style={{ display: "none" }}
        />
        {file ? (
          <div>
            <div style={{ fontSize: "20px", marginBottom: "6px" }}>🎬</div>
            <div style={{ fontSize: "12px", fontWeight: "600", color: "#52b788" }}>{file.name}</div>
            <div style={{ fontSize: "10px", color: "#888", marginTop: "2px" }}>
              {(file.size / (1024 * 1024)).toFixed(1)} MB
            </div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: "24px", marginBottom: "6px" }}>⬆️</div>
            <div style={{ fontSize: "12px", color: "#888" }}>
              Drop video/audio or <span style={{ color: "#4a90d9" }}>click to browse</span>
            </div>
            <div style={{ fontSize: "10px", color: "#666", marginTop: "4px" }}>
              MP4, MOV, AVI, MP3, WAV — max 2 GB
            </div>
          </div>
        )}
      </div>

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
        <div style={{ marginBottom: "12px" }}>
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

      {/* Error */}
      {error && (
        <p style={{ fontSize: "11px", color: "#e05252", marginBottom: "10px", background: "#3a1e1e", padding: "8px", borderRadius: "6px" }}>
          ⚠ {error}
        </p>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          className="btn-primary"
          onClick={handleTranscribe}
          disabled={!file || isProcessing}
          style={{ flex: 3 }}
        >
          {isProcessing ? "Processing…" : "🎤 Transcribe & Generate"}
        </button>
        {file && !isProcessing && (
          <button className="btn-ghost" onClick={handleClear} style={{ flex: 1 }}>
            Clear
          </button>
        )}
      </div>

      {/* Info */}
      <p style={{ fontSize: "10px", color: "#666", marginTop: "12px", lineHeight: "1.5" }}>
        Powered by WhisperX — word-level timestamp accuracy ±30ms.
        Processing time: ~1 min per 10 min of audio.
      </p>
    </div>
  );
}
