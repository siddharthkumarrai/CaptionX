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

export default function StylePicker({ styleConfig, onChange }) {
  function update(key, value) {
    onChange({ ...styleConfig, [key]: value });
  }

  return (
    <div>
      <p className="section-header">Caption Style</p>

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
      <button className="btn-primary" onClick={() => alert("Preset saving coming in v1.1")}>
        💾 Save as Preset
      </button>
    </div>
  );
}
