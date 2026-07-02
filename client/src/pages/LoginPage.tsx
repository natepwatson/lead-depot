import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";

// ─── Logo SVG ─────────────────────────────────────────────────────────────────
function LogoIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 36 36" fill="none" aria-label="Lead Depot">
      <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.4"/>
      <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
      <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.2"/>
    </svg>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [isIOS, setIsIOS]       = useState(false);
  const [installPrompt, setInstallPrompt] = useState<any>(null);

  // PWA install detection
  useEffect(() => {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = (navigator as any).standalone;
    setIsIOS(ios);
    if (ios && !standalone) setShowInstallBanner(true);
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
      setShowInstallBanner(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === "accepted") setShowInstallBanner(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await login(email.trim(), password);
    } catch {
      setError("Invalid credentials. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.12)",
    padding: "14px 16px",
    borderRadius: 10,
    fontFamily: "'Switzer','Inter',sans-serif",
    fontSize: 15,
    color: "#fff",
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.2s, background 0.2s",
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "100dvh", backgroundImage: "url(/login-bg.jpg)", backgroundSize: "cover", backgroundPosition: "center 30%", backgroundAttachment: "fixed",
      background: "radial-gradient(ellipse at 60% 0%, rgba(200,170,90,0.08) 0%, #080808 55%)",
      fontFamily: "'Switzer','Inter',sans-serif",
      padding: "24px 20px",
    }}>
      {/* Ambient glow */}
      <div style={{
        position: "fixed", top: -120, right: -120, width: 400, height: 400,
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(200,170,90,0.07) 0%, transparent 70%)",
        pointerEvents: "none", zIndex: 0,
      }} />

      {/* Card */}
      <div style={{
        position: "relative", zIndex: 1,
        width: "100%", maxWidth: 400,
        background: "linear-gradient(160deg, rgba(20,20,20,0.98) 0%, rgba(10,10,10,0.98) 100%)",
        border: "1px solid rgba(200,170,90,0.22)",
        borderRadius: 20,
        padding: "36px 28px 40px",
        boxShadow: "0 8px 48px rgba(0,0,0,0.7), 0 0 0 1px rgba(200,170,90,0.06)",
      }}>
        {/* Logo + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <LogoIcon />
          <div>
            <p style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: 22, fontWeight: 400, color: "#fff", margin: 0, lineHeight: 1,
            }}>Lead Depot</p>
            <p style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,170,90,0.6)", margin: "4px 0 0", fontWeight: 600 }}>
              Brothers Group · Momentum Realty
            </p>
          </div>
        </div>

        {/* Headline */}
        <h1 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: 28, fontWeight: 300, color: "#fff",
          margin: "0 0 6px", lineHeight: 1.2,
        }}>Welcome back.</h1>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", margin: "0 0 28px" }}>
          Sign in to your agent portal
        </p>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, display: "block", marginBottom: 7 }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              style={inputStyle}
              onFocus={e => { e.target.style.borderColor = "rgba(200,170,90,0.45)"; e.target.style.background = "rgba(255,255,255,0.07)"; }}
              onBlur={e => { e.target.style.borderColor = "rgba(255,255,255,0.12)"; e.target.style.background = "rgba(255,255,255,0.05)"; }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, display: "block", marginBottom: 7 }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              style={inputStyle}
              onFocus={e => { e.target.style.borderColor = "rgba(200,170,90,0.45)"; e.target.style.background = "rgba(255,255,255,0.07)"; }}
              onBlur={e => { e.target.style.borderColor = "rgba(255,255,255,0.12)"; e.target.style.background = "rgba(255,255,255,0.05)"; }}
            />
          </div>

          {error && (
            <p style={{
              fontSize: 13, color: "#f87171",
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.25)",
              borderRadius: 8, padding: "10px 14px", margin: 0,
            }}>{error}</p>
          )}

          <button type="submit" disabled={loading} style={{
            marginTop: 6,
            width: "100%", padding: "15px",
            background: loading
              ? "rgba(200,170,90,0.35)"
              : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
            border: "none", borderRadius: 10,
            color: "#080808", fontSize: 15, fontWeight: 700,
            letterSpacing: "0.06em", cursor: loading ? "not-allowed" : "pointer",
            boxShadow: loading ? "none" : "0 4px 20px rgba(200,170,90,0.28)",
            transition: "all 0.2s",
          }}>
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        {/* Version */}
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.18)", textAlign: "center", marginTop: 28 }}>
          Lead Depot v11.13
        </p>

        {/* PWA Install Banner */}
        {showInstallBanner && (
          <div style={{
            marginTop: 20,
            padding: "14px 16px",
            background: "linear-gradient(135deg, rgba(200,170,90,0.1) 0%, rgba(200,170,90,0.04) 100%)",
            border: "1px solid rgba(200,170,90,0.28)",
            borderRadius: 12,
          }}>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginBottom: 10, lineHeight: 1.5 }}>
              {isIOS
                ? "Add to Home Screen: tap the Share button then \"Add to Home Screen\""
                : "Install Lead Depot as an app for faster access"}
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {!isIOS && (
                <button onClick={handleInstall} style={{
                  flex: 1, padding: "10px",
                  background: "linear-gradient(135deg,#c8aa5a,#a8893a)",
                  border: "none", borderRadius: 8,
                  color: "#080808", fontSize: 12, fontWeight: 700, cursor: "pointer",
                }}>
                  Add to Home Screen
                </button>
              )}
              <button onClick={() => setShowInstallBanner(false)} style={{
                padding: "10px 14px",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8, color: "rgba(255,255,255,0.5)",
                fontSize: 12, cursor: "pointer",
              }}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
