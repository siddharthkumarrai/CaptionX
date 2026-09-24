import React, { useState, useEffect, useMemo, useRef } from "react";
import AuthGate from "./AuthGate";
import StyleGallery from "./StyleGallery";
import TranscribePanel from "./TranscribePanel";
import PreviewPanel from "./PreviewPanel";
import TimelinePanel from "./TimelinePanel";
import TimingPanel from "./TimingPanel";
import { getActiveSequence, getSequenceResolution } from "../hooks/usePremiere";
import { getActiveSequenceInfo, getVideoPathCep } from "../api/cep";
import { parseSrt } from "../api/srt";
import useTimelineFrame from "../hooks/useTimelineFrame";
import { apiClient, getStoredToken, clearToken, getApiBaseUrl } from "../api/client";
import "./App.css";

const TABS = ["Style", "Transcribe", "Preview", "Timeline"];

// Per-project transcript cache: { "<projectPath>::<sequenceID>": jobResult }.
// A new Premiere project must never inherit the previous one's transcription.
function readTranscriptMap() {
  try {
    const raw = localStorage.getItem("captionx:transcripts");
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

const FALLBACK_SEQUENCE_NAMES = new Set([
  "Active sequence",
  "Premiere not connected",
  "No active sequence",
]);

export function projectKeyFor(info) {
  // Normalised + filtered: a transient/failed probe (empty id, fallback
  // display name) must never forge a key — a forging key swaps a stale
  // transcript over the user's just-saved edits and leaves "unsaved" stuck.
  const path = String(info?.projectPath || "").replace(/\\/g, "/");
  const seq = String(info?.sequenceID || info?.name || "");
  if (!path || !seq || FALLBACK_SEQUENCE_NAMES.has(seq)) return "";
  return `${path}::${seq}`;
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userPlan, setUserPlan] = useState(null);
  const [userEmail, setUserEmail] = useState("");
  const [screen, setScreen] = useState("dashboard");
  const [jobResult, setJobResult] = useState(() => {
    // Restore the last transcript so revisiting the panel (or the transcript
    // page) shows the existing transcription instead of "NO TRANSCRIPT YET".
    // Scoped per project below — this first paint is corrected as soon as
    // Premiere reports the active project/sequence.
    try {
      const raw = localStorage.getItem("captionx:lastTranscript");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }); // { phrases, words, job_id }
  const [videoUrl, setVideoUrl] = useState("");
  // Identity of the active Premiere project+sequence. Transcripts are cached
  // per key so a new project never inherits the previous one's transcription.
  const [projectKey, setProjectKey] = useState("");
  // P1 session flag (declared up here with all other hooks — nothing hook-like
  // may live below the AuthGate early-return or React throws #310).
  const [continuedThisSession, setContinuedThisSession] = useState(false);
  const [sequence, setSequence] = useState({ name: "Active sequence", width: null, height: null });
  const [sequenceState, setSequenceState] = useState("checking");
  // A sequence is "active" only when Premiere reports one with resolvable media.
  const [hasSequence, setHasSequence] = useState(false);
  // Top-level render safety net surfaced from completion callbacks.
  const [error, setError] = useState("");
  const [styleConfig, setStyleConfig] = useState({
    font_family: "Montserrat-ExtraBold",
    font_size: 80,
    text_color: "#FFFFFF",
    highlight_color: "#FFD700",
    bg_color: "#000000",
    bg_opacity: 0.6,
    caption_mode: "two_words",
    animation_preset: "pop_scale",
    sfx_enabled: true,
    max_words_per_line: 2,
  });
  // Caption placement on the 1920x1080 render canvas (px). Drag in the
  // preview or nudge with sliders/arrows — sent to the render worker so the
  // placed MOV matches the preview pixel-for-pixel.
  const [captionLayout, setCaptionLayout] = useState({ x: 960, y: 830 });

  // Persist transcript edits across panel reloads, scoped to the active
  // Premiere project+sequence (a new project starts blank, never with the
  // previous project's transcript).
  useEffect(() => {
    try {
      const map = readTranscriptMap();
      if (projectKey) {
        if (jobResult?.words?.length) {
          map[projectKey] = jobResult;
        } else {
          delete map[projectKey];
        }
        localStorage.setItem("captionx:transcripts", JSON.stringify(map));
      }
      // Legacy global key: keep in sync for first paint, clear it once a
      // project key is known so stale data can't leak across projects.
      if (jobResult?.words?.length) {
        localStorage.setItem("captionx:lastTranscript", JSON.stringify(jobResult));
      } else {
        localStorage.removeItem("captionx:lastTranscript");
      }
    } catch {
      /* storage unavailable */
    }
  }, [jobResult, projectKey]);

  // Swap the visible transcript whenever the active project/sequence changes.
  useEffect(() => {
    if (!projectKey) return;
    try {
      const map = readTranscriptMap();
      setJobResult(map[projectKey] || null);
    } catch {
      /* keep current */
    }
  }, [projectKey]);

  // Resolve the first timeline clip's media path so the caption studio and
  // transcript review can play the ORIGINAL video instead of a fake background.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    getVideoPathCep()
      .then((res) => {
        // getVideoPathCep resolves { path, url, duration, … } — we need url only.
        if (!cancelled && res?.url) {
          setVideoUrl(res.url);
          // Identity for the per-project transcript cache (never adopt an
          // empty key — it would swap a stale transcript over current work).
          setProjectKey((prev) => projectKeyFor(res) || prev);
          // Keep the project's real resolution + frame rate so the preview stage
          // matches the sequence (vertical reel vs horizontal) and the transcript
          // editor steps frame-accurately instead of assuming 30 fps.
          setSequence((prev) => ({
            ...prev,
            width: res.width || prev.width,
            height: res.height || prev.height,
            fps: res.fps || prev.fps,
          }));
        }
      })
      .catch(() => {
        /* no sequence / not in CEP — gradient fallback stays */
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, sequence?.name]);

  // Called by the caption studio after frame-by-frame caption edits.
  // Updates panel state FIRST so edits are always visible in the studio,
  // then syncs to the transcript API (a backend failure must never hide an
  // edit the user just made).
  async function saveTranscriptEdits(nextWords, nextPhrases) {
    const jobId = jobResult?.job_id;
    setJobResult((prev) => (prev ? { ...prev, words: nextWords.map((w) => ({ ...w })), phrases: nextPhrases } : prev));
    if (!jobId || String(jobId).startsWith("imported-")) return { synced: false };
    try {
      await apiClient.put(`/api/jobs/${jobId}/transcript`, { words: nextWords, phrases: nextPhrases });
      return { synced: true };
    } catch (e) {
      console.warn("[CaptionX] transcript sync failed, edits kept in panel:", e?.message || e);
      return { synced: false };
    }
  }

  // Remove the current transcript everywhere: server job record first
  // (own jobs only), then the scoped panel cache + visible state.
  // Pessimistic UI — the panel clears immediately; only a server failure
  // rolls the snapshot back with an explanatory note.
  async function removeTranscript() {
    const snapshot = jobResult;
    const jobId = snapshot?.job_id;
    setJobResult(null);
    if (jobId && !String(jobId).startsWith("imported-")) {
      try {
        await apiClient.delete(`/api/jobs/${jobId}`);
      } catch (e) {
        setJobResult(snapshot);
        setError(
          e.response?.data?.detail ||
          e.message ||
          "Could not remove the transcript on the server — local copy restored."
        );
        return false;
      }
    }
    return true;
  }

  useEffect(() => {
    const token = getStoredToken();
    if (token) {
      validateToken(token);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) detectSequence();
  }, [isAuthenticated]);

  // Autorefresh the active-sequence state every few seconds so dropping a clip
  // onto the Premiere timeline is reflected immediately without a reload.
  useEffect(() => {
    if (!isAuthenticated) return;
    detectSequence();
    const id = setInterval(detectSequence, 5000);
    return () => clearInterval(id);
  }, [isAuthenticated]);

  async function detectSequence() {
    setSequenceState("checking");
    let resolved = false;
    // 1) Prefer the UXP async API.
    try {
      const { sequence: active } = await getActiveSequence();
      if (!active) throw new Error("No active sequence. Please open a sequence in the timeline.");
      const resolution = await getSequenceResolution();
      // Normalise the UXP `frameRate` into the `fps` field the panel consumes so
      // frame-stepping matches the real project timebase (not a hardcoded 30).
      const fps = Number(resolution?.frameRate) > 0 ? Math.round(Number(resolution.frameRate) * 1000) / 1000 : 0;
      setSequence({ name: active?.name || "Active sequence", ...resolution, fps });
      setSequenceState("ready");
      setHasSequence(true);
      resolved = true;
    } catch {
      /* UXP unavailable or no sequence — fall through to the CEP path. */
    }
    // 2) Fallback to the legacy CEP / ExtendScript bridge.
    if (!resolved) {
      try {
        const info = await getActiveSequenceInfo();
        setSequence({
          name: info.name || "Active sequence",
          width: info.width || null,
          height: info.height || null,
          fps: info.fps || 0,
          audioPath: info.audioPath,
        });
        setSequenceState("ready");
        setHasSequence(true);
        // Identity for the per-project transcript cache (also set from the
        // video-path probe — whichever answers first wins).
        setProjectKey((prev) => projectKeyFor(info) || prev);
      } catch (cepError) {
        const msg = String(cepError?.message || cepError || "");
        if (msg.includes("Open a Premiere sequence first") || msg.includes("No active sequence")) {
          setSequence({ name: "No active sequence", width: null, height: null, fps: 0, audioPath: null });
          setSequenceState("no-sequence");
          setHasSequence(false);
        } else {
          setSequence({ name: "Premiere not connected", width: null, height: null, fps: 0, audioPath: null });
          setSequenceState("fallback");
          setHasSequence(false);
        }
      }
    }
  }

  async function validateToken(token) {
    try {
      const res = await apiClient.get("/api/auth/validate");
      if (res.data.valid) {
        setIsAuthenticated(true);
        setUserPlan(res.data.plan);
        setUserEmail(res.data.email || "");
      } else {
        clearToken();
      }
    } catch {
      clearToken();
    }
  }

  function handleLoginSuccess(plan) {
    setIsAuthenticated(true);
    setUserPlan(plan);
  }

  function handleLogout() {
    clearToken();
    setIsAuthenticated(false);
    setUserPlan(null);
  }

  if (!isAuthenticated) {
    return <AuthGate onLoginSuccess={handleLoginSuccess} />;
  }

  const hasTranscript = Boolean(jobResult?.phrases?.length);
  const open = (target) => setScreen(target);
  // P1: the transcript is the source of truth — nothing reaches the studio
  // without an explicit Continue. This session flag remembers that choice so
  // re-opening the panel doesn't force the user back every single time.
  // NOTE: no hooks may live below the AuthGate early-return; hook state for
  // this flag lives at the top of App (see continuedThisSessionState).
  const goStudio = () => { setContinuedThisSession(true); open("studio"); };
  // Studio entry gate: a saved transcript the user hasn't continued from
  // this session routes to Transcript Review first.
  const openGated = (target) => {
    if (target === "studio" && hasTranscript && !continuedThisSession) open("transcript");
    else open(target);
  };
  // Backend H.264 proxy of the timeline media: real motion for any source
  // codec (HEVC plays nowhere in Chromium). <video> tries this first, then
  // the direct file:// URL, then the exported frame still. Empty for local
  // (imported) transcripts, which have no backend media job.
  const previewUrl = (() => {
    const id = jobResult?.job_id;
    if (!id || String(id).startsWith("imported-")) return "";
    let token = "";
    try {
      token = getStoredToken() || "";
    } catch {
      token = "";
    }
    if (!token) return "";
    return `${getApiBaseUrl()}/api/jobs/${id}/preview.mp4?token=${encodeURIComponent(token)}`;
  })();
  return (
    <div className="app">
      <header className="app-header product-header">
        <button className="icon-button menu-button" onClick={() => open("dashboard")} title="Dashboard">☰</button>
        <div className="app-logo"><span className="logo-mark">✦</span><div><span className="brand-kicker">CAPTIONX LABS</span><span className="logo-text">Caption<span className="logo-x">X</span></span></div></div>
        <div className="sequence-pill"><span className={hasSequence ? "live-dot" : "dot-off"} />{sequenceState === "checking" ? "Checking sequence…" : sequence.name}</div>
        <button className="btn-ghost refresh-btn" onClick={detectSequence} title="Refresh active sequence" disabled={sequenceState === "checking"}>⟳</button>
        <div className="header-right">{userEmail && <span className="user-name" title={userEmail}>{userEmail}</span>}{hasTranscript && <span className="transcript-pill">{jobResult.phrases.length} transcript entries</span>}<span className={`plan-badge plan-${userPlan}`}>{userPlan}</span><button className="btn-ghost logout-btn" onClick={handleLogout} title="Sign out">↩</button></div>
       </header>
       {error && (
         <div style={{ background: "rgba(120,40,40,0.18)", color: "#e05252", fontSize: "11px", padding: "8px 16px", borderBottom: "1px solid #6b2020" }}>
           ⚠ {error}
         </div>
       )}
        <main className="workspace">
          {screen === "dashboard" && <Dashboard sequence={sequence} sequenceState={sequenceState} hasSequence={hasSequence} hasTranscript={hasTranscript} jobResult={jobResult} onOpen={openGated} />}
          {screen === "transcript" && <TranscriptScreen sequence={sequence} hasSequence={hasSequence} styleConfig={styleConfig} jobResult={jobResult} setJobResult={setJobResult} videoUrl={videoUrl} previewUrl={previewUrl} fps={sequence?.fps || 0} onContinue={goStudio} onBack={() => open("dashboard")} onRemove={removeTranscript} onComplete={(result) => { try { if (!result || !result.phrases || !result.words) { console.error("[CaptionX] incomplete transcript result", result); setError("Transcription finished but no usable output was returned."); open("dashboard"); return; } setJobResult(result); setSequenceState("ready"); /* P1: stay on Transcript Review — the user continues explicitly. */ } catch (e) { console.error("[CaptionX] failed to store transcript", e); } }} />}
          {screen === "studio" && (
        <StudioScreen
          jobResult={jobResult}
          setJobResult={setJobResult}
          styleConfig={styleConfig}
          setStyleConfig={setStyleConfig}
          captionLayout={captionLayout}
          setCaptionLayout={setCaptionLayout}
          hasSequence={hasSequence}
          videoUrl={videoUrl}
          previewUrl={previewUrl}
          fps={sequence?.fps || 0}
          sequenceWidth={sequence?.width || 0}
          sequenceHeight={sequence?.height || 0}
          sequenceName={sequence?.name || ""}
          onSaveTranscript={saveTranscriptEdits}
          onBack={() => open("dashboard")}
        />
      )}
      </main>
    </div>
  );
}

export function Dashboard({ sequence, sequenceState, hasSequence, hasTranscript, jobResult, onOpen }) {
  const noSequence = !hasSequence;
  const features = [
    ["transcript", "▤", "Transcript", "Generate, review, and edit", true], ["studio", "CC", "Caption", "Design animated captions", hasTranscript], ["studio", "◩", "Auto Asset", "Match visuals to your words", hasTranscript], ["studio", "⌕", "Add zooms", "Punch in on what matters", hasTranscript],
    ["studio", "◫", "Silence Cut", "Remove quiet sections automatically", hasTranscript], ["studio", "⊞", "Retake Cut", "Keep the good take, cut the rest", hasTranscript], ["studio", "▶", "B-Roll Import", "Place generated clips by manifest", hasTranscript], ["studio", "▣", "A-Roll PIP", "Circle face-cam over your screen", hasTranscript],
    ["studio", "☷", "Chapters", "Create YouTube timestamps", hasTranscript], ["studio", "✦", "Emphasis Text", "Keyword pops timed to speech", hasTranscript], ["studio", "◐", "Color Grading", "Analyze and balance footage", hasTranscript], ["studio", "◇", "Presets", "Reusable motion graphics", hasTranscript],
  ];
  return <section className="dashboard-screen"><div className="dashboard-intro"><div><span className="eyebrow">ACTIVE SEQUENCE</span><h1>{sequence.name}</h1><p>{sequenceState === "no-sequence" ? "No active sequence — drop a clip onto the timeline or open a sequence to begin." : sequenceState === "fallback" ? "Premiere is not connected. Open Adobe Premiere and retry." : "Sequence-aware editing tools for your next cut."}</p></div><span className={noSequence ? "locked-badge" : hasTranscript ? "ready-badge" : "locked-badge"}>{noSequence ? "NO SEQUENCE" : hasTranscript ? "TRANSCRIPT READY" : "TRANSCRIPT REQUIRED"}</span></div><div className="community-banner"><span className="banner-icon">◉</span><div><strong>Make the edit feel intentional.</strong><small>Generate a transcript first, then shape every caption with precision.</small></div><button className="btn-quiet" onClick={() => onOpen("transcript")}>{hasTranscript ? "Open transcript" : "Get started"}</button></div><div className="feature-grid">{features.map(([target, icon, title, description, enabled]) => <button className={`feature-card ${enabled ? "" : "feature-locked"}`} key={title} onClick={() => enabled && onOpen(target)}><span className="feature-icon">{icon}</span><span className="feature-copy"><strong>{title}</strong><small>{description}</small></span>{!enabled && <span className="lock-label">LOCKED</span>}</button>)}</div>{hasTranscript && <TranscriptionEntries jobResult={jobResult} />}</section>;
}

export function TranscriptScreen({ sequence, hasSequence, styleConfig, jobResult, setJobResult, videoUrl, previewUrl = "", fps = 0, onContinue, onBack, onComplete, onRemove }) {
  const [importError, setImportError] = useState("");
  const fileRef = useRef(null);
  const hasTranscript = Boolean(jobResult?.phrases?.length);
  const phrases = jobResult?.phrases?.length || 0;

  function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setImportError("");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseSrt(reader.result);
        if (!parsed.words.length) {
          setImportError("No captions found in that SRT file.");
          return;
        }
        // Keep the backend job id when one exists so Save/render keep
        // working; otherwise mark the transcript as a local import.
        onComplete({
          job_id: jobResult?.job_id || `imported-${Date.now()}`,
          words: parsed.words,
          phrases: parsed.phrases,
        });
      } catch {
        setImportError("Could not read that SRT file.");
      }
    };
    reader.onerror = () => setImportError("Could not read that SRT file.");
    reader.readAsText(file);
  }

  return (
    <section className="flow-screen">
      <div className="flow-heading">
        <button className="back-link" onClick={onBack}>←</button>
        <div><span className="eyebrow">TRANSCRIPT</span><h1>Get your transcript ready</h1></div>
        <span className="sequence-caption">{sequence.name}</span>
      </div>
      <div className="import-bar">
        <span>Already have a transcript file?</span>
        <button className="btn-ghost" onClick={() => fileRef.current && fileRef.current.click()}>Import SRT…</button>
        <input ref={fileRef} type="file" accept=".srt,text/plain" style={{ display: "none" }} onChange={handleImportFile} />
      </div>
      {importError && <p className="save-err">⚠ {importError}</p>}
      <div className="transcript-layout">
        <div className="transcript-hero">
          <span className={`status-chip ${hasTranscript ? "status-done" : "status-pending"}`}>{hasTranscript ? `✓ TRANSCRIPT READY — ${phrases} phrases` : "NO TRANSCRIPT YET"}</span>
          <h2>{hasTranscript ? "Your transcript is ready" : "Generate, review, and edit"}</h2>
          <p>CaptionX reads the active Premiere timeline automatically. No file picker or drag-and-drop required.</p>
          <TranscribePanel sequenceName={sequence.name} hasSequence={hasSequence} styleConfig={styleConfig} hasTranscript={hasTranscript} onContinue={onContinue} onJobComplete={onComplete} onRemove={onRemove} />
        </div>
        <aside className="transcript-help">
          <span className="feature-icon">✦</span>
          <h3>Built for the cut</h3>
          <p>Audio comes directly from the first timeline media clip and stays attached to this Premiere project.</p>
          <div className="mini-stat"><strong>±30ms</strong><small>word timing target</small></div>
          <div className="mini-stat"><strong>12+</strong><small>languages supported</small></div>
        </aside>
      </div>
      {hasTranscript && (
        <TranscriptReview
          jobResult={jobResult}
          setJobResult={setJobResult}
          onSaved={onContinue}
          videoUrl={videoUrl}
          previewUrl={previewUrl}
          fps={fps}
          captionMode={styleConfig?.caption_mode || "two_words"}
        />
      )}
    </section>
  );
}

