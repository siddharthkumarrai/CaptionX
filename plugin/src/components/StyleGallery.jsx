import React, { useState } from "react";

/**
 * StyleGallery — Backstage-style caption preset picker.
 *
 * Every preset only touches fields the render worker honours
 * (font/size/colors/background/animation), so what you click is what the
 * timeline MOVs look like. The card thumbnails are live HTML previews of
 * the same mapping the caption stage uses.
 */
export const STYLE_PRESETS = [
  { id: "kinetic", name: "Kinetic Focus", sample: ["The", "biggest", "mistake"], hero: 2, font_family: "Montserrat-ExtraBold", font_size: 96, text_color: "#FFFFFF", highlight_color: "#FFD700", bg_color: "#000000", bg_opacity: 0, animation_preset: "pop_scale" },
  { id: "clean", name: "Clean Word Progress", sample: ["The", "quick", "brown", "fox"], hero: 3, font_family: "Poppins-Bold", font_size: 80, text_color: "#1A1A1A", highlight_color: "#1A1A1A", bg_color: "#FFFFFF", bg_opacity: 0.95, animation_preset: "fade_in" },
  { id: "impact", name: "Impact Pulse", sample: ["LIFE", "IS", "A"], hero: 2, font_family: "Anton", font_size: 110, text_color: "#00E5FF", highlight_color: "#FFFFFF", bg_color: "#000000", bg_opacity: 0.55, animation_preset: "bounce" },
  { id: "editorial", name: "Editorial Serif", sample: ["start", "building", "momentum"], hero: 2, font_family: "Poppins-Bold", font_size: 72, text_color: "#FFFFFF", highlight_color: "#FFB84D", bg_color: "#000000", bg_opacity: 0.35, animation_preset: "slide_up" },
  { id: "red-hero", name: "Red Hero", sample: ["and", "the", "REASON"], hero: 2, font_family: "Anton", font_size: 96, text_color: "#FFFFFF", highlight_color: "#FF2D2D", bg_color: "#000000", bg_opacity: 0.45, animation_preset: "pop_scale" },
  { id: "bubble", name: "Bubble Pop", sample: ["BOOM"], hero: 0, font_family: "Poppins-Bold", font_size: 110, text_color: "#FFFFFF", highlight_color: "#7C6CFF", bg_color: "#000000", bg_opacity: 0.55, animation_preset: "bounce" },
  { id: "punch", name: "Punch Caps", sample: ["START", "SMALL"], hero: 1, font_family: "Montserrat-ExtraBold", font_size: 92, text_color: "#FFFFFF", highlight_color: "#FF6B4A", bg_color: "#000000", bg_opacity: 0, animation_preset: "pop_scale" },
  { id: "neon", name: "Neon Script", sample: ["wait", "for", "it"], hero: 2, font_family: "Poppins-Bold", font_size: 88, text_color: "#FFFFFF", highlight_color: "#00E5FF", bg_color: "#0A0A14", bg_opacity: 0.75, animation_preset: "fade_in" },
  { id: "mono-label", name: "Mono Label", sample: ["SWITCH", "TO", "APERTURE"], hero: 2, font_family: "Poppins-Bold", font_size: 64, text_color: "#D8D8D8", highlight_color: "#FFFFFF", bg_color: "#111111", bg_opacity: 0.85, animation_preset: "none" },
  { id: "serif-accent", name: "Serif Accent", sample: ["Select", "the", "new"], hero: 2, font_family: "Poppins-Bold", font_size: 84, text_color: "#FFFFFF", highlight_color: "#FFD166", bg_color: "#000000", bg_opacity: 0, animation_preset: "slide_up" },
  { id: "keyword", name: "Keyword Underline", sample: ["If", "you", "wanna", "try"], hero: 3, font_family: "Montserrat-ExtraBold", font_size: 84, text_color: "#FFFFFF", highlight_color: "#52B788", bg_color: "#000000", bg_opacity: 0, animation_preset: "fade_in" },
  { id: "hot", name: "Hot Highlight", sample: ["DISCIPLINE", "BUILDS", "EVERYTHING"], hero: 1, font_family: "Anton", font_size: 80, text_color: "#FFFFFF", highlight_color: "#FF2D78", bg_color: "#000000", bg_opacity: 0.5, animation_preset: "pop_scale" },
];

const FONT_OPTIONS = [
  { value: "Montserrat-ExtraBold", label: "Montserrat ExtraBold" },
  { value: "Anton", label: "Anton" },
  { value: "Poppins-Bold", label: "Poppins Bold" },
  { value: "Bebas-Neue", label: "Bebas Neue" },
  { value: "Impact", label: "Impact" },
];

const ANIMATION_OPTIONS = [
  { value: "none", label: "No Animation" },
  { value: "fade_in", label: "Fade In" },
  { value: "pop_scale", label: "Pop & Scale" },
  { value: "slide_up", label: "Slide Up" },
  { value: "bounce", label: "Bounce" },
];

