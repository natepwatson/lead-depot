import { createContext, useContext, useState, useEffect, ReactNode } from "react";

interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: "admin" | "agent" | "recruiter";
  headshotUrl?: string | null;
  homeCounty?: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<{ error?: string }>;
  logout: () => void;
  setHeadshot: (url: string) => void;
  setHomeCounty: (county: string) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const STORAGE_KEY = "lead_depot_user";

function loadUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

function saveUser(u: AuthUser | null) {
  if (u) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(loadUser);

  // v14.79 — On mount, validate the stored user is still active on the server
  // AND re-hydrate local state from the server response. Previously we only
  // read the HTTP status to detect deactivation; the JSON payload was thrown
  // away. That meant any admin-side edit (email change, name change, headshot
  // upload, home-county change) was invisible to the agent until they logged
  // out and back in — and any UI that gates on `user.email` (e.g. the
  // WatsonEmailNudge) kept firing against the stale email. Now we replace
  // `user` with the fresh server record on every page load so admin-side
  // edits show up immediately.
  useEffect(() => {
    const stored = loadUser();
    if (!stored) return;
    fetch(`/api/me/${stored.id}`, { credentials: "include" })
      .then(async r => {
        if (r.status === 403 || r.status === 404) {
          // Account deactivated or deleted — sign out
          saveUser(null);
          setUser(null);
          return;
        }
        if (!r.ok) return;
        try {
          const data = await r.json();
          if (data?.agent) {
            // Merge over the stored user so we keep any client-only fields
            // (there shouldn't be any today, but future-proof). Server-side
            // fields overwrite stored ones — that's the whole point.
            const merged = { ...stored, ...data.agent };
            saveUser(merged);
            setUser(merged);
          }
        } catch { /* bad json — keep stored user */ }
      })
      .catch(() => { /* network error — keep session, will fail naturally */ });
  }, []);

  const login = async (email: string, password: string) => {
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "include", // v14.58 — Phase A: receive session cookie
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || "Login failed" };
      saveUser(data.agent);
      setUser(data.agent);
      return {};
    } catch {
      return { error: "Network error" };
    }
  };

  const logout = () => {
    // v14.58 — Phase A: revoke server-side session too (best-effort).
    fetch("/api/logout", { method: "POST", credentials: "include" }).catch(() => {});
    saveUser(null);
    setUser(null);
  };

  const setHeadshot = (url: string) => {
    setUser(prev => {
      if (!prev) return prev;
      const updated = { ...prev, headshotUrl: url };
      saveUser(updated);
      return updated;
    });
  };

  const setHomeCounty = (county: string) => {
    setUser(prev => {
      if (!prev) return prev;
      const updated = { ...prev, homeCounty: county };
      saveUser(updated);
      return updated;
    });
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, setHeadshot, setHomeCounty }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
