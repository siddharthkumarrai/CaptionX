import { useState, useEffect, useCallback } from "react";
import { exportTimelineFrame, cepAvailable } from "../api/cep";

/**
 * useTimelineFrame
 * ================
 * Loads a still of the current Premiere playhead frame as a data: URL for
 * the caption stage backdrop (and the review video poster).
 *
 * Why a still instead of just the <video> element: phone/camera footage is
 * often HEVC/H.265, which the panel's Chromium cannot decode at all — the
 * file path can be perfectly correct and the stage still stays black. A
 * frame exported by Premiere itself always shows the real timeline pixels
 * for any codec, in the sequence's own aspect ratio.
 *
 * @param {string} refreshKey — re-export when this changes (sequence/video)
 */
export default function useTimelineFrame(refreshKey) {
  const [frameUrl, setFrameUrl] = useState("");
  const [frameStatus, setFrameStatus] = useState("");
  const [loadingFrame, setLoadingFrame] = useState(false);

  const refreshFrame = useCallback(async () => {
    if (!cepAvailable()) return;
    setLoadingFrame(true);
    setFrameStatus("Loading the current timeline frame…");
    try {
      const url = await exportTimelineFrame();
      setFrameUrl(url);
      setFrameStatus("");
    } catch (e) {
      setFrameStatus(e?.message || "Timeline frame unavailable.");
    } finally {
      setLoadingFrame(false);
    }
  }, []);

  useEffect(() => {
    refreshFrame();
  }, [refreshFrame, refreshKey]);

  return { frameUrl, frameStatus, loadingFrame, refreshFrame };
}