const CAPTION_MODES = [
  { value: "one_word", label: "1" },
  { value: "two_words", label: "2" },
  { value: "full_phrase", label: "Phrase" },
];

function hexWithOpacity(hex, opacity) {
  const o = Math.max(0, Math.min(1, Number(opacity) || 0));
  if (o <= 0) return "transparent";
  const h = String(hex || "#000000").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return `#${full}${Math.round(o * 255).toString(16).padStart(2, "0")}`;
}

function PresetCard({ preset, active, onPick }) {
  return (
    <button
      className={`style-card ${active ? "style-card-active" : ""}`}
      onClick={onPick}
      title={`${preset.font_family} · ${preset.animation_preset}`}
    >
      <span className="style-thumb">
        <span
          className="style-thumb-caption"
          style={{
            background: hexWithOpacity(preset.bg_color, preset.bg_opacity),
            borderRadius: "6px",
            padding: preset.bg_opacity > 0 ? "4px 8px" : "0",
          }}
        >
          {preset.sample.map((w, i) => (
            <span
              key={i}
              style={{
                color: i <= preset.hero ? preset.highlight_color : preset.text_color,
                fontFamily: preset.font_family.replace(/-/g, " "),
                fontWeight: 800,
              }}
            >
              {w}
              {i < preset.sample.length - 1 ? " " : ""}
            </span>
          ))}
        </span>
      </span>
      <span className="style-card-foot">
        <span className="style-card-name">{preset.name}</span>
        {active && <span className="style-card-check">✓</span>}
      </span>
    </button>
  );
}

export default function StyleGallery({ styleConfig, onChange }) {
  const [customOpen, setCustomOpen] = useState(false);
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
  const activeId = STYLE_PRESETS.find(
    (p) =>
      p.font_family === styleConfig.font_family &&
      p.animation_preset === styleConfig.animation_preset &&
      p.text_color === styleConfig.text_color &&
      p.highlight_color === styleConfig.highlight_color
  )?.id;

  return (
    <div className="style-gallery">
      <p className="section-header">Caption style</p>
      <div className="style-grid style-grid-capped">
        {STYLE_PRESETS.map((p) => (
          <PresetCard key={p.id} preset={p} active={p.id === activeId} onPick={() => applyPreset(p)} />
        ))}
      </div>

      <button
        className="drawer-toggle"
        onClick={() => setCustomOpen((v) => !v)}
        aria-expanded={customOpen}
      >
        <span>{customOpen ? "▾" : "▸"} Customize — font, size, colors, animation</span>
      </button>
      {customOpen && (
      <div className="customize-drawer">
      <div className="field-group">
        <label className="field-label">Font</label>
        <select className="field-select" value={styleConfig.font_family} onChange={(e) => update("font_family", e.target.value)}>
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      <div className="field-group">
        <label className="field-label">Text size — {styleConfig.font_size}px</label>
        <input type="range" min="40" max="140" step="2" value={styleConfig.font_size} onChange={(e) => update("font_size", Number(e.target.value))} />
      </div>

      <div className="field-group">
        <label className="field-label">Words per caption</label>
        <div style={{ display: "flex", gap: "6px" }}>
          {CAPTION_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => update("caption_mode", m.value)}
              className={`seg-btn ${styleConfig.caption_mode === m.value ? "seg-btn-active" : ""}`}
              title={m.value === "full_phrase" ? "Full phrase" : `${m.label} word${m.label === "1" ? "" : "s"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field-group">
        <label className="field-label">Text & highlight</label>
        <div className="field-row">
          <input type="color" value={styleConfig.text_color} onChange={(e) => update("text_color", e.target.value)} title="Text color" />
          <span className="field-hint">Text</span>
          <input type="color" value={styleConfig.highlight_color} onChange={(e) => update("highlight_color", e.target.value)} title="Highlight color" />
          <span className="field-hint">Highlight</span>
        </div>
      </div>

      <div className="field-group">
        <label className="field-label">Background — {Math.round(styleConfig.bg_opacity * 100)}%</label>
        <div className="field-row">
          <input type="color" value={styleConfig.bg_color} onChange={(e) => update("bg_color", e.target.value)} title="Background color" />
          <input type="range" min="0" max="1" step="0.05" value={styleConfig.bg_opacity} onChange={(e) => update("bg_opacity", parseFloat(e.target.value))} style={{ flex: 1 }} />
        </div>
      </div>

      <div className="field-group">
        <label className="field-label">Animation</label>
        <select className="field-select" value={styleConfig.animation_preset} onChange={(e) => update("animation_preset", e.target.value)}>
          {ANIMATION_OPTIONS.map((a) => (
            <option key={a.value} value={a.value}>{a.label}</option>
          ))}
        </select>
      </div>

      <div className="toggle-row">
        <span className="toggle-label">Word pop sound</span>
        <label className="toggle-switch">
          <input type="checkbox" checked={styleConfig.sfx_enabled} onChange={(e) => update("sfx_enabled", e.target.checked)} />
          <span className="toggle-slider" />
        </label>
      </div>
      </div>
      )}
    </div>
  );
}
