/**
 * usePremiere.js
 * ==============
 * Single source of truth for ALL Adobe Premiere DOM interactions.
 * Uses the async UXP API (premierepro module) — NOT ExtendScript/CEP.
 *
 * Key rules:
 * - Every Premiere DOM call MUST be awaited.
 * - Bulk mutations MUST be wrapped in project.executeTransaction().
 * - Never import this from a non-UXP environment (e.g., tests mock it).
 *
 * Premiere tick constant: 1 second = 254,016,000,000 ticks
 * (Derived from: 254016000000 = LCM of all standard video frame rates)
 */

// UXP runtime provides this — externalised in webpack.config.js
const { app } = typeof window !== "undefined" && window.premierepro
  ? window.premierepro
  : require("premierepro");

const { storage } = require("uxp");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const TICKS_PER_SECOND = BigInt("254016000000");

function secToTick(sec) {
  // Round to nearest tick to avoid floating-point drift
  return BigInt(Math.round(sec * Number(TICKS_PER_SECOND)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Project / Sequence helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function getActiveProject() {
  const project = await app.Project.getActiveProject();
  if (!project) throw new Error("No active Premiere project. Please open a project first.");
  return project;
}

export async function getActiveSequence() {
  const project = await getActiveProject();
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Please open a sequence in the timeline.");
  return { project, sequence };
}

export async function getSequenceResolution() {
  const { sequence } = await getActiveSequence();
  return {
    width: await sequence.videoFrameWidth,
    height: await sequence.videoFrameHeight,
    frameRate: await sequence.timebase,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Caption clip placement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * importAndPlaceCaptions
 * @param {Array<{localPath: string, startSec: number, durationSec: number, trackIndex: number}>} captionAssets
 */
export async function importAndPlaceCaptions(captionAssets) {
  if (!captionAssets || captionAssets.length === 0) return;

  const { project, sequence } = await getActiveSequence();

  await project.executeTransaction(async (transaction) => {
    for (const asset of captionAssets) {
      // Import the MOV/PNG file into the project bin
      const importedItem = await project.importFile(asset.localPath);
      if (!importedItem) {
        console.warn(`[CaptionX] Failed to import: ${asset.localPath}`);
        continue;
      }

      // Get the video track at the specified index (0-based internally)
      const videoTrack = await sequence.getVideoTrackAt(asset.trackIndex ?? 1);
      if (!videoTrack) {
        throw new Error(`Video track ${asset.trackIndex} not found. Add more video tracks in Premiere.`);
      }

      const startTick = secToTick(asset.startSec);
      const endTick = secToTick(asset.startSec + asset.durationSec);

      await videoTrack.insertClip(importedItem, startTick, endTick, transaction);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SFX placement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * importAndPlaceSFX
 * @param {Array<{localPath: string, startSec: number, trackIndex: number}>} sfxAssets
 */
export async function importAndPlaceSFX(sfxAssets) {
  if (!sfxAssets || sfxAssets.length === 0) return;

  const { project, sequence } = await getActiveSequence();

  await project.executeTransaction(async (transaction) => {
    // Cache the imported SFX item to avoid re-importing the same file N times
    const importCache = new Map();

    for (const sfx of sfxAssets) {
      let importedItem = importCache.get(sfx.localPath);
      if (!importedItem) {
        importedItem = await project.importFile(sfx.localPath);
        if (!importedItem) {
          console.warn(`[CaptionX] Failed to import SFX: ${sfx.localPath}`);
          continue;
        }
        importCache.set(sfx.localPath, importedItem);
      }

      const audioTrack = await sequence.getAudioTrackAt(sfx.trackIndex ?? 3);
      if (!audioTrack) {
        throw new Error(`Audio track ${sfx.trackIndex} not found.`);
      }

      const startTick = secToTick(sfx.startSec);
      // SFX clips: let Premiere use the clip's native duration (pass null for end)
      await audioTrack.insertClip(importedItem, startTick, null, transaction);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Local file download helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * downloadFileToTemp
 * Downloads remote asset URLs to the UXP temp folder and returns
 * the updated asset list with local file paths.
 *
 * @param {Array<{asset_url: string, startSec: number, durationSec?: number, trackIndex?: number}>} assets
 * @returns {Array<{localPath: string, startSec: number, durationSec?: number, trackIndex?: number}>}
 */
export async function downloadFileToTemp(assets) {
  if (!assets || assets.length === 0) return [];

  // UXP storage.localFileSystem gives access to the local filesystem
  const tempFolder = await storage.localFileSystem.getTemporaryFolder();
  const localAssets = [];

  for (const asset of assets) {
    const fileName = asset.asset_url.split("/").pop().split("?")[0];
    const localFile = await tempFolder.createFile(fileName, { overwrite: true });

    // Fetch remote asset
    const response = await fetch(asset.asset_url);
    if (!response.ok) {
      throw new Error(`Failed to download asset: ${asset.asset_url} (${response.status})`);
    }
    const buffer = await response.arrayBuffer();
    await localFile.write(buffer, { format: storage.formats.binary });

    localAssets.push({
      ...asset,
      localPath: localFile.nativePath, // absolute local path Premiere can read
    });
  }

  return localAssets;
}
