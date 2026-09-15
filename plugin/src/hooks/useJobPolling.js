import { useState, useEffect, useRef } from "react";

const WS_BASE = process.env.REACT_APP_WS_URL || "wss://api.captionx.app";

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

  useEffect(() => {
    if (!jobId) {
      setStatus(null);
      setProgress(0);
      setMessage("");
      return;
    }

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
    }

    setStatus("pending");
    setProgress(0);
    setMessage("Connecting…");

    const ws = new WebSocket(`${WS_BASE}/ws/jobs/${jobId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("running");
      setMessage("Connected — processing…");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.status) setStatus(data.status);
        if (data.progress !== undefined) setProgress(data.progress);
        if (data.message) setMessage(data.message);

        if (data.status === "done") {
          ws.close();
          setProgress(100);
          setMessage("Complete!");
          onComplete && onComplete(data.result);
        }

        if (data.status === "error") {
          ws.close();
          setMessage(data.message ?? "Job failed");
          onError && onError(data.message ?? "Job failed");
        }
      } catch (e) {
        console.error("[useJobPolling] Parse error:", e);
      }
    };

    ws.onerror = () => {
      setStatus("error");
      setMessage("Connection error — retrying…");
      // Fallback: start HTTP polling
      startHttpPolling(jobId);
    };

    ws.onclose = (e) => {
      if (!e.wasClean && status !== "done" && status !== "error") {
        setMessage("Connection dropped");
      }
    };

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [jobId]);

  async function startHttpPolling(jId) {
    const { apiClient } = await import("../api/client");
    let attempts = 0;
    const maxAttempts = 120; // 10 min at 5s intervals

    const interval = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(interval);
        setStatus("error");
        onError && onError("Job timed out after 10 minutes");
        return;
      }

      try {
        const res = await apiClient.get(`/api/jobs/${jId}`);
        const data = res.data;

        if (data.status) setStatus(data.status);
        if (data.progress !== undefined) setProgress(data.progress);
        if (data.message) setMessage(data.message);

        if (data.status === "done") {
          clearInterval(interval);
          onComplete && onComplete(data.result);
        }
        if (data.status === "error") {
          clearInterval(interval);
          onError && onError(data.message);
        }
      } catch (e) {
        console.warn("[useJobPolling] HTTP poll error:", e.message);
      }
    }, 5000);
  }

  return { status, progress, message };
}
