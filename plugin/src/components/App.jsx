import React, { useState, useEffect } from "react";
import AuthGate from "./AuthGate";
import StylePicker from "./StylePicker";
import TranscribePanel from "./TranscribePanel";
import PreviewPanel from "./PreviewPanel";
import TimelinePanel from "./TimelinePanel";
import { getStoredToken, clearToken } from "../api/client";
import "./App.css";

const TABS = ["Style", "Transcribe", "Preview", "Timeline"];

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userPlan, setUserPlan] = useState(null);
  const [activeTab, setActiveTab] = useState("Transcribe");
  const [jobResult, setJobResult] = useState(null); // { phrases, words }
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

  useEffect(() => {
    const token = getStoredToken();
    if (token) {
      validateToken(token);
    }
  }, []);

  async function validateToken(token) {
    try {
      const { apiClient } = await import("../api/client");
      const res = await apiClient.get("/api/auth/validate");
      if (res.data.valid) {
        setIsAuthenticated(true);
        setUserPlan(res.data.plan);
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

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="app-logo">
          <span className="logo-text">Caption</span>
          <span className="logo-x">X</span>
        </div>
        <div className="header-right">
          <span className={`plan-badge plan-${userPlan}`}>{userPlan}</span>
          <button className="btn-ghost logout-btn" onClick={handleLogout} title="Logout">
            ↩
          </button>
        </div>
      </header>

      {/* Tab Bar */}
      <nav className="tab-bar">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? "tab-active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <main className="tab-content">
        {activeTab === "Style" && (
          <StylePicker styleConfig={styleConfig} onChange={setStyleConfig} />
        )}
        {activeTab === "Transcribe" && (
          <TranscribePanel
            styleConfig={styleConfig}
            onJobComplete={(result) => {
              setJobResult(result);
              setActiveTab("Preview");
            }}
          />
        )}
        {activeTab === "Preview" && (
          <PreviewPanel jobResult={jobResult} styleConfig={styleConfig} />
        )}
        {activeTab === "Timeline" && (
          <TimelinePanel jobResult={jobResult} styleConfig={styleConfig} />
        )}
      </main>
    </div>
  );
}
