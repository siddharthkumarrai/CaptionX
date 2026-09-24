import axios from "axios";

// CEP panels run in an old/sandboxed Chromium without Node globals.
// Never touch `globalThis.process?.env` directly at module scope — read it
// defensively so a missing global can't break the whole bundle at load.
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

const API_BASE = getEnv("REACT_APP_API_URL") || "http://localhost:8000";

// Base URL for resources the <video> element loads directly (it cannot send
// Authorization headers, so those endpoints take ?token= instead).
export function getApiBaseUrl() {
  return API_BASE;
}
const TOKEN_KEY = "captionx_jwt";
const CEP_SESSION_FILE = "captionx-session.json";

function getCepSessionPath() {
  const cep = typeof window !== "undefined" ? window.cep : null;
  const systemPath = cep?.fs?.SystemPath;
  if (!cep?.fs?.getSystemPath || !systemPath?.USER_DATA) return null;
  const base = cep.fs.getSystemPath(systemPath.USER_DATA);
  return `${base.replace(/[\\/]$/, "")}/CaptionX/${CEP_SESSION_FILE}`;
}

function readCepToken() {
  try {
    const cep = window.cep;
    const path = getCepSessionPath();
    if (!cep?.fs?.readFile || !path) return null;
    const result = cep.fs.readFile(path);
    if (result.err || !result.data) return null;
    return JSON.parse(result.data).accessToken || null;
  } catch {
    return null;
  }
}

function writeCepToken(token) {
  try {
    const cep = window.cep;
    const path = getCepSessionPath();
    if (!cep?.fs?.writeFile || !path) return;
    const directory = path.slice(0, path.lastIndexOf("/"));
    if (cep.fs.makedir) cep.fs.makedir(directory);
    cep.fs.writeFile(path, JSON.stringify({ accessToken: token }));
  } catch {
    // localStorage remains the fallback when CEP filesystem access is unavailable.
  }
}

// ─── Token helpers ───────────────────────────────────────────────────────────
// UXP localStorage is synchronous, same as browser localStorage
export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || readCepToken();
  } catch {
    return readCepToken();
  }
}

export function storeToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* CEP fallback below */ }
  writeCepToken(token);
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* no-op */ }
  try {
    const cep = window.cep;
    const path = getCepSessionPath();
    if (cep?.fs?.deleteFile && path) cep.fs.deleteFile(path);
  } catch {
    // Session cleanup is best effort.
  }
}

// ─── Axios instance ───────────────────────────────────────────────────────────
export const apiClient = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
});

// Attach JWT on every request
apiClient.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Auto-refresh on 401
apiClient.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        const res = await axios.post(`${API_BASE}/api/auth/refresh`, {}, {
          withCredentials: true,
        });
        storeToken(res.data.access_token);
        original.headers.Authorization = `Bearer ${res.data.access_token}`;
        return apiClient(original);
      } catch {
        clearToken();
        // Reload panel to show auth gate
        window.location.reload();
      }
    }
    return Promise.reject(error);
  }
);
