import React from "react";

const FONT_OPTIONS = [
  { value: "Montserrat-ExtraBold", label: "Montserrat ExtraBold" },
  { value: "Anton", label: "Anton" },
  { value: "Poppins-Bold", label: "Poppins Bold" },
  { value: "Bebas-Neue", label: "Bebas Neue" },
  { value: "Impact", label: "Impact" },
];

const ANIMATION_OPTIONS = [
  { value: "none",       label: "No Animation" },
  { value: "fade_in",    label: "Fade In" },
  { value: "pop_scale",  label: "Pop & Scale" },
  { value: "slide_up",   label: "Slide Up" },
  { value: "bounce",     label: "Bounce" },
];

const CAPTION_MODES = [
  { value: "one_word",   label: "One Word" },
  { value: "two_words",  label: "Two Words" },
  { value: "full_phrase",label: "Full Phrase" },
];

// One-click presets (same set as PreviewPanel shortcuts).
const STYLE_PRESETS = [
  { id: "kinetic", name: "Kinetic Focus", font_family: "Montserrat-ExtraBold", font_size: 96, text_color: "#FFFFFF", highlight_color: "#FFD700", bg_color: "#000000", bg_opacity: 0, animation_preset: "pop_scale" },
  { id: "clean", name: "Clean Word Progress", font_family: "Poppins-Bold", font_size: 80, text_color: "#1A1A1A", highlight_color: "#1A1A1A", bg_color: "#FFFFFF", bg_opacity: 0.95, animation_preset: "fade_in" },
  { id: "impact", name: "Impact Pulse", font_family: "Anton", font_size: 110, text_color: "#00E5FF", highlight_color: "#FFFFFF", bg_color: "#000000", bg_opacity: 0.55, animation_preset: "bounce" },
  { id: "editorial", name: "Editorial Serif", font_family: "Poppins-Bold", font_size: 72, text_color: "#FFFFFF", highlight_color: "#FFB84D", bg_color: "#000000", bg_opacity: 0.35, animation_preset: "slide_up" },
];

