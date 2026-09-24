function captionXGetSequenceInfo() {
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

  return JSON.stringify({
    name: sequence.name || "Active sequence",
    audioPath: audioPath,
    duration: sequence.end,
  });
}

// ── CEP fallback: import rendered caption/SFX files and place them ──────────
// Used when the UXP runtime is unavailable (classic CEP panel). Payload:
// { captionClips: [{path, startSec, durationSec, trackIndex}],
//   sfxClips: [{path, startSec, trackIndex}] }
// Ticks per second constant matches usePremiere.js (254016000000).

function captionXFindProjectItemByName(rootItem, name) {
  for (var i = 0; i < rootItem.children.numItems; i++) {
    var child = rootItem.children[i];
    if (child.name === name) return child;
  }
  return null;
}

function captionXSanitizeName(s, maxLen) {
  var out = String(s || "").replace(/[\\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  var cap = maxLen || 60;
  if (out.length > cap) out = out.substring(0, cap).trim();
  return out;
}

// Find a direct child bin by name. Version-proof: bins are detected by the
// presence of a .children collection (accessing it on a non-bin throws),
// never via ProjectItemType which varies across hosts.
function captionXFindBin(parent, name) {
  var n = 0;
  try { n = parent.children.numItems; } catch (e) { return null; }
  for (var i = 0; i < n; i++) {
    var ch = null;
    try { ch = parent.children[i]; } catch (e2) { continue; }
    if (!ch || ch.name !== name) continue;
    try {
      if (ch.children && ch.children.numItems !== undefined) return ch;
    } catch (e3) { /* not a bin — keep looking */ }
  }
  return null;
}

function captionXFindOrCreateBin(parent, name) {
  var found = captionXFindBin(parent, name);
  if (found) return found;
  return parent.createBin(name);
}

// Display name for an imported caption clip: caption_0007_Do_Not.mov
function captionXClipDisplayName(base, label) {
  var words = String(label || "").split(/\s+/).filter(Boolean).slice(0, 3).join("_").replace(/[^A-Za-z0-9_]/g, "");
  var dot = base.lastIndexOf(".");
  var stem = dot > 0 ? base.substring(0, dot) : base;
  var ext = dot > 0 ? base.substring(dot) : "";
  var name = words ? stem + "_" + words : stem;
  if (name.length + ext.length > 60) name = name.substring(0, 60 - ext.length);
  return name + ext;
}

// Snapshot of a track's clip start ticks, so the just-placed instance can be
// found afterwards (insertClip itself returns nothing usable).
function captionXTrackStartSet(track) {
  var set = {};
  try {
    for (var i = 0; i < track.clips.numItems; i++) {
      try { set[String(track.clips[i].start.ticks)] = true; } catch (e) { /* skip */ }
    }
  } catch (e) { /* track unreadable */ }
  return set;
}

function captionXFindPlacedClip(track, beforeSet, startTicks) {
  var want = String(startTicks);
  var fallback = null;
  try {
    for (var i = 0; i < track.clips.numItems; i++) {
      var clip = null;
      try { clip = track.clips[i]; } catch (e) { continue; }
      var st = "";
      try { st = String(clip.start.ticks); } catch (e2) { continue; }
      if (st !== want) continue;
      if (!beforeSet[st] && !fallback) fallback = clip;
      if (!beforeSet[st]) return clip;
    }
  } catch (e) { /* track unreadable */ }
  return fallback;
}

function captionXSanitizeBinName(s) {
  return String(s || "").replace(/[\\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "Untitled";
}

// Find a direct child bin by name (bins are ProjectItems with a children
// collection — files/sequences don't have one).
function captionXFindChildBin(parentBin, name) {
  var n = 0;
  try { n = parentBin.children.numItems; } catch (e) { return null; }
  for (var i = 0; i < n; i++) {
    var child = null;
    try { child = parentBin.children[i]; } catch (e2) { continue; }
    if (!child || child.name !== name) continue;
    try {
      if (child.children && child.children.numItems !== undefined) return child;
    } catch (e3) { /* not a bin — keep looking */ }
  }
  return null;
}

function captionXFindOrCreateBin(parentBin, name) {
  var found = captionXFindChildBin(parentBin, name);
  if (found) return found;
  return parentBin.createBin(name);
}

// Snapshot of a track's clip start ticks, so the just-placed instance can be
// found afterwards (insertClip itself returns nothing usable).
function captionXTrackStartSet(track) {
  var set = {};
  try {
    for (var i = 0; i < track.clips.numItems; i++) {
      try { set[String(track.clips[i].start.ticks)] = true; } catch (e) { /* skip */ }
    }
  } catch (e) { /* track unreadable */ }
  return set;
}

function captionXFindPlacedClip(track, beforeSet, startTicks) {
  var want = String(startTicks);
  var fallback = null;
  try {
    for (var i = 0; i < track.clips.numItems; i++) {
      var clip = null;
      try { clip = track.clips[i]; } catch (e) { continue; }
      var st = "";
      try { st = String(clip.start.ticks); } catch (e2) { continue; }
      if (st !== want) continue;
      if (!beforeSet[st]) return clip;
      if (!fallback) fallback = clip;
    }
  } catch (e) { /* track unreadable */ }
  return fallback;
}

// Predictable clip name: caption_0007_Do_Not (stem + first words of label).
function captionXClipDisplayName(fileName, label) {
  var dot = fileName.lastIndexOf(".");
  var stem = dot > 0 ? fileName.substring(0, dot) : fileName;
  var ext = dot > 0 ? fileName.substring(dot) : "";
  var words = String(label || "").split(/\s+/).filter(Boolean).slice(0, 3).join("_")
    .replace(/[^A-Za-z0-9_]/g, "");
  var name = words ? stem + "_" + words : stem;
  if (name.length + ext.length > 60) name = name.substring(0, 60 - ext.length);
  return name + ext;
}

function captionXPlaceCaptions(payloadJson) {
  try {
    if (!app.project) {
      return JSON.stringify({ error: "No Premiere project open." });
    }
    var sequence = app.project.activeSequence;
    if (!sequence) {
      return JSON.stringify({ error: "Open a Premiere sequence first." });
    }

    var payload = JSON.parse(payloadJson);
    var TICKS_PER_SECOND = 254016000000;
    var placed = 0;
    var failed = 0;
    var importedNames = [];
    var itemCache = {}; // name -> projectItem
    var rootBin = app.project.rootItem;

    // Structured destination: CaptionX / <Video> / <job> / {Captions, SFX}.
    // Without a bin spec (older panels) everything falls back to rootBin,
    // preserving previous behaviour exactly.
    var captionsBin = rootBin;
    var sfxBin = rootBin;
    var binPath = "";
    try {
      if (payload.bin && (payload.bin.video || payload.bin.job)) {
        var topBin = captionXFindOrCreateBin(rootBin, captionXSanitizeName(payload.bin.root || "CaptionX", 60) || "CaptionX");
        var videoBin = captionXFindOrCreateBin(topBin, captionXSanitizeName(payload.bin.video || "Sequence", 60) || "Sequence");
        var jobBin = captionXFindOrCreateBin(videoBin, captionXSanitizeName(payload.bin.job || "Captions", 60) || "Captions");
        captionsBin = captionXFindOrCreateBin(jobBin, captionXSanitizeName(payload.bin.captions || "Captions", 60) || "Captions");
        sfxBin = captionXFindOrCreateBin(jobBin, captionXSanitizeName(payload.bin.sfx || "SFX", 60) || "SFX");
        binPath = topBin.name + "/" + videoBin.name + "/" + jobBin.name;
      }
    } catch (binErr) {
      captionsBin = rootBin;
      sfxBin = rootBin;
      binPath = "";
    }

    // Import every unique file once, into its sub-bin.
    var allPaths = [];
    var allKinds = {}; // path -> "captions" | "sfx"
    var i;
    for (i = 0; i < payload.captionClips.length; i++) {
      var cp = payload.captionClips[i].path;
      if (allPaths.indexOf(cp) === -1) { allPaths.push(cp); allKinds[cp] = "captions"; }
    }
    for (i = 0; i < payload.sfxClips.length; i++) {
      var sp = payload.sfxClips[i].path;
      if (allPaths.indexOf(sp) === -1) { allPaths.push(sp); allKinds[sp] = "sfx"; }
    }

    // label lookup: path -> human label ("Do not") for predictable names.
    var labels = {};
    var k;
    for (k = 0; k < payload.captionClips.length; k++) {
      if (payload.captionClips[k].label) labels[payload.captionClips[k].path] = payload.captionClips[k].label;
    }
    for (k = 0; k < payload.sfxClips.length; k++) {
      if (payload.sfxClips[k].label) labels[payload.sfxClips[k].path] = payload.sfxClips[k].label;
    }

    for (i = 0; i < allPaths.length; i++) {
      var path = allPaths[i];
      var name = path.replace(/\\/g, "/").split("/").pop();
      var targetBin = allKinds[path] === "sfx" ? sfxBin : captionsBin;
      var existing = captionXFindProjectItemByName(targetBin, name);
      if (existing) {
        itemCache[name] = existing;
        continue;
      }
      // importFiles: (arrayOfFilePaths, suppressUI, targetBin, importAsBatch)
      var ok = app.project.importFiles([path], true, targetBin, false);
      var item = ok ? captionXFindProjectItemByName(targetBin, name) : null;
      if (!item) {
        failed++;
        continue;
      }
      try {
        item.name = captionXClipDisplayName(name, labels[path] || "");
      } catch (renameErr) { /* cosmetic only — keep the imported item */ }
      itemCache[name] = item;
      importedNames.push(item.name);
    }

    // Place caption clips (video tracks)
    for (i = 0; i < payload.captionClips.length; i++) {
      var c = payload.captionClips[i];
      var cItem = itemCache[c.path.replace(/\\/g, "/").split("/").pop()];
      if (!cItem) { failed++; continue; }
      var trackIdx = Math.min(c.trackIndex, sequence.videoTracks.numTracks - 1);
      if (trackIdx < 0) { failed++; continue; }
      var startTicks = String(Math.round(c.startSec * TICKS_PER_SECOND));
      try {
        var vTrack = sequence.videoTracks[trackIdx];
        var vBefore = captionXTrackStartSet(vTrack);
        vTrack.insertClip(cItem, startTicks);
        placed++;
        // Name the timeline instance after its words (thumbnail-like label).
        var vPlaced = captionXFindPlacedClip(vTrack, vBefore, startTicks);
        if (vPlaced && c.label) {
          try { vPlaced.name = captionXSanitizeName(c.label, 60); } catch (renameClipErr) { /* cosmetic */ }
        }
      } catch (placeErr) {
        failed++;
      }
    }

    // Place SFX clips (audio tracks)
    for (i = 0; i < payload.sfxClips.length; i++) {
      var s = payload.sfxClips[i];
      var sItem = itemCache[s.path.replace(/\\/g, "/").split("/").pop()];
      if (!sItem) { failed++; continue; }
      var aTrackIdx = Math.min(s.trackIndex, sequence.audioTracks.numTracks - 1);
      if (aTrackIdx < 0) { failed++; continue; }
      var sStartTicks = String(Math.round(s.startSec * TICKS_PER_SECOND));
      try {
        sequence.audioTracks[aTrackIdx].insertClip(sItem, sStartTicks);
        placed++;
      } catch (sfxErr) {
        failed++;
      }
    }

    return JSON.stringify({ placed: placed, failed: failed, imported: importedNames.length, bin: binPath });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
}
// ── Timeline frame still for the panel preview ─────────────────────────────
// Exports the current playhead frame as a PNG so the caption stage shows the
// REAL timeline pixels even when the source codec (e.g. HEVC/H.265) cannot be
// decoded by the panel's Chromium <video> element. The panel polls for the
// file briefly — exportFramePNG can lag behind this call.
function captionXExportFrame(payloadJson) {
  try {
    var payload = {};
    try { payload = JSON.parse(payloadJson || "{}"); } catch (parseErr) { payload = {}; }
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ error: "Open a Premiere sequence first." });
    }
    var output = String(payload.outputPath || "");
    if (!output) {
      // The panel could not resolve a writable folder (some CEP builds hide
      // getSystemPath) — fall back to the OS temp folder, which ExtendScript
      // can always see via Folder.temp.
      try {
        output = Folder.temp.fsName.replace(/\\/g, "/") + "/captionx-preview-frame.png";
      } catch (tempErr) {
        return JSON.stringify({ error: "No preview path was supplied." });
      }
    }
    try { app.enableQE(); } catch (qeErr) {
      return JSON.stringify({ error: "Premiere did not expose its render engine (QE)." });
    }
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) {
      return JSON.stringify({ error: "Premiere did not expose the active sequence." });
    }
    var timecode = qeSeq.CTI.timecode;
    // Some builds reject forward-slash paths (or the panel-supplied folder);
    // try each variant in turn — native separators, then the OS temp folder.
    var attempts = [output];
    var backslash = output.replace(/\//g, "\\");
    if (backslash !== output) attempts.push(backslash);
    try {
      var tempOut = Folder.temp.fsName.replace(/\\/g, "/") + "/captionx-preview-frame.png";
      if (tempOut !== output && tempOut !== backslash) attempts.push(tempOut);
      var tempBack = tempOut.replace(/\//g, "\\");
      if (tempBack !== tempOut) attempts.push(tempBack);
    } catch (ignoreTemp) { /* keep the original attempts */ }
    var exported = "";
    var lastErr = null;
    for (var a = 0; a < attempts.length; a++) {
      try {
        qeSeq.exportFramePNG(timecode, attempts[a]);
        exported = attempts[a];
        break;
      } catch (attemptErr) {
        lastErr = attemptErr;
      }
    }
    if (!exported) {
      var failMsg = String((lastErr && lastErr.message) || lastErr);
      return JSON.stringify({ error: "captionXExportFrame: exportFramePNG failed for " + attempts.length + " path(s): " + failMsg });
    }
    var candidates = [];
    for (var c = 0; c < attempts.length; c++) {
      candidates.push(attempts[c]);
      candidates.push(attempts[c] + ".png");
    }
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (File(candidates[i]).exists) {
          return JSON.stringify({ path: candidates[i] });
        }
      } catch (ignoreExists) { /* try the next candidate */ }
    }
    // Accepted but not on disk yet — the panel polls briefly before giving up.
    return JSON.stringify({ path: exported, pending: true });
  } catch (e) {
    var msg = String((e && e.message) || e);
    var line = (e && e.line) || 0;
    return JSON.stringify({ error: "captionXExportFrame: " + msg + " (line " + line + ")" });
  }
}

// ── Return the filesystem path of the first clip's media on the sequence ────
// Used by the caption studio preview to play the REAL video instead of a
// gradient placeholder. Video tracks are scanned first, then audio (the
// audio clip's container usually also carries the video stream).
function captionXMediaPathOfClip(clip) {
  try {
    if (clip && clip.projectItem && clip.projectItem.getMediaPath) {
      return String(clip.projectItem.getMediaPath() || "");
    }
  } catch (ignoreMediaPath) { /* offline / nested / title clip — skip */ }
  return "";
}

function captionXGetMediaPath() {
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ error: "Open a Premiere sequence first." });
    }
    var sequence = app.project.activeSequence;
    var mediaPath = "";
    var t, c;
    for (t = 0; t < sequence.videoTracks.numTracks && !mediaPath; t++) {
      var vTrack = sequence.videoTracks[t];
      for (c = 0; c < vTrack.clips.numItems && !mediaPath; c++) {
        mediaPath = captionXMediaPathOfClip(vTrack.clips[c]);
      }
    }
    for (t = 0; t < sequence.audioTracks.numTracks && !mediaPath; t++) {
      var aTrack = sequence.audioTracks[t];
      for (c = 0; c < aTrack.clips.numItems && !mediaPath; c++) {
        mediaPath = captionXMediaPathOfClip(aTrack.clips[c]);
      }
    }
    // Sequence frame size lives on getSettings(), NOT on sequence.frameWidth
    // (which is undefined in ExtendScript and used to report 0x0, forcing the
    // preview stage into a 16:9 fallback even for vertical reels).
    var width = 0, height = 0, fps = 0, durationSec = 0;
    var projectPath = "", sequenceID = "";
    // Identity for the panel's per-project transcript cache: a new project
    // must never inherit the previous project's transcription.
    try { projectPath = String(app.project.path || ""); } catch (ignoreProjectPath) { /* keep "" */ }
    try { sequenceID = String(sequence.sequenceID || ""); } catch (ignoreSequenceId) { /* keep "" */ }
    try {
      var captionSettings = sequence.getSettings();
      width = Number(captionSettings.videoFrameWidth) || 0;
      height = Number(captionSettings.videoFrameHeight) || 0;
      if (!width) width = Number(captionSettings.frameSizeHorizontal) || 0;
      if (!height) height = Number(captionSettings.frameSizeVertical) || 0;
    } catch (ignoreSettings) { /* keep 0 — panel falls back cleanly */ }
    // Timebase is ticks-per-second; fps = TICKS_PER_SECOND / timebase.
    try {
      var tb = Number(sequence.timebase);
      if (tb > 0) fps = Math.round((254016000000 / tb) * 1000) / 1000;
    } catch (ignoreTimebase) { /* keep 0 — panel falls back to 30 */ }
    try {
      if (sequence.end && sequence.end.seconds !== undefined) {
        durationSec = Number(sequence.end.seconds) || 0;
      }
    } catch (ignoreDuration) { /* keep 0 */ }
    return JSON.stringify({
      path: mediaPath,
      duration: durationSec,
      width: width,
      height: height,
      fps: fps,
      projectPath: projectPath,
      sequenceID: sequenceID,
    });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
}
