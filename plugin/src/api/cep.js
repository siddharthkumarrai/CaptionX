function getCep() {
  return typeof window !== "undefined" ? window.__adobe_cep__ : null;
}

function evalScript(script) {
  const cep = getCep();
  if (!cep?.evalScript) return Promise.reject(new Error("CEP host bridge is unavailable."));
  return new Promise((resolve, reject) => {
    cep.evalScript(script, (result) => {
      if (!result || result === "EvalScript error.") reject(new Error("Premiere host script failed."));
      else resolve(result);
    });
  });
}

export async function getActiveSequenceInfo() {
  const raw = await evalScript(`(function () {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ error: "Open a Premiere sequence first." });
    }
    var sequence = app.project.activeSequence;
    var audioPath = "";
    for (var trackIndex = 0; trackIndex < sequence.audioTracks.numTracks && !audioPath; trackIndex++) {
      var track = sequence.audioTracks[trackIndex];
      for (var clipIndex = 0; clipIndex < track.clips.numItems; clipIndex++) {
        var clip = track.clips[clipIndex];
        if (clip.projectItem && clip.projectItem.getMediaPath) {
          audioPath = clip.projectItem.getMediaPath();
          if (audioPath) break;
        }
      }
    }
    return JSON.stringify({ name: sequence.name || "Active sequence", audioPath: audioPath, projectPath: String(app.project.path || ""), sequenceID: String(sequence.sequenceID || "") });
  }())`);
  const info = JSON.parse(raw);
  if (info.error) throw new Error(info.error);
  return info;
}

export async function getActiveSequenceAudioFile() {
  const info = await getActiveSequenceInfo();
  if (!info.audioPath) throw new Error("No audio clips found in the active sequence.");
  const cepFs = window.cep?.fs;
  if (!cepFs?.readFile) throw new Error("CEP filesystem bridge is unavailable.");
  const base64Encoding = window.cep?.encoding?.Base64;
  const result = base64Encoding
    ? cepFs.readFile(info.audioPath, base64Encoding)
    : cepFs.readFile(info.audioPath);
  if (result.err) throw new Error(`Could not read active sequence media: ${result.err}`);
  let bytes;
  if (base64Encoding) {
    // A raw DOMException here ("Invalid character") means the bridge did not
    // actually return base64 — surface a clear, actionable error instead.
    let binary = null;
    try {
      binary = atob(String(result.data || "").replace(/\s+/g, ""));
    } catch {
      binary = null;
    }
    if (binary === null) {
      throw new Error(
        "Could not decode the timeline audio (the panel file bridge returned invalid data). Reopen the panel and retry."
      );
    }
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } else {
    bytes = Uint8Array.from(result.data, (character) => character.charCodeAt(0));
  }
  if (!bytes.length) throw new Error("The active sequence media file is empty.");
  const name = info.audioPath.split(/[\\/]/).pop() || "active-sequence-media.mp4";
  return { name, type: "application/octet-stream", blob: new Blob([bytes]) };
}

// ── CEP fallback: download rendered assets to a local folder ─────────────────
// UXP panels use storage.localFileSystem; classic CEP panels use cep.fs with
// the UserDataMember / user-data directory. Both end up with absolute local
// paths Premiere's importFiles can read.

export function cepAvailable() {
  return !!getCep();
}

function cepObject() {
  return typeof window !== "undefined" ? window.cep : null;
}

// Node inside the panel (enabled via the manifest CEFCommandLine). Property
// access on `window` — never a bare `require` — so webpack leaves it alone.
function nodeRequire(name) {
  try {
    const w = typeof window !== "undefined" ? window : null;
    if (!w) return null;
    if (w.cep_node?.require) return w.cep_node.require(name);
    if (typeof w.require === "function") {
      try {
        return w.require(name);
      } catch {
        return null;
      }
    }
  } catch {
    /* no Node context */
  }
  return null;
}

// CEP spells directory listing `readdir` (Node-style); tolerate the alias.
function cepListDir(fs, dir) {
  const fn = fs?.readdir || fs?.readDir;
  if (typeof fn !== "function") return null;
  try {
    const res = fn.call(fs, dir);
    if (res && !res.err && Array.isArray(res.data)) return res.data;
    return null;
  } catch {
    return null;
  }
}

// SystemPath lives on cep.fs in most builds, on cep itself in others.
function cepSystemPaths() {
  const cep = cepObject();
  return cep?.fs?.SystemPath || cep?.SystemPath || {};
}

// Which filesystem piece is missing — so failures name the cause instead of
// a generic "bridge unavailable".
export function cepFsStatus() {
  const cep = cepObject();
  if (!cep) return "window.cep is missing";
  if (!cep.fs) return "window.cep.fs is missing";
  const missing = [];
  if (typeof cep.fs.readFile !== "function") missing.push("fs.readFile");
  if (typeof cep.fs.writeFile !== "function") missing.push("fs.writeFile");
  if (typeof cep.fs.readdir !== "function" && typeof cep.fs.readDir !== "function") {
    missing.push("fs.readdir");
  }
  if (typeof cep.fs.getSystemPath !== "function") missing.push("fs.getSystemPath");
  if (!cep.fs.SystemPath && !cep.SystemPath) missing.push("SystemPath");
  if (!cep.encoding?.Base64) missing.push("encoding.Base64");
  return missing.length ? `window.cep is missing: ${missing.join(", ")}` : "ok";
}

