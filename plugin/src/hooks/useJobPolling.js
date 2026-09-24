import { useState, useEffect, useRef } from "react";

// CEP panels run in an old Chromium without Node globals.
// Avoid `globalThis.process?.env` (optional-chaining on a possibly-undefined
// global can break the bundle in CEP) — read env defensively instead.
function getEnv(name) {
  try {
    if (typeof globalThis !== "undefined" && globalThis.process && globalThis.process.env) {
      return globalThis.process.env[name] || "";
    }
  } catch {
    // ignore — fall through to default
  }
  return "";
}

const WS_BASE = getEnv("REACT_APP_WS_URL") || getEnv("WS_URL") || "ws://localhost:8000/api/jobs";

/**
 * useJobPolling
 * =============
 * Opens a WebSocket connection to track a job's progress.
 * Falls back to HTTP polling if WebSocket is unavailable.
 *
 * @param {string|null} jobId — The job ID to monitor (null = no-op)
 * @param {{ onComplete: Function, onError: Function }} callbacks
 * @returns {{ status: string, progress: number, message: string }}
 */
export default function useJobPolling(jobId, { onComplete, onError } = {}) {
  const [status, setStatus] = useState(null);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const wsRef = useRef(null);
  // Tracks whether the HTTP fallback has started for the current job.
  // MUST live at the top level — hooks can never be called inside useEffect
  // (calling useRef/useState inside an effect throws React error #321).
  const pollingStartedRef = useRef(false);
  const pollIntervalRef = useRef(null);
  const completedRef = useRef(false);
  // Latest callbacks (effect below only depends on jobId, so keep these fresh
  // via refs instead of adding them to the dep array).
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  onCompleteRef.current = onComplete;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!jobId) {
      setStatus(null);
      setProgress(0);
      setMessage("");
      pollingStartedRef.current = false;
      completedRef.current = false;
      return;
    }

    // Reset per-job bookkeeping.
    pollingStartedRef.current = false;
    completedRef.current = false;

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    setStatus("pending");
    setProgress(0);
    setMessage("Queued — waiting for worker…");

    const ws = new WebSocket(`${WS_BASE}/ws/${jobId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("pending");
      setMessage("Connected to server…");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Adopt the server's message verbatim — including an empty string,
        // so the "Connected…" / "Queued…" placeholders never get stuck.
        if (data.status) setStatus(data.status);
        if (data.progress !== undefined) setProgress(data.progress);
        if (data.message !== undefined) setMessage(data.message);

        if (data.status === "done") {
          completedRef.current = true;
          ws.close();
          setProgress(100);
          setMessage(data.message || "Complete!");
          if (onCompleteRef.current) onCompleteRef.current(data.result);
        }

        if (data.status === "error") {
          completedRef.current = true;
          ws.close();
          setMessage(data.message || "Job failed");
          if (onErrorRef.current) onErrorRef.current(data.message || "Job failed");
        }
      } catch (e) {
        console.error("[useJobPolling] Parse error:", e);
      }
    };

    ws.onerror = () => {
      setMessage("Connection error — retrying via HTTP polling…");
    };

    ws.onclose = (e) => {
      // If the job wasn't completed/errored, fall back to HTTP polling so the
      // user still gets progress updates (WebSocket can be flaky from the
      // sandboxed panel context).
      if (!completedRef.current && !pollingStartedRef.current && jobId) {
        pollingStartedRef.current = true;
        startHttpPolling(jobId);
      } else if (e && !e.wasClean && !completedRef.current) {
        setMessage("Connection dropped — polling server…");
      }
    };

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [jobId]);

  async function startHttpPolling(jId) {
    const { apiClient } = await import("../api/client");
    let attempts = 0;
    const maxAttempts = 120; // 10 min at 5s intervals
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    const interval = setInterval(async () => {
      pollIntervalRef.current = interval;
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(interval);
        pollIntervalRef.current = null;
        completedRef.current = true;
        setStatus("error");
        if (onErrorRef.current) onErrorRef.current("Job timed out after 10 minutes");
        return;
      }

      try {
        const res = await apiClient.get(`/api/jobs/${jId}`);
        const data = res.data;

        if (data.status) setStatus(data.status);
        if (data.progress !== undefined) setProgress(data.progress);
        if (data.message !== undefined) setMessage(data.message);

        if (data.status === "done") {
          clearInterval(interval);
          pollIntervalRef.current = null;
          completedRef.current = true;
          if (onCompleteRef.current) onCompleteRef.current(data.result);
        }
        if (data.status === "error") {
          clearInterval(interval);
          pollIntervalRef.current = null;
          completedRef.current = true;
          if (onErrorRef.current) onErrorRef.current(data.message);
        }
      } catch (e) {
        console.warn("[useJobPolling] HTTP poll error:", e.message);
      }
    }, 5000);
  }

  return { status, progress, message };
}
