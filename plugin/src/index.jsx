import React from "react";
import { createRoot } from "react-dom/client";
import App from "./components/App";

/**
 * ErrorBoundary
 * --------------
 * CEP panels run inside Adobe's sandboxed Chromium. Unlike a normal browser,
 * an uncaught render error in the React tree unmounts the root to an empty DOM
 * — the panel goes completely blank and there is no recovery. Wrapping <App />
 * in a class-based error boundary converts any render crash into a visible,
 * recoverable message (with a retry button) instead of a dead blank panel.
 *
 * (Class component required: getDerivedStateFromError / componentDidCatch are
 *  only available on class components, not function components.)
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    this.setState({ error, info });
    try {
      console.error("[CaptionX] Render crash:", error, info?.componentStack);
    } catch {
      /* console may be unavailable in some CEP shells */
    }
  }

  handleReset() {
    this.setState({ hasError: false, error: null, info: null });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: "24px",
            textAlign: "center",
            color: "#e05252",
            fontFamily: "Adobe Clean, -apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          <div style={{ fontSize: "28px", marginBottom: "12px" }}>⚠️</div>
          <h2 style={{ margin: "0 0 8px", fontSize: "15px", color: "#f3effa" }}>
            Something went wrong
          </h2>
          <p style={{ fontSize: "11px", color: "#b4a4c9", marginBottom: "16px" }}>
            The CaptionX panel hit a render error. Reload the panel to continue.
          </p>
          <pre
            style={{
              background: "rgba(120, 40, 40, 0.2)",
              border: "1px solid #6b2020",
              borderRadius: "6px",
              padding: "10px",
              fontSize: "10px",
              color: "#e05252",
              textAlign: "left",
              maxHeight: "140px",
              overflow: "auto",
              marginBottom: "16px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {(this.state.error?.message || String(this.state.error)).slice(0, 600)}
          </pre>
          <button
            className="btn-ghost"
            style={{ width: "100%" }}
            onClick={() => window.location.reload()}
          >
            Reload panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("root");
const root = createRoot(container);
root.render(<ErrorBoundary><App /></ErrorBoundary>);