function nodeTmpBase() {
  try {
    const os = nodeRequire("os");
    const dir = os?.tmpdir?.();
    return dir ? String(dir).replace(/\\/g, "/").replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function nodeFs() {
  try {
    const fs = nodeRequire("fs");
    return fs?.mkdirSync && fs?.readFileSync && fs?.writeFileSync ? fs : null;
  } catch {
    return null;
  }
}

function nodeBuffer() {
  try {
    const w = typeof window !== "undefined" ? window : null;
    if (w?.cep_node?.Buffer) return w.cep_node.Buffer;
    const buf = nodeRequire("buffer");
    return buf?.Buffer || null;
  } catch {
    return null;
  }
}

export function cepTempDir() {
  const cep = cepObject();
  const fs = cep?.fs;
  const SYS = cepSystemPaths();
  const candidates = [];
  if (fs?.getSystemPath) {
    for (const key of [SYS.USER_DATA, SYS.USER_FILES, SYS.TEMP, SYS.APPLICATION_DATA, SYS.MY_DOCUMENTS]) {
      if (!key) continue;
      try {
        const p = fs.getSystemPath(key);
        if (p) candidates.push(p);
      } catch {
        /* try next key */
      }
    }
  }
  // Node fallback: os.tmpdir() always resolves somewhere writable.
  const tmp = nodeTmpBase();
  if (tmp) candidates.push(tmp);

  const nfs = nodeFs();
  for (const base of candidates) {
    const clean = String(base).replace(/\\/g, "/").replace(/\/$/, "");
    // Try progressively shallower folders: CaptionX/renders → CaptionX → base
    // itself. makedir only creates one level, so build nested paths safely.
    const subs = ["CaptionX/renders", "CaptionX", ""];
    for (const sub of subs) {
      const dir = sub ? `${clean}/${sub}` : clean;
      // 1) Node path (authoritative when the Node context is enabled).
      if (nfs) {
        try {
          nfs.mkdirSync(dir, { recursive: true });
          return dir;
        } catch {
          /* try next candidate */
          continue;
        }
      }
      // 2) cep.fs path.
      try {
        if (sub && fs?.makedir) fs.makedir(dir); // no-op when it already exists
        if (cepListDir(fs, dir) !== null) return dir;
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
}

// Read a file as base64 — cep.fs first, Node fallback second.
function readFileBase64(absPath) {
  const cep = cepObject();
  const fs = cep?.fs;
  const flag = cep?.encoding?.Base64;
  if (fs?.readFile && flag) {
    const res = fs.readFile(absPath, flag);
    if (res && !res.err && res.data) return res.data;
    throw new Error(`Could not read ${absPath}: ${res?.err || "unknown error"}`);
  }
  const nfs = nodeFs();
  const Buf = nodeBuffer();
  if (nfs && Buf) {
    return Buf.from(nfs.readFileSync(absPath)).toString("base64");
  }
  throw new Error(`Cannot read files here (${cepFsStatus()}).`);
}

// Write base64 bytes to disk — cep.fs first, Node fallback second.
function writeFileBase64(absPath, base64) {
  const cep = cepObject();
  const fs = cep?.fs;
  if (fs?.writeFile && cep?.encoding?.Base64) {
    const res = fs.writeFile(absPath, base64, cep.encoding.Base64);
    if (res && res.err) throw new Error(`Could not write ${absPath}: ${res.err}`);
    return;
  }
  const nfs = nodeFs();
  const Buf = nodeBuffer();
  if (nfs && Buf) {
    nfs.writeFileSync(absPath, Buf.from(base64, "base64"));
    return;
  }
  throw new Error(`Cannot write files here (${cepFsStatus()}).`);
}

// Downloads each asset_url and returns { ...asset, localPath } entries.
export async function downloadAssetsCep(assets) {
  if (!assets || !assets.length) return [];
  const dir = cepTempDir();
  if (!dir) throw new Error(`Could not resolve a writable local folder in the CEP panel (${cepFsStatus()}).`);

  const out = [];
  for (const asset of assets) {
    const fileName = asset.asset_url.split("/").pop().split("?")[0];
    const localPath = `${dir}/${fileName}`;
    // fetch → arrayBuffer → base64 (cep.fs only writes text or base64)
    const response = await fetch(asset.asset_url);
    if (!response.ok) {
      throw new Error(`Failed to download asset: ${asset.asset_url} (${response.status})`);
    }
    const buffer = await response.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);
    writeFileBase64(localPath, base64);
    out.push({ ...asset, localPath });
  }
  return out;
}

// ── Real video playback in the caption studio preview ───────────────────────
// Asks the ExtendScript host (captionXGetMediaPath in jsx/host.jsx) for the
// first clip's media path on the active sequence and returns a file:// URL the
// CEP Chromium <video> element can play directly.
export async function getVideoPathCep() {
  const raw = await evalScript("captionXGetMediaPath()");
  const info = JSON.parse(raw);
  if (info.error) throw new Error(info.error);
  if (!info.path) throw new Error("No media found on the active sequence.");
  // CEP's Chromium refuses file:// URLs with unencoded spaces / unicode.
  // Encode with encodeURI on the WHOLE path: it escapes spaces and unicode
  // but leaves "/" and the drive-letter ":" intact. (Per-segment
  // encodeURIComponent is wrong here — it turns "D:" into "D%3A", which
  // Chromium no longer recognises as a drive letter, so the <video> element
  // fails silently and the preview stays black.)
  var normalized = String(info.path).replace(/\\/g, "/");
  if (normalized.charAt(0) !== "/") normalized = "/" + normalized;
  const url = "file://" + encodeURI(normalized).replace(/#/g, "%23");
  return {
    path: info.path,
    url,
    duration: Number(info.duration) || 0,
    // Sequence resolution so the preview stage can match the project
    // orientation (vertical reel vs horizontal) instead of a fixed frame.
    width: Number(info.width) || 0,
    height: Number(info.height) || 0,
    fps: Number(info.fps) || 0,
    // Identity for the panel's per-project transcript cache.
    projectPath: String(info.projectPath || ""),
    sequenceID: String(info.sequenceID || ""),
  };
}

// ── Timeline frame still for the caption preview ───────────────────────────
// Exports the current playhead frame via the ExtendScript host and returns it
// as a data: URL. This is what makes the preview show REAL video pixels when
// the source codec (e.g. HEVC/H.265) cannot be decoded by the panel's
// Chromium <video> element at all.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function exportTimelineFrame() {
  const cep = cepObject();
  const fs = cep?.fs;
  if (!cepAvailable()) throw new Error("CEP host bridge is unavailable.");
  if (!fs?.readFile && !nodeFs()) {
    throw new Error(`Cannot read files here (${cepFsStatus()}).`);
  }
  const fileName = "captionx-preview-frame.png";
  // Prefer a panel-resolved folder, but never require it: an empty path tells
  // the host to use ExtendScript's Folder.temp (some CEP builds hide
  // getSystemPath/SystemPath from the panel, which used to fail the export).
  const dir = cepTempDir();
  const out = dir ? `${dir}/${fileName}` : "";
  const arg = JSON.stringify({ outputPath: out }).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const raw = await evalScript(`captionXExportFrame('${arg}')`);
  let info = null;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new Error("Timeline frame export failed.");
  }
  if (info.error) throw new Error(info.error);
  if (!info.path) throw new Error("Timeline frame export returned no path.");

  const actual = String(info.path).replace(/\\/g, "/");
  const actualFile = actual.slice(actual.lastIndexOf("/") + 1) || fileName;
  const actualDir = actual.slice(0, actual.lastIndexOf("/")) || dir;

  // exportFramePNG can lag behind the call — poll briefly, then read the PNG
  // once and hand it to the stage as a data: URL (no file:// caching
  // pitfalls, works for every codec Premiere itself can render).
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      let present = false;
      const nfs = nodeFs();
      if (nfs) {
        present = nfs.existsSync(actual);
      } else {
        const names = cepListDir(fs, actualDir) || [];
        present =
          names.indexOf(actualFile) !== -1 ||
          names.indexOf(actual) !== -1 ||
          names.some((n) => String(n).endsWith(`/${actualFile}`) || String(n).endsWith(`\\${actualFile}`));
      }
      if (present) {
        return `data:image/png;base64,${readFileBase64(actual)}`;
      }
    } catch {
      /* keep polling */
    }
    await sleep(150);
  }
  throw new Error("Premiere did not finish the frame export. Move the playhead and retry.");
}

// Places caption + SFX clips via the ExtendScript host (jsx/host.jsx).
// Returns { placed, failed, bin }. `bin` (optional) selects the nested
// project-bin destination; each clip may carry an optional `label` used for
// the project-item / timeline-clip name.
export async function placeAssetsCep({ captionClips, sfxClips, bin }) {
  const payload = JSON.stringify({
    bin: bin || null,
    captionClips: (captionClips || []).map((a) => ({
      path: a.localPath,
      startSec: a.startSec,
      durationSec: a.durationSec,
      trackIndex: a.trackIndex ?? 1,
      label: a.label || "",
    })),
    sfxClips: (sfxClips || []).map((a) => ({
      path: a.localPath,
      startSec: a.startSec,
      trackIndex: a.trackIndex ?? 3,
      label: a.label || "",
    })),
  });
  const raw = await evalScript(`captionXPlaceCaptions(${JSON.stringify(payload)})`);
  const result = JSON.parse(raw);
  if (result.error) throw new Error(result.error);
  return result;
}
