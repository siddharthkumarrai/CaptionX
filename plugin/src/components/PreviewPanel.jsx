import React, { useState } from "react";

export default function PreviewPanel({ jobResult, styleConfig }) {
  const [activeIndex, setActiveIndex] = useState(0);

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

  const { phrases } = jobResult;
  const current = phrases[activeIndex];

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(2).padStart(5, "0");
    return `${m}:${s}`;
  }

  return (
    <div>
      <p className="section-header">
        Caption Preview — {phrases.length} phrase{phrases.length !== 1 ? "s" : ""}
      </p>

      {/* Visual Caption Preview */}
      <div
        style={{
          background: "#111",
          borderRadius: "8px",
          aspectRatio: "16/9",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          padding: "0 12px 18px",
          marginBottom: "12px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Simulated video frame */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
            opacity: 0.6,
          }}
        />
        {/* Caption overlay */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            background:
              styleConfig.bg_opacity > 0
                ? `${styleConfig.bg_color}${Math.round(styleConfig.bg_opacity * 255)
                    .toString(16)
                    .padStart(2, "0")}`
                : "transparent",
            borderRadius: "8px",
            padding: styleConfig.bg_opacity > 0 ? "6px 14px" : "0",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: "6px",
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            {current.words.map((w, i) => (
              <span
                key={i}
                style={{
                  fontSize: `${Math.round(styleConfig.font_size * 0.22)}px`,
                  fontWeight: "900",
                  color:
                    i === 0
                      ? styleConfig.highlight_color
                      : styleConfig.text_color,
                  fontFamily: styleConfig.font_family.replace(/-/g, " "),
                  textShadow: "0 2px 8px rgba(0,0,0,0.8)",
                  transition: "color 0.1s",
                }}
              >
                {w.word}
              </span>
            ))}
          </div>
        </div>
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

      {/* Navigation */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
        <button
          className="btn-ghost"
          onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
          disabled={activeIndex === 0}
          style={{ flex: 1 }}
        >
          ← Prev
        </button>
        <span style={{ fontSize: "11px", color: "#888", flexShrink: 0 }}>
          {activeIndex + 1} / {phrases.length}
        </span>
        <button
          className="btn-ghost"
          onClick={() => setActiveIndex((i) => Math.min(phrases.length - 1, i + 1))}
          disabled={activeIndex === phrases.length - 1}
          style={{ flex: 1 }}
        >
          Next →
        </button>
      </div>

      {/* Word list for current phrase */}
      <div style={{ background: "#2a2a2a", borderRadius: "8px", padding: "10px" }}>
        <p style={{ fontSize: "10px", color: "#888", marginBottom: "8px", fontWeight: "700", textTransform: "uppercase" }}>
          Words in this phrase
        </p>
        {current.words.map((w, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "4px 0",
              borderBottom: i < current.words.length - 1 ? "1px solid #333" : "none",
            }}
          >
            <span style={{ fontSize: "12px", fontWeight: "700", color: "#e0e0e0" }}>
              {w.word}
            </span>
            <span style={{ fontSize: "10px", color: "#888", fontFamily: "monospace" }}>
              {formatTime(w.start)} → {formatTime(w.end)}
            </span>
            <span
              style={{
                fontSize: "9px",
                color: w.score > 0.8 ? "#52b788" : w.score > 0.5 ? "#c8b830" : "#e05252",
                fontWeight: "600",
              }}
            >
              {Math.round(w.score * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
