import { useState, useEffect, useMemo } from "react";
import { useAuth } from "../contexts/AuthContext";
import { apiRequest } from "@/lib/queryClient";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import coachingTips from "../data/coaching-tips.json";

// ─── Forgot Password inline component ───────────────────────────────────────────
function ForgotPasswordLink() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSending(true);
    try {
      await apiRequest("POST", "/api/forgot-password", { email: email.trim() });
      setSent(true);
    } finally {
      setSending(false);
    }
  };

  if (!open) return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      style={{
        background: "none", border: "none", cursor: "pointer",
        fontSize: 12, color: "rgba(200,170,90,0.45)",
        letterSpacing: "0.04em", textAlign: "center",
        width: "100%", marginTop: 8, padding: "4px 0",
      }}
    >
      Forgot password?
    </button>
  );

  return (
    <div style={{
      marginTop: 12, padding: "16px",
      background: "rgba(200,170,90,0.05)",
      border: "1px solid rgba(200,170,90,0.18)",
      borderRadius: 10,
    }}>
      {sent ? (
        <p style={{ fontSize: 13, color: "rgb(134,239,172)", textAlign: "center", lineHeight: 1.6, margin: 0 }}>
          If that email is in our system, a reset link is on its way. Check your inbox.
        </p>
      ) : (
        <form onSubmit={send} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", margin: 0 }}>Enter your email and we\'ll send a reset link.</p>
          <input
            type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="your@email.com"
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(200,170,90,0.2)",
              padding: "10px 12px", borderRadius: 8,
              color: "#fff", fontSize: 13, outline: "none",
              fontFamily: "'Switzer','Inter',sans-serif",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setOpen(false)} style={{ flex: 1, padding: "10px", background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "rgba(255,255,255,0.35)", fontSize: 12, cursor: "pointer" }}>Cancel</button>
            <button type="submit" disabled={sending || !email.trim()} style={{ flex: 2, padding: "10px", background: "linear-gradient(135deg,#c8aa5a,#a8893a)", border: "none", borderRadius: 8, color: "#080808", fontSize: 12, fontWeight: 700, cursor: sending ? "not-allowed" : "pointer", opacity: sending || !email.trim() ? 0.5 : 1 }}>
              {sending ? "Sending…" : "Send Reset Link"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── Logo SVG ─────────────────────────────────────────────────────────────────
function LogoIcon() {
  return (
    <svg width="44" height="44" viewBox="0 0 36 36" fill="none" aria-label="Lead Depot">
      <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.3"/>
      <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.3" strokeLinejoin="round" fill="none"/>
      <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.1"/>
    </svg>
  );
}

// ─── Thin gold divider ────────────────────────────────────────────────────────
function GoldRule() {
  return (
    <div style={{
      width: "100%", height: 1,
      background: "linear-gradient(90deg, transparent 0%, rgba(200,170,90,0.35) 40%, rgba(200,170,90,0.35) 60%, transparent 100%)",
      margin: "24px 0",
    }} />
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function LoginPage() {
  const { login } = useAuth();
  // v14.50 — pull-to-refresh on the login screen too.
  usePullToRefresh(() => window.location.reload());
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  // v14.50 — "Who called me?" lookup right on the login screen.
  // Agent types the last 4+ digits of the incoming caller ID, we look up the
  // lead, and stash the leadId in sessionStorage so AgentView jumps straight
  // to the Work-the-Lead card once they sign in.
  const [lookupDigits, setLookupDigits] = useState("");
  const [lookupOpen, setLookupOpen]     = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResults, setLookupResults] = useState<any[]>([]);
  const [lookupError, setLookupError]   = useState("");

  const runLookup = async (digits: string) => {
    const clean = digits.replace(/\D/g, "");
    if (clean.length < 4) {
      setLookupError("Enter at least 4 digits.");
      return;
    }
    setLookupLoading(true);
    setLookupError("");
    try {
      const res = await fetch(`/api/leads/callback-lookup?last4=${encodeURIComponent(clean)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Lookup failed");
      setLookupResults(data.results || []);
      setLookupOpen(true);
      if ((data.results || []).length === 1) {
        // Single match — pre-select automatically so login jumps straight there.
        try { sessionStorage.setItem("pending_lead_jump", String(data.results[0].leadId)); } catch {}
      }
    } catch (e: any) {
      setLookupError(e?.message || "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  };

  const pickMatch = (leadId: number) => {
    try { sessionStorage.setItem("pending_lead_jump", String(leadId)); } catch {}
    setLookupOpen(false);
  };

  // Pick one random tip per login session
  const tip = useMemo(() => {
    const tips = coachingTips.tips;
    return tips[Math.floor(Math.random() * tips.length)];
  }, []);
  const tipCategory = tip ? coachingTips.categories[tip.category as keyof typeof coachingTips.categories] : null;
  const [isIOS, setIsIOS]       = useState(false);
  const [installPrompt, setInstallPrompt] = useState<any>(null);

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
    // v14.50 — If the agent typed a lookup number but never clicked Search,
    // run the lookup silently and stash the single match (if any) before login.
    if (lookupDigits.replace(/\D/g, "").length >= 4 && lookupResults.length === 0) {
      try {
        const res = await fetch(`/api/leads/callback-lookup?last4=${encodeURIComponent(lookupDigits.replace(/\D/g, ""))}`);
        const data = await res.json();
        if (res.ok && data.results?.length === 1) {
          sessionStorage.setItem("pending_lead_jump", String(data.results[0].leadId));
        }
      } catch { /* non-blocking */ }
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

  return (
    <>
      {/* ── Global styles for this page ────────────────────────────── */}
      <style>{`
        .ld-login-input {
          width: 100%;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.13);
          padding: 15px 16px;
          border-radius: 12px;
          font-family: 'Switzer','Inter',sans-serif;
          font-size: 16px;
          color: #fff;
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.2s, background 0.2s;
          -webkit-appearance: none;
        }
        .ld-login-input::placeholder { color: rgba(255,255,255,0.25); }
        .ld-login-input:focus {
          border-color: rgba(200,170,90,0.55);
          background: rgba(255,255,255,0.09);
        }
        .ld-sign-btn {
          width: 100%;
          padding: 17px;
          border: none;
          border-radius: 12px;
          font-family: 'Switzer','Inter',sans-serif;
          font-size: 15px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          cursor: pointer;
          transition: opacity 0.2s, transform 0.15s;
          -webkit-tap-highlight-color: transparent;
        }
        .ld-sign-btn:active { transform: scale(0.98); opacity: 0.85; }

        /* Fallback for browsers that don't support backdrop-filter (Firefox Android, older Safari) */
        @supports not (backdrop-filter: blur(1px)) {
          .ld-glass-card {
            background: rgba(6,4,2,0.93) !important;
            border: 1px solid rgba(200,170,90,0.55) !important;
            box-shadow: 0 32px 80px rgba(0,0,0,0.85), 0 0 0 1px rgba(200,170,90,0.18), inset 0 1px 0 rgba(200,170,90,0.20) !important;
          }
          .ld-glass-pwabanner {
            background: rgba(6,4,2,0.93) !important;
            border: 1px solid rgba(200,170,90,0.45) !important;
          }
        }
      `}</style>

      {/* ── Page shell ─────────────────────────────────────────────── */}
      <div style={{
        position: "relative",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Switzer','Inter',sans-serif",
        padding: "env(safe-area-inset-top, 20px) 20px env(safe-area-inset-bottom, 20px)",
        boxSizing: "border-box",
        overflowY: "auto",
      }}>

        {/* Background photo */}
        <div style={{
          position: "fixed", inset: 0, zIndex: 0,
          backgroundImage: "url(/login-bg.jpg)",
          backgroundSize: "cover",
          backgroundPosition: "center 25%",
        }} />

        {/* Rich gradient overlay — darker at bottom so card pops */}
        <div style={{
          position: "fixed", inset: 0, zIndex: 1,
          background: "linear-gradient(180deg, rgba(4,4,4,0.55) 0%, rgba(4,4,4,0.70) 50%, rgba(4,4,4,0.88) 100%)",
        }} />

        {/* Soft gold vignette top-right */}
        <div style={{
          position: "fixed", top: -200, right: -200, width: 600, height: 600,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(200,170,90,0.10) 0%, transparent 65%)",
          pointerEvents: "none", zIndex: 2,
        }} />

        {/* ── Card ───────────────────────────────────────────────── */}
        <div style={{
          position: "relative", zIndex: 3,
          width: "100%", maxWidth: 420,
        }}>

          {/* Top wordmark — floats above card */}
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            marginBottom: 28, gap: 10,
          }}>
            <LogoIcon />
            <div style={{ textAlign: "center" }}>
              <p style={{
                fontFamily: "'Cormorant Garamond','Georgia',serif",
                fontSize: 26, fontWeight: 400, color: "#fff",
                margin: 0, lineHeight: 1, letterSpacing: "0.02em",
              }}>Lead Depot</p>
              <p style={{
                fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase",
                color: "rgba(200,170,90,0.65)", margin: "6px 0 0", fontWeight: 600,
              }}>
                Brothers Group · Momentum Realty
              </p>
            </div>
          </div>

          {/* Glass card body */}
          <div className="ld-glass-card" style={{
            background: "rgba(6,5,4,0.78)",
            backdropFilter: "blur(32px)",
            WebkitBackdropFilter: "blur(32px)",
            border: "1px solid rgba(200,170,90,0.38)",
            borderRadius: 24,
            padding: "36px 28px 32px",
            boxShadow: [
              "0 32px 80px rgba(0,0,0,0.75)",
              "0 0 0 1px rgba(200,170,90,0.10)",
              "inset 0 1px 0 rgba(200,170,90,0.16)",
              "inset 0 -1px 0 rgba(0,0,0,0.4)",
            ].join(", "),
          }}>

            {/* Headline */}
            <h1 style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: 32, fontWeight: 300, color: "#fff",
              margin: "0 0 4px", lineHeight: 1.15, letterSpacing: "0.01em",
            }}>Welcome back.</h1>
            <p style={{
              fontSize: 13, color: "rgba(255,255,255,0.38)",
              margin: "0 0 0", letterSpacing: "0.01em",
            }}>
              Sign in to your agent portal
            </p>

            <GoldRule />

            {/* v14.50 — "Who called me?" quick lookup (pre-login) */}
            <div style={{
              marginBottom: 18,
              padding: "14px 14px 12px",
              background: "rgba(200,170,90,0.06)",
              border: "1px solid rgba(200,170,90,0.28)",
              borderRadius: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <p style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "#c8aa5a", fontWeight: 700, margin: 0 }}>
                  Who called me?
                </p>
                <p style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", margin: 0 }}>Last 4+ digits</p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="ld-login-input"
                  type="tel"
                  inputMode="numeric"
                  placeholder="1234"
                  value={lookupDigits}
                  onChange={e => { setLookupDigits(e.target.value); setLookupError(""); }}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); runLookup(lookupDigits); } }}
                  style={{ flex: 1, padding: "11px 14px", fontSize: 15 }}
                  maxLength={15}
                />
                <button
                  type="button"
                  onClick={() => runLookup(lookupDigits)}
                  disabled={lookupLoading}
                  style={{
                    padding: "0 16px",
                    background: "linear-gradient(135deg,#c8aa5a,#a8893a)",
                    color: "#0a0700", border: "none", borderRadius: 12,
                    fontSize: 12, fontWeight: 700, letterSpacing: "0.08em",
                    textTransform: "uppercase", cursor: lookupLoading ? "wait" : "pointer",
                  }}>
                  {lookupLoading ? "…" : "Find"}
                </button>
              </div>
              {lookupError && (
                <p style={{ fontSize: 11, color: "#f87171", margin: "8px 0 0" }}>{lookupError}</p>
              )}
              <p style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", margin: "8px 0 0", lineHeight: 1.4 }}>
                Type the last 4 digits of the caller and sign in — the lead card opens instantly.
              </p>
            </div>

            {/* v14.50 — Lookup results modal */}
            {lookupOpen && (
              <div
                onClick={() => setLookupOpen(false)}
                style={{
                  position: "fixed", inset: 0, zIndex: 100,
                  background: "rgba(0,0,0,0.72)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
                }}>
                <div
                  onClick={e => e.stopPropagation()}
                  style={{
                    width: "100%", maxWidth: 440, maxHeight: "85vh", overflowY: "auto",
                    background: "#0c0b0a",
                    border: "1px solid rgba(200,170,90,0.4)",
                    borderRadius: 16,
                    padding: "20px 20px 16px",
                    boxShadow: "0 24px 60px rgba(0,0,0,0.8)",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <p style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 22, color: "#fff", margin: 0 }}>
                      {lookupResults.length} match{lookupResults.length === 1 ? "" : "es"}
                    </p>
                    <button onClick={() => setLookupOpen(false)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.5)", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>×</button>
                  </div>
                  {lookupResults.length === 0 ? (
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", padding: "18px 0" }}>
                      No leads match those digits. Try more digits from the caller ID.
                    </p>
                  ) : lookupResults.length === 1 ? (
                    <div>
                      <p style={{ fontSize: 13, color: "rgba(200,170,90,0.85)", marginBottom: 12, lineHeight: 1.5 }}>
                        We found this lead. Sign in and it will open automatically.
                      </p>
                      <div style={{
                        padding: 14, background: "rgba(200,170,90,0.08)",
                        border: "1px solid rgba(200,170,90,0.28)", borderRadius: 10, marginBottom: 12,
                      }}>
                        <p style={{ fontSize: 16, fontWeight: 700, color: "#fff", margin: 0 }}>{lookupResults[0].ownerName || "(no name)"}</p>
                        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", margin: "4px 0 0" }}>{lookupResults[0].address || "(no address)"}</p>
                        {lookupResults[0].assignedAgentName && (
                          <p style={{ fontSize: 11, color: "rgba(200,170,90,0.7)", margin: "6px 0 0" }}>Owned by {lookupResults[0].assignedAgentName}</p>
                        )}
                        {lookupResults[0].lastOutcome && (
                          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", margin: "4px 0 0" }}>
                            Last outcome: {lookupResults[0].lastOutcome.replace(/_/g, " ")}
                          </p>
                        )}
                      </div>
                      <button onClick={() => setLookupOpen(false)} style={{
                        width: "100%", padding: "12px", background: "linear-gradient(135deg,#c8aa5a,#a8893a)",
                        border: "none", borderRadius: 10, color: "#0a0700", fontSize: 13, fontWeight: 700,
                        letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
                      }}>Sign in →</button>
                    </div>
                  ) : (
                    <div>
                      <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginBottom: 10, lineHeight: 1.5 }}>
                        Multiple matches (most recent first). Pick the right one — use the area code or middle digits to disambiguate.
                      </p>
                      {lookupResults.map((r: any) => (
                        <button
                          key={r.leadId}
                          onClick={() => pickMatch(r.leadId)}
                          style={{
                            width: "100%", textAlign: "left", padding: "12px 14px", marginBottom: 8,
                            background: "rgba(255,255,255,0.03)",
                            border: "1px solid rgba(200,170,90,0.2)",
                            borderRadius: 10, cursor: "pointer",
                          }}>
                          <p style={{ fontSize: 14, fontWeight: 700, color: "#fff", margin: 0 }}>{r.ownerName || "(no name)"}</p>
                          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", margin: "3px 0 0" }}>{r.address || "(no address)"} · {r.phone}</p>
                          <p style={{ fontSize: 10, color: "rgba(200,170,90,0.7)", margin: "3px 0 0" }}>
                            {r.assignedAgentName ? `Owned by ${r.assignedAgentName}` : "Pool"}
                            {r.lastOutcomeAt ? ` · ${new Date(r.lastOutcomeAt).toLocaleDateString()}` : ""}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              <div>
                <label style={{
                  fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase",
                  color: "rgba(200,170,90,0.7)", fontWeight: 600,
                  display: "block", marginBottom: 8,
                }}>Email</label>
                <input
                  className="ld-login-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  inputMode="email"
                />
              </div>

              <div>
                <label style={{
                  fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase",
                  color: "rgba(200,170,90,0.7)", fontWeight: 600,
                  display: "block", marginBottom: 8,
                }}>Password</label>
                <input
                  className="ld-login-input"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>

              {error && (
                <p style={{
                  fontSize: 13, color: "#f87171",
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.22)",
                  borderRadius: 10, padding: "11px 14px", margin: 0, lineHeight: 1.4,
                }}>{error}</p>
              )}

              <button
                className="ld-sign-btn"
                type="submit"
                disabled={loading}
                style={{
                  marginTop: 4,
                  background: loading
                    ? "rgba(200,170,90,0.3)"
                    : "linear-gradient(135deg, #d4b56a 0%, #a8893a 100%)",
                  color: loading ? "rgba(255,255,255,0.4)" : "#0a0700",
                  boxShadow: loading ? "none" : "0 6px 28px rgba(200,170,90,0.30), inset 0 1px 0 rgba(255,255,255,0.18)",
                  cursor: loading ? "not-allowed" : "pointer",
                }}
              >
                {loading ? "Signing in…" : "Sign In"}
              </button>
              <ForgotPasswordLink />
            </form>

            {/* Coaching Tip */}
            {tip && tipCategory && (
              <div style={{
                marginTop: 20,
                padding: "14px 16px",
                background: "rgba(255,255,255,0.03)",
                border: `1px solid ${tipCategory.color}22`,
                borderLeft: `3px solid ${tipCategory.color}`,
                borderRadius: 10,
              }}>
                <div style={{
                  fontSize: 9, fontWeight: 600, letterSpacing: "0.1em",
                  textTransform: "uppercase", color: tipCategory.color,
                  marginBottom: 6, opacity: 0.85,
                }}>
                  {tipCategory.label}
                </div>
                <p style={{
                  fontSize: 12, color: "rgba(255,255,255,0.55)",
                  lineHeight: 1.6, margin: 0,
                  fontFamily: tip.type === "quote" ? "'Cormorant Garamond','Georgia',serif" : "'Switzer','Inter',sans-serif",
                  fontStyle: tip.type === "quote" ? "italic" : "normal",
                }}>
                  {tip.type === "quote" ? `"${tip.text}"` : tip.text}
                </p>
                {tip.author && (
                  <p style={{
                    fontSize: 10, color: "rgba(255,255,255,0.25)",
                    margin: "6px 0 0", letterSpacing: "0.05em",
                  }}>
                    — {tip.author}
                  </p>
                )}
              </div>
            )}

            {/* Version */}
            <p style={{
              fontSize: 10, color: "rgba(255,255,255,0.15)", textAlign: "center",
              marginTop: 16, marginBottom: 0, letterSpacing: "0.08em",
            }}>
              Lead Depot v15.11.30
            </p>
          </div>

          {/* PWA Install Banner */}
          {showInstallBanner && (
            <div className="ld-glass-pwabanner" style={{
              marginTop: 16,
              padding: "16px 18px",
              background: "rgba(6,5,4,0.78)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              border: "1px solid rgba(200,170,90,0.38)",
              borderRadius: 16,
              boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            }}>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginBottom: 12, lineHeight: 1.6, margin: "0 0 12px" }}>
                {isIOS
                  ? "📲 Add to Home Screen: tap Share then \"Add to Home Screen\""
                  : "Install Lead Depot as an app for faster access"}
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                {!isIOS && (
                  <button onClick={handleInstall} style={{
                    flex: 1, padding: "11px",
                    background: "linear-gradient(135deg,#d4b56a,#a8893a)",
                    border: "none", borderRadius: 9,
                    color: "#0a0700", fontSize: 12, fontWeight: 700,
                    cursor: "pointer", letterSpacing: "0.05em",
                  }}>
                    Add to Home Screen
                  </button>
                )}
                <button onClick={() => setShowInstallBanner(false)} style={{
                  padding: "11px 16px",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 9, color: "rgba(255,255,255,0.45)",
                  fontSize: 12, cursor: "pointer",
                }}>
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