export default function StylePicker({ styleConfig, onChange, captionLayout, onLayoutChange }) {
  function update(key, value) {
    onChange({ ...styleConfig, [key]: value });
  }

  function applyPreset(p) {
    onChange({
      ...styleConfig,
      font_family: p.font_family,
      font_size: p.font_size,
      text_color: p.text_color,
      highlight_color: p.highlight_color,
      bg_color: p.bg_color,
      bg_opacity: p.bg_opacity,
      animation_preset: p.animation_preset,
    });
  }

  return (
    <div>
      <p className="section-header">Caption Style</p>
      {/* One-click presets (viral-caption UX research) */}
      <div className="field-group">
        <label className="field-label">Style presets</label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
          {STYLE_PRESETS.map((p) => (
            <button
              key={p.id}
              className="btn-ghost"
              onClick={() => applyPreset(p)}
              title={`${p.font_family} · ${p.animation_preset}`}
              style={{ textAlign: "left" }}
            >
              <span style={{ fontWeight: "800", color: "#e0e0e0", display: "block", fontSize: "11px" }}>{p.name}</span>
              <span style={{ fontSize: "9px", color: "#888" }}>{p.animation_preset}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Font Family */}
      <div className="field-group">
        <label className="field-label">Font Family</label>
        <select
          className="field-select"
          value={styleConfig.font_family}
          onChange={(e) => update("font_family", e.target.value)}
        >
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      {/* Font Size */}
      <div className="field-group">
        <label className="field-label">Font Size — {styleConfig.font_size}px</label>
        <input
          type="range" min="40" max="120" step="2"
          value={styleConfig.font_size}
          onChange={(e) => update("font_size", Number(e.target.value))}
        />
      </div>

      {/* Colors */}
      <div className="field-group">
        <label className="field-label">Text & Highlight Colors</label>
        <div className="field-row">
          <input
            type="color"
            value={styleConfig.text_color}
            onChange={(e) => update("text_color", e.target.value)}
            title="Text Color"
          />
          <span style={{ fontSize: "10px", color: "#888" }}>Text</span>
          <input
            type="color"
            value={styleConfig.highlight_color}
            onChange={(e) => update("highlight_color", e.target.value)}
            title="Highlight / Active Word Color"
          />
          <span style={{ fontSize: "10px", color: "#888" }}>Highlight</span>
        </div>
      </div>

      {/* Background */}
      <div className="field-group">
        <label className="field-label">Background Color</label>
        <div className="field-row">
          <input
            type="color"
            value={styleConfig.bg_color}
            onChange={(e) => update("bg_color", e.target.value)}
          />
          <span style={{ fontSize: "10px", color: "#888", flexShrink: 0 }}>
            Opacity {Math.round(styleConfig.bg_opacity * 100)}%
          </span>
          <input
            type="range" min="0" max="1" step="0.05"
            value={styleConfig.bg_opacity}
            onChange={(e) => update("bg_opacity", parseFloat(e.target.value))}
            style={{ flex: 1 }}
          />
        </div>
      </div>

      <hr className="divider" />
      <p className="section-header">Caption Grouping</p>

      {/* Caption Mode */}
      <div className="field-group">
        <label className="field-label">Words per Caption</label>
        <div style={{ display: "flex", gap: "6px" }}>
          {CAPTION_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => update("caption_mode", m.value)}
              style={{
                flex: 1,
                padding: "6px 4px",
                fontSize: "10px",
                fontWeight: "600",
                border: "1px solid",
                borderRadius: "6px",
                cursor: "pointer",
                borderColor: styleConfig.caption_mode === m.value ? "#4a90d9" : "#444",
                background: styleConfig.caption_mode === m.value ? "#1a3a5c" : "#2a2a2a",
                color: styleConfig.caption_mode === m.value ? "#90b8f8" : "#888",
                transition: "all 0.15s",
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Max words per line */}
      <div className="field-group">
        <label className="field-label">Max Words per Line — {styleConfig.max_words_per_line}</label>
        <input
          type="range" min="1" max="5" step="1"
          value={styleConfig.max_words_per_line}
          onChange={(e) => update("max_words_per_line", Number(e.target.value))}
        />
      </div>

      <hr className="divider" />
      <p className="section-header">Animation & SFX</p>

      {/* Animation Preset */}
      <div className="field-group">
        <label className="field-label">Animation Preset</label>
        <select
          className="field-select"
          value={styleConfig.animation_preset}
          onChange={(e) => update("animation_preset", e.target.value)}
        >
          {ANIMATION_OPTIONS.map((a) => (
            <option key={a.value} value={a.value}>{a.label}</option>
          ))}
        </select>
      </div>

      {/* SFX Toggle */}
      <div className="toggle-row">
        <span className="toggle-label">Word Pop SFX</span>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={styleConfig.sfx_enabled}
            onChange={(e) => update("sfx_enabled", e.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {/* Style Preset Save */}
      <hr className="divider" />
      <p className="section-header">Caption position</p>
      <div className="field-group">
        <label className="field-label">Placement — X {(captionLayout?.x ?? 960)}px · Y {(captionLayout?.y ?? 830)}px</label>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <span style={{ fontSize: "10px", color: "#888", width: "14px" }}>X</span>
          <input
            type="range" min="0" max="1920" step="1"
            value={captionLayout?.x ?? 960}
            onChange={(e) => onLayoutChange && onLayoutChange({ x: Number(e.target.value), y: captionLayout?.y ?? 830 })}
            style={{ flex: 1 }}
          />
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "6px" }}>
          <span style={{ fontSize: "10px", color: "#888", width: "14px" }}>Y</span>
          <input
            type="range" min="0" max="1080" step="1"
            value={captionLayout?.y ?? 830}
            onChange={(e) => onLayoutChange && onLayoutChange({ x: captionLayout?.x ?? 960, y: Number(e.target.value) })}
            style={{ flex: 1 }}
          />
        </div>
        <p style={{ fontSize: "10px", color: "#666", marginTop: "6px" }}>
          Tip: drag the caption directly on the preview for pixel control — render matches preview.
        </p>
      </div>
      <button className="btn-primary" onClick={() => alert("Preset saving coming in v1.1")}>
        💾 Save as Preset
      </button>
    </div>
  );
}
