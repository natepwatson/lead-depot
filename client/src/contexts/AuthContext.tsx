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

  // On mount, validate that the stored user is still active on the server.
  // If the agent was deactivated, clear local storage and force re-login.
  useEffect(() => {
    const stored = loadUser();
    if (!stored) return;
    fetch(`/api/me/${stored.id}`, { credentials: "include" })
      .then(r => {
        if (r.status === 403 || r.status === 404) {
          // Account deactivated or deleted — sign out
          saveUser(null);
          setUser(null);
        }
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
