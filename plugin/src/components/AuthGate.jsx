import React, { useState } from "react";
import { apiClient, storeToken } from "../api/client";

export default function AuthGate({ onLoginSuccess }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await apiClient.post(endpoint, { email, password });
      storeToken(res.data.access_token);
      onLoginSuccess(res.data.plan ?? "free");
    } catch (err) {
      setError(err.response?.data?.detail ?? "Authentication failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.logoWrap}>
        <span style={styles.logoText}>Caption</span>
        <span style={styles.logoX}>X</span>
      </div>
      <p style={styles.tagline}>AI-powered word-level captions for Premiere</p>

      <div style={styles.modeToggle}>
        <button
          style={{ ...styles.modeBtn, ...(mode === "login" ? styles.modeBtnActive : {}) }}
          onClick={() => setMode("login")}
        >
          Sign In
        </button>
        <button
          style={{ ...styles.modeBtn, ...(mode === "register" ? styles.modeBtnActive : {}) }}
          onClick={() => setMode("register")}
        >
          Create Account
        </button>
      </div>

      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            style={styles.input}
          />
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            minLength={8}
            style={styles.input}
          />
        </div>

        {error && <p style={styles.error}>{error}</p>}

        <button type="submit" disabled={loading} style={styles.submitBtn}>
          {loading ? "Please wait…" : mode === "login" ? "Sign In" : "Create Account"}
        </button>
      </form>

      <p style={styles.disclaimer}>
        By continuing you agree to our{" "}
        <a href="https://captionx.app/terms" style={styles.link}>Terms of Service</a>
      </p>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "32px 20px",
    gap: "12px",
    minHeight: "100vh",
    background: "#1e1e1e",
  },
  logoWrap: { display: "flex", alignItems: "baseline", gap: "2px", marginBottom: "4px" },
  logoText: { fontSize: "28px", fontWeight: "900", color: "#e0e0e0" },
  logoX:    { fontSize: "28px", fontWeight: "900", color: "#FFD700" },
  tagline:  { fontSize: "11px", color: "#888", textAlign: "center", marginBottom: "8px" },
  modeToggle: {
    display: "flex",
    background: "#2a2a2a",
    borderRadius: "8px",
    padding: "3px",
    gap: "3px",
    width: "100%",
  },
  modeBtn: {
    flex: 1,
    padding: "7px",
    background: "none",
    border: "none",
    color: "#888",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: "600",
    transition: "all 0.15s",
  },
  modeBtnActive: { background: "#333", color: "#e0e0e0" },
  form: { width: "100%", display: "flex", flexDirection: "column", gap: "10px" },
  fieldGroup: { display: "flex", flexDirection: "column", gap: "4px" },
  label: { fontSize: "10px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", color: "#888" },
  input: {
    background: "#2a2a2a",
    border: "1px solid #444",
    borderRadius: "6px",
    color: "#e0e0e0",
    padding: "8px 10px",
    fontSize: "12px",
    outline: "none",
    width: "100%",
  },
  error:  { fontSize: "11px", color: "#e05252", textAlign: "center" },
  submitBtn: {
    width: "100%",
    padding: "10px",
    background: "#4a90d9",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: "700",
    cursor: "pointer",
    marginTop: "4px",
  },
  disclaimer: { fontSize: "10px", color: "#666", textAlign: "center" },
  link:       { color: "#4a90d9", textDecoration: "none" },
};
