import axios from "axios";

const API_BASE = process.env.REACT_APP_API_URL || "https://api.captionx.app";
const TOKEN_KEY = "captionx_jwt";

// ─── Token helpers ───────────────────────────────────────────────────────────
// UXP localStorage is synchronous, same as browser localStorage
export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
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
