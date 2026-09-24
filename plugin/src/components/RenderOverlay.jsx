import React from "react";

/**
 * RenderOverlay — full-panel progress modal for render + timeline placement.
 *
 * Shows while captions render on the server and while clips are placed with
 * ExtendScript: live headline ("Rendering caption 147 of 286"), animated
 * percent bar, and a Cancel button that detaches the panel from the job.
 * Cancelling never touches the Premiere timeline — clips placed so far stay.
 */
export default function RenderOverlay({
  mode = "rendering", // "rendering" | "placing"
  headline = "Working…",
  percent = 0,
  subline = "",
  onCancel,
}) {
  const pct = Math.max(0, Math.min(100, Math.round(percent) || 0));
  return (
    <div className="render-overlay" role="dialog" aria-live="polite" aria-label="Rendering captions">
      <div className="render-card">
        <div className="render-mark" aria-hidden="true">
          <span className="render-mark-cc">CC</span>
          <span className="render-mark-ring" />
        </div>
        <p className="render-eyebrow">
          {mode === "placing" ? "PLACING ON TIMELINE" : "RENDERING YOUR CAPTIONS"}
        </p>
        <p className="render-headline">
          {headline} <span className="render-pct">{pct}%</span>
        </p>
        <div className="render-track">
          <div className="render-fill" style={{ width: `${pct}%` }} />
        </div>
        {subline && <p className="render-sub">{subline}</p>}
        <button className="render-cancel" onClick={onCancel}>
          Cancel rendering
        </button>
      </div>
    </div>
  );
}