export function StudioScreen({ jobResult, setJobResult, styleConfig, setStyleConfig, captionLayout, setCaptionLayout, hasSequence, onBack, videoUrl, previewUrl = "", onSaveTranscript, fps = 0, sequenceWidth = 0, sequenceHeight = 0, sequenceName = "" }) {
  const [step, setStep] = useState("style");
  const [playTime, setPlayTime] = useState(0);
  const [binName, setBinName] = useState("");
  // Shared seek: TimingPanel's strip calls through to the preview's seekTo
  // (which moves both the clock state and the <video> element).
  const seekRef = useRef(null);
  const steps = [["style", "① Style"], ["timing", "② Timing & Gaps"], ["place", "③ Place"]];
  return (
    <section className="studio-screen studio-wizard">
      <div className="flow-heading">
        <button className="back-link" onClick={onBack}>←</button>
        <div>
          <span className="eyebrow">CAPTION STUDIO</span>
          <h1>Style, place, and preview your captions</h1>
        </div>
        <span className="sequence-caption">{sequenceName}</span>
      </div>
      <div className="studio-tabs" role="tablist" aria-label="Caption studio steps">
        {steps.map(([id, label]) => (
          <button
            key={id} role="tab" aria-selected={step === id}
            className={`studio-tab ${step === id ? "studio-tab-active" : ""}`}
            onClick={() => setStep(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="studio-body">
        <div className="sticky-preview">
          <p className="section-header">Live preview</p>
          <PreviewPanel jobResult={jobResult} styleConfig={styleConfig} captionLayout={captionLayout} onLayoutChange={setCaptionLayout} videoUrl={videoUrl} previewUrl={previewUrl} onSaveTranscript={onSaveTranscript} fps={fps} sequenceWidth={sequenceWidth} sequenceHeight={sequenceHeight} sequenceName={sequenceName} time={playTime} onTimeChange={setPlayTime} seekRef={seekRef} />
        </div>
        <div className="step-pane">
          {step === "style" && <StyleGallery styleConfig={styleConfig} onChange={setStyleConfig} />}
          {step === "timing" && (
            <TimingPanel
              jobResult={jobResult} fps={fps} time={playTime}
              onSeek={(t) => { if (seekRef.current) seekRef.current(t); else setPlayTime(t); }}
              previewUrl={previewUrl} onSaveTranscript={onSaveTranscript}
            />
          )}
          {step === "place" && (
            <TimelinePanel
              jobResult={jobResult} styleConfig={styleConfig} captionLayout={captionLayout}
              hasSequence={hasSequence} sequenceName={sequenceName}
              binName={binName} onBinNameChange={setBinName}
            />
          )}
        </div>
      </div>
    </section>
  );
}

// ── Transcript editor helpers ────────────────────────────────────────────────
// Frame rate used for frame-accurate nudging. Matches the caption studio and
// the render cadence so edited timecodes always land on whole frames.
const REVIEW_FPS = 30;
const MIN_WORD_DURATION = 0.01;

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

// hh:mm:ss:ff — the same notation Premiere shows, so users can compare the
// panel timecode against the timeline while fixing a mis-timed word.
function formatTimecode(seconds, frameRate) {
  const rate = Number(frameRate) > 0 ? Number(frameRate) : 30;
  const total = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(total);
  const frames = Math.min(rate - 1, Math.floor((total - whole) * rate + 1e-6));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

// Inverse of formatTimecode: accepts HH:MM:SS:FF (or MM:SS:FF) and plain
// seconds. Returns NaN when unparseable so callers can ignore the edit.
function parseTimecode(str, frameRate) {
  const s = String(str || "").trim().replace(";", ":");
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?([0-5]?\d):([0-5]?\d)(?::(\d{1,2}))?$/);
  if (!m) return NaN;
  const rate = Number(frameRate) > 0 ? Number(frameRate) : 30;
  const frames = m[4] ? Math.min(rate - 1, Number(m[4])) : 0;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frames / rate;
}

function cloneWords(list) {
  return (list || []).map((w) => ({ ...w }));
}

// A signature of the whole edit surface (order + text + timing + grouping) so
// the Save button lights up for retimes, inserts and deletes — not just renames.
function wordsSignature(list) {
  const rows = list || [];
  return `${rows.length}#${rows
    .map((w) => `${(w.word || "").trim()}|${round4(w.start)}|${round4(w.end)}|${w.segment_id ?? ""}`)
    .join("~")}`;
}

// Review flag: pipeline-recovered words and low-confidence words get an
// amber badge + row border so the eye lands on exactly the entries worth
// checking. Genuine repeats ("do not … do not") carry origin "transcribed"
// with real scores and are deliberately NOT flagged — only pipeline-introduced
// or shaky words get the review treatment. Hand-typed words (score 0, no
// origin) are the user's own and stay unflagged.
function wordNeedsReview(w) {
  if (!w) return false;
  if (String(w.origin || "").startsWith("recovered")) return true;
  const s = Number(w.score || 0);
  return s > 0 && s < 0.70;
}

function wordScoreLabel(w) {
  const s = Number(w.score || 0);
  if (s > 0) return `${Math.round(s * 100)}%`;
  return String(w.origin || "").startsWith("recovered") ? "recovered" : "manual";
}

function blankWord(start, end, segmentId) {
  const safeStart = round4(Math.max(0, start));
  return {
    word: "",
    start: safeStart,
    end: round4(Math.max(safeStart + MIN_WORD_DURATION, end)),
    score: 0,
    segment_id: segmentId,
  };
}

// Mirror of the backend `group_words_into_phrases` so the panel (and the caption
// studio) shows exactly what the renderer will build from the edited words.
function groupWordsByMode(list, mode) {
  const clean = (list || []).filter((w) => (w.word || "").trim() !== "");
  if (!clean.length) return [];
  const make = (chunk) => ({
    phrase: chunk.map((c) => (c.word || "").trim()).join(" "),
    words: chunk,
    start: round4(chunk[0].start),
    end: round4(chunk[chunk.length - 1].end),
    duration: round4(chunk[chunk.length - 1].end - chunk[0].start),
  });
  if (mode === "one_word") {
    return clean.map((w) => ({
      phrase: (w.word || "").trim(),
      words: [w],
      start: round4(w.start),
      end: round4(w.end),
      duration: round4(w.end - w.start),
    }));
  }
  if (mode === "full_phrase") {
    const groups = [];
    for (const w of clean) {
      const id = w.segment_id ?? groups.length;
      const last = groups[groups.length - 1];
      if (last && last.id === id) last.chunk.push(w);
      else groups.push({ id, chunk: [w] });
    }
    return groups.map((g) => make(g.chunk));
  }
  const out = [];
  for (let i = 0; i < clean.length; i += 2) out.push(make(clean.slice(i, i + 2)));
  return out;
}

function sortWordsByTime(list) {
  return (list || [])
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (a.w.start - b.w.start) || (a.w.end - b.w.end) || (a.i - b.i))
    .map(({ w }) => w);
}

function TranscriptReview({ jobResult, setJobResult, onSaved, videoUrl, previewUrl = "", fps = 30, captionMode = "two_words" }) {
  const frameRate = Number(fps) > 0 ? Number(fps) : 30;
  const frameDur = 1 / frameRate;

  const [query, setQuery] = useState("");
  const [words, setWords] = useState(() => sortWordsByTime(cloneWords(jobResult?.words || [])));
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saveError, setSaveError] = useState("");
  const [playhead, setPlayhead] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState(-1);
  const [videoError, setVideoError] = useState("");
  // Two-stage source like the studio: backend H.264 proxy first, direct
  // file:// second, exported frame as poster throughout.
  const [reviewSrcIdx, setReviewSrcIdx] = useState(0);
  const reviewSources = useMemo(() => [previewUrl, videoUrl].filter(Boolean), [previewUrl, videoUrl]);
  const reviewSrc = reviewSources[Math.min(reviewSrcIdx, Math.max(0, reviewSources.length - 1))] || "";
  // Timeline frame still as the video poster: shows real pixels even when the
  // source codec (e.g. HEVC) can't be decoded by the panel's Chromium.
  const {
    frameUrl: reviewFrame,
    frameStatus: reviewFrameStatus,
    loadingFrame: loadingReviewFrame,
    refreshFrame: refreshReviewFrame,
  } = useTimelineFrame(videoUrl || "");
  const videoRef = useRef(null);
  const listRef = useRef(null);
  const jobId = jobResult?.job_id;
  // Signature of the last SAVED state. `dirty` compares against this — not
  // against the jobResult prop — so an unrelated prop swap can never leave
  // "unsaved" stuck on (which also disabled Continue and trapped the user).
  const [savedSig, setSavedSig] = useState(() =>
    wordsSignature(sortWordsByTime(cloneWords(jobResult?.words || [])))
  );

  // Refresh the editable copy whenever a new transcription lands.
  useEffect(() => {
    const fresh = sortWordsByTime(cloneWords(jobResult?.words || []));
    setWords(fresh);
    setSavedSig(wordsSignature(fresh));
    setSelected(-1);
    setSaveMsg("");
    setSaveError("");
    setReviewSrcIdx(0);
  }, [jobResult?.job_id]);

  // Unsaved = differs from what was last saved (covers renames, retimes,
  // inserts and deletes — never prop round-trip artefacts).
  const dirty = useMemo(() => wordsSignature(words) !== savedSig, [words, savedSig]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = words.map((w, i) => ({ w, i }));
    if (!q) return all;
    return all.filter(({ w }) => (w.word || "").toLowerCase().includes(q));
  }, [words, query]);

  // Nothing transcribed before the first entry → Whisper's VAD clipped the intro
  // (the "starts at 0.77s" case) and the user must add those words by hand.
  const headGap = words.length ? round4(Number(words[0].start) || 0) : 0;
  const selectedWord = selected >= 0 ? words[selected] : null;
  const visible = query.trim() ? filtered : filtered.slice(0, 300);
  const frameOf = (t) => Math.round((Number(t) || 0) * frameRate);

  function focusWordInput(index) {
    window.setTimeout(() => {
      const input = listRef.current?.querySelector(`.word-input[data-idx="${index}"]`);
      if (input) { input.focus(); if (input.select) input.select(); }
    }, 40);
  }

  function commit(next, focusIndex) {
    const sorted = sortWordsByTime(next);
    setWords(sorted);
    setSaveMsg("");
    if (typeof focusIndex === "number") {
      const at = Math.max(0, Math.min(focusIndex, sorted.length - 1));
      setSelected(at);
      focusWordInput(at);
    }
  }

  function editWord(index, field, value) {
    setWords((prev) => prev.map((w, i) => {
      if (i !== index) return w;
      if (field === "word") return { ...w, word: value };
      const num = Number(value);
      return Number.isFinite(num) ? { ...w, [field]: Math.max(0, num) } : w;
    }));
    setSaveMsg("");
  }

  function patchWord(index, patch) {
    setWords((prev) => prev.map((w, i) => (i === index ? { ...w, ...patch } : w)));
    setSaveMsg("");
  }

  // Insert a brand-new entry before `index`. An empty timeline gap gets the slot;
  // back-to-back words fall back to a single frame so nothing overlaps.
  function insertWord(index, opts = {}) {
    const list = words;
    const at = Math.max(0, Math.min(index, list.length));
    const prevEnd = at > 0 ? Number(list[at - 1].end) || 0 : 0;
    const nextStart = at < list.length ? Number(list[at].start) || prevEnd : prevEnd + 0.5;

    let start = Number(opts.start);
    let end = Number(opts.end);
    if (!Number.isFinite(start)) start = nextStart - prevEnd > frameDur * 2 ? prevEnd + frameDur : prevEnd;
    if (!Number.isFinite(end)) end = Math.min(nextStart, start + Math.max(0.6, frameDur * 18));
    start = round4(Math.max(0, start));
    end = round4(Math.max(start + frameDur, end));

    // Inherit the neighbouring segment id so "full phrase" grouping keeps a
    // manual entry with the words it belongs to.
    const anchor = list[at - 1] || list[at];
    const segmentId = anchor && anchor.segment_id != null ? anchor.segment_id : 1;
    const entry = { ...blankWord(start, end, segmentId), word: opts.word || "" };
    commit([...list.slice(0, at), entry, ...list.slice(at)], at);
    return entry;
  }

  // Click a word row → jump the video there and play from it (frame-by-frame
  // proofing: hear the actual audio under each word while you edit it).
  function seekToWord(w) {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = Math.max(0, Number(w.start) || 0);
      v.play().catch(() => {});
    } catch { /* ignore */ }
  }

  function stepFrames(dir) {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    setPlaying(false);
    seekTo((Number(v.currentTime) || 0) + dir * frameDur);
  }

  function seekTo(time) {
    const v = videoRef.current;
    const t = Math.max(0, Number(time) || 0);
    setPlayhead(t);
    if (!v) return;
    try {
      v.currentTime = Math.min(Number.isFinite(v.duration) ? v.duration : t, t);
    } catch { /* metadata not ready yet */ }
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  // Playhead snapped down to the current frame — a manual entry must start on a
  // real frame boundary or the renderer's frame-exact placement drifts.
  function playheadFrameTime() {
    return round4(Math.floor((Number(playhead) || 0) * frameRate) / frameRate);
  }

  // First entry that has not finished yet → insert here and keep time order.
  function insertionIndex() {
    for (let i = 0; i < words.length; i += 1) {
      if ((Number(words[i].end) || 0) >= playhead) return i;
    }
    return words.length;
  }

  function insertAtPlayhead() {
    const start = playheadFrameTime();
    insertWord(insertionIndex(), { start, end: start + Math.max(0.5, frameDur * 15) });
  }

  function appendWord() {
    const lastEnd = words.length ? Number(words[words.length - 1].end) || 0 : 0;
    const start = round4(Math.max(playhead, lastEnd));
    insertWord(words.length, { start, end: start + 0.5 });
  }

  // Frame-accurate retiming. Start/end are clamped so an entry can never become
  // zero-length or invert — either would break alignment and render placement.
  function nudgeWord(index, frames, edge) {
    const step = frames * frameDur;
    setWords((prev) => prev.map((w, i) => {
      if (i !== index) return w;
      const start = Number(w.start) || 0;
      const end = Number(w.end) || start;
      if (edge === "start") {
        return { ...w, start: Math.max(0, Math.min(round4(start + step), round4(end - frameDur))) };
      }
      return { ...w, end: Math.max(round4(start + frameDur), round4(end + step)) };
    }));
    setSaveMsg("");
  }

  // Split one entry into two at its midpoint — the usual fix when two words were
  // transcribed as one ("donot" → "do" + "not").
  function splitWord(index) {
    const w = words[index];
    if (!w) return;
    const start = Number(w.start) || 0;
    const end = Number(w.end) || start;
    const span = end - start;
    if (span < frameDur * 2) return; // needs at least two frames to hold both halves
    const mid = round4(start + span / 2);
    const first = { ...w, end: mid };
    const second = { ...blankWord(mid, end, w.segment_id), score: 0, word: "" };
    commit([...words.slice(0, index), first, second, ...words.slice(index + 1)], index + 1);
  }

  function removeWord(index) {
    if (index < 0 || index >= words.length) return;
    setWords((prev) => prev.filter((_, i) => i !== index));
    setSelected(-1);
    setSaveMsg("");
  }

  // Phrase grouping mirrors the backend exactly (and the caption studio) so what
  // the user previews is what the renderer builds.
  function regroup(list) {
    return groupWordsByMode(list, captionMode);
  }

  async function handleSave() {
    if (!jobId || saving) return false;
    // An SRT import has no backend job to persist against — keep it in panel
    // state (preview/export keep working) and ask for a Transcribe to unlock
    // cloud render + timeline placement.
    if (String(jobId).startsWith("imported-")) {
      const phrases = regroup(words);
      if (!phrases.length) {
        setSaveError("Transcript needs at least one word with text.");
        return false;
      }
      setJobResult((prev) => (prev ? { ...prev, words: cloneWords(words), phrases } : prev));
      setSavedSig(wordsSignature(words));
      seekTo(Math.max(0, playhead));
      setSaveMsg(
        `✓ Saved & synced — ${words.length} words · ${phrases.length} phrases. Run Transcribe to enable cloud render.`
      );
      return true;
    }
    setSaving(true);
    setSaveError("");
    setSaveMsg("");
    try {
      const phrases = regroup(words);
      if (!phrases.length) throw new Error("Transcript needs at least one word with text.");
      // Panel state first — the studio must show these edits even if the
      // backend sync below fails (offline backend, expired job, …).
      setJobResult((prev) => (prev ? { ...prev, words: cloneWords(words), phrases } : prev));
      setSavedSig(wordsSignature(words));
      const res = await apiClient.put(`/api/jobs/${jobId}/transcript`, { words, phrases });
      const phraseCount = Number(res.data?.phrase_count);
      // Explicit re-sync: re-seek the preview to the playhead so the corrected
      // caption shows at its new time with zero manual refresh.
      seekTo(Math.max(0, playhead));
      setSaveMsg(
        `✓ Saved & synced — ${Number(res.data?.word_count) || words.length} words · ${
          Number.isFinite(phraseCount) ? phraseCount : phrases.length
        } phrases. Preview & render use these edits.`
      );
      return true;
    } catch (e) {
      setSaveMsg(
        "Saved in the panel — the backend did not confirm, so render still uses the last synced transcript."
      );
      setSaveError(e.response?.data?.detail || e.message || "Could not sync edits to the backend.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleExportSrt() {
    if (!jobId) return;
    setSaveError("");
    try {
      const res = await apiClient.get(`/api/jobs/${jobId}/export.srt`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `captionx-${jobId}.srt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setSaveError("SRT export failed — try again.");
    }
  }

  // NOTE: every hook must run before the empty-state early return below —
  // returning early ahead of a hook changes the hook order between renders and
  // trips React's "rendered fewer hooks than expected" guard.
  const activeIdx = useMemo(() => {
    let best = -1;
    for (let i = 0; i < words.length; i++) {
      const s = Number(words[i].start) || 0;
      const e = Number(words[i].end) || s;
      if (playhead >= s && playhead <= e) return i;
      if (playhead >= e) best = i;
    }
    return best;
  }, [words, playhead]);

  if (!jobResult?.words?.length) {
    return (
      <div className="review-panel">
        <div className="review-summary">
          <span className="ready-badge">NO TRANSCRIPT YET</span>
          <h2>Nothing to review</h2>
          <p>Run Transcribe first — your editable words will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="review-panel">
      <div className="review-summary">
        <span className="ready-badge">READY · {words.length} WORDS · {regroup(words).length} PHRASES</span>
        {dirty && (
          <span className="unsaved-pill" title="Local edits differ from the last saved state — Save edits to apply them to preview & render">
            ● Unsaved changes
          </span>
        )}
        <h2>Transcript ready</h2>
        <p>Search, review, retime and refine every word before designing captions. Edits apply to preview &amp; render after <strong>Save edits</strong>.</p>
      </div>
      {headGap > 0.001 && (
        <div className="gap-callout">
          <div className="gap-copy">
            <strong>Speech may start before {headGap.toFixed(2)}s</strong>
            <span>Whisper&apos;s silence detector can skip a quiet or faded intro. Play from the top and add the missing words — they render exactly like transcribed ones.</span>
          </div>
          <div className="gap-actions">
            <button className="btn-ghost" onClick={() => seekTo(0)}>↺ Play from 0s</button>
            <button
              className="btn-ghost"
              onClick={() => insertWord(0, { start: 0, end: Math.min(headGap, 0.5) || 0.5 })}
            >
              + Add word at 0s
            </button>
          </div>
        </div>
      )}
      {videoUrl ? (
        <div className="review-video-wrap">
          <video
            ref={videoRef}
            src={reviewSrc}
            className="review-video"
            poster={reviewFrame || undefined}
            onLoadedMetadata={(e) => setDuration(Number(e.target.duration) || 0)}
            onTimeUpdate={(e) => setPlayhead(e.target.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => {
              if (reviewSrcIdx + 1 < reviewSources.length) {
                setReviewSrcIdx(reviewSrcIdx + 1);
              } else {
                setVideoError(
                  "The sequence video could not be played here (missing file or unplayable codec). Timestamps below still match the Premiere timeline."
                );
              }
            }}
            playsInline
          />
          <div className="review-video-bar">
            <button className="btn-ghost" onClick={() => stepFrames(-1)} title="Step 1 frame back">⏮</button>
            <button className="btn-ghost" onClick={togglePlay} title={playing ? "Pause" : "Play"}>
              {playing ? "⏸" : "▶"}
            </button>
            <button className="btn-ghost" onClick={() => stepFrames(1)} title="Step 1 frame forward">⏭</button>
            <button className="btn-ghost" onClick={refreshReviewFrame} disabled={loadingReviewFrame} title="Refresh the timeline frame from Premiere">⟳</button>
            <input
              className="review-scrub"
              type="range"
              min={0}
              max={duration || 0}
              step={frameDur}
              value={Math.min(playhead, duration || playhead)}
              onChange={(e) => seekTo(e.target.value)}
              aria-label="Scrub the video"
            />
            <span className="review-timecode">{formatTimecode(playhead, frameRate)}</span>
            <small>frame {frameOf(playhead)} · {frameRate}fps</small>
          </div>
        </div>
      ) : (
        <p className="save-hint">No video preview yet — keep the sequence open in Premiere so the panel can resolve its media file.</p>
      )}
      {videoError && <p className="save-err">⚠ {videoError}</p>}
      {reviewFrameStatus && !reviewFrame && (
        <p className="save-hint">{loadingReviewFrame ? "Loading the current timeline frame…" : `Timeline frame: ${reviewFrameStatus}`}</p>
      )}
      <div className="review-toolbar">
        <input className="field-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search words or phrases…" />
        <span>{filtered.length} / {words.length} words{dirty ? " · unsaved" : ""}</span>
      </div>
      <div className="review-actions">
        <button className="btn-primary" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving…" : "💾 Save edits"}
        </button>
        <button className="btn-ghost" onClick={insertAtPlayhead} title="Insert a new word at the playhead">
          + Insert at playhead
        </button>
        <button className="btn-ghost" onClick={() => insertWord(0, { start: 0, end: Math.min(headGap, 0.5) || 0.5 })} title="Insert a new word at the very start">
          + Top
        </button>
        <button className="btn-ghost" onClick={appendWord} title="Insert a new word at the very end">
          + Bottom
        </button>
        <button className="btn-ghost" onClick={handleExportSrt}>Export SRT</button>
        <button
          className="btn-ghost"
          disabled={saving}
          title={dirty ? "Saves your edits, then continues" : "Continue to the caption studio"}
          onClick={async () => {
            // Never trap the user: save first when dirty, then continue.
            // handleSave always lands the edits in panel state, so the
            // studio shows exactly what was reviewed here.
            if (dirty) {
              const ok = await handleSave();
              if (!ok) return;
            }
            onSaved();
          }}
        >
          {dirty ? "Save & Continue →" : "Continue →"}
        </button>
      </div>
      {saveMsg && <p className="save-ok">✓ {saveMsg}</p>}
      {saveError && <p className="save-err">⚠ {saveError}</p>}
      <div className="word-list" ref={listRef}>
        {visible.map(({ w, i }) => (
          <div
            className={`word-row ${i === activeIdx ? "word-active" : ""} ${i === selected ? "word-selected" : ""} ${(w.word || "").trim() ? "" : "word-blank"} ${wordNeedsReview(w) ? "word-needs-review" : ""}`}
            key={`${i}-${w.start}-${w.end}`}
          >
            <button
              className="word-gutter"
              onClick={() => { setSelected(i); seekToWord(w); }}
              title="Click to play the video from this word"
            >
              <span
                className={`word-dot ${i === activeIdx ? "dot-live" : (w.score || 0) < 0.35 ? "dot-low" : ""}`}
                aria-hidden="true"
              />
              {String(i + 1).padStart(3, "0")}
            </button>
            <label className="word-time">
              <span>IN · s</span>
              <input
                type="number"
                step={frameDur}
                min={0}
                value={round4(w.start)}
                onChange={(e) => editWord(i, "start", e.target.value)}
                aria-label={`Start time in seconds of word ${i + 1}`}
              />
              <input
                className="word-tc"
                key={`tc-s-${i}-${round4(w.start)}`}
                defaultValue={formatTimecode(w.start, frameRate)}
                onBlur={(e) => {
                  const v = parseTimecode(e.target.value, frameRate);
                  if (Number.isFinite(v)) editWord(i, "start", v);
                  else e.target.value = formatTimecode(w.start, frameRate);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                aria-label={`Start timecode of word ${i + 1}`}
                title="Start timecode (HH:MM:SS:FF) — linked to the seconds field"
              />
            </label>
            <label className="word-time">
              <span>OUT · s</span>
              <input
                type="number"
                step={frameDur}
                min={0}
                value={round4(w.end)}
                onChange={(e) => editWord(i, "end", e.target.value)}
                aria-label={`End time in seconds of word ${i + 1}`}
              />
              <input
                className="word-tc"
                key={`tc-e-${i}-${round4(w.end)}`}
                defaultValue={formatTimecode(w.end, frameRate)}
                onBlur={(e) => {
                  const v = parseTimecode(e.target.value, frameRate);
                  if (Number.isFinite(v)) editWord(i, "end", v);
                  else e.target.value = formatTimecode(w.end, frameRate);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                aria-label={`End timecode of word ${i + 1}`}
                title="End timecode (HH:MM:SS:FF) — linked to the seconds field"
              />
            </label>
            <input
              className="word-input"
              data-idx={i}
              value={w.word}
              onChange={(e) => editWord(i, "word", e.target.value)}
              onFocus={() => setSelected(i)}
              placeholder="(add word…)"
              aria-label={`Text of word ${i + 1}`}
            />
            <span className="score-cell">
              <span className="word-score" title="Recognition confidence">
                {wordScoreLabel(w)}
              </span>
              {wordNeedsReview(w) && (
                <span className="review-badge" title="Added by automatic gap recovery, or low recognition confidence — please verify against the audio">
                  ⚠ verify
                </span>
              )}
            </span>
            <div className="word-tools">
              <button className="icon-btn" onClick={() => nudgeWord(i, -1, "start")} title="Move start 1 frame earlier">◀|</button>
              <button className="icon-btn" onClick={() => nudgeWord(i, 1, "start")} title="Move start 1 frame later">|▶</button>
              <button className="icon-btn" onClick={() => nudgeWord(i, -1, "end")} title="Move end 1 frame earlier">◀‖</button>
              <button className="icon-btn" onClick={() => nudgeWord(i, 1, "end")} title="Move end 1 frame later">‖▶</button>
              <button className="icon-btn" onClick={() => insertWord(i + 1)} title="Insert a new word after this one">＋</button>
              <button className="icon-btn" onClick={() => splitWord(i)} title="Split this word in two at its midpoint">⧄</button>
              <button className="icon-btn danger" onClick={() => removeWord(i)} title="Delete this word">🗑</button>
            </div>
          </div>
        ))}
      </div>
      {!query.trim() && filtered.length > visible.length && (
        <p className="save-hint">
          Showing the first {visible.length} of {filtered.length} words — use search to jump straight to a phrase.
        </p>
      )}
      {selectedWord && (
        <p className="save-hint">
          Editing entry {selected + 1}: {formatTimecode(selectedWord.start, frameRate)} → {formatTimecode(selectedWord.end, frameRate)}. Use the ◀ ▶ tools to nudge a single frame.
        </p>
      )}
    </div>
  );
}

function TranscriptionEntries({ jobResult }) {
  const phrases = jobResult?.phrases || [];
  const words = jobResult?.words || [];
  const hasEntries = phrases.length > 0 && words.length > 0;

  return (
    <section className="entries-panel">
      <div className="entries-head">
        Transcription entries
        <span className="count">{words.length} words · {phrases.length} phrases</span>
      </div>
      {!hasEntries ? (
        <p className="entries-empty">⚠ No transcription entries found. The audio may contain no speech or was unsupported. Try another clip.</p>
      ) : (
        <div className="word-list">
          {words.slice(0, 40).map((word, index) => (
            <div className="word-entry" key={`${word.start}-${index}`}>
              <time>{Number(word.start).toFixed(2)}s</time>
              <span className="word-text" title={word.word}>{word.word}</span>
              <span className="confidence">{Math.round((word.score || 0) * 100)}%</span>
            </div>
          ))}
          {words.length > 40 && <p className="entries-empty">{words.length - 40} more words… open Cap<span style={{color:"#c9b3ff"}}>tion</span>X Review in the Studio.</p>}
        </div>
      )}
    </section>
  );
}
