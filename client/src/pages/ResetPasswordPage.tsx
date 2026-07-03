/**
 * ResetPasswordPage — shown when agent clicks a password reset link from email.
 * Route: /#/reset-password/:token
 */
import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Lock, Eye, EyeOff, CheckCircle2, AlertTriangle, Loader2, ChevronRight } from "lucide-react";

function Logo() {
  return (
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <svg width="40" height="40" viewBox="0 0 36 36" fill="none" style={{ margin: "0 auto 10px", display: "block" }}>
        <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.6"/>
        <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
        <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.4"/>
      </svg>
      <p style={{ color: "#c8aa5a", letterSpacing: "0.2em", fontSize: 10, textTransform: "uppercase", margin: 0 }}>
        Brothers Group · Momentum Realty
      </p>
    </div>
  );
}

function strength(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (s <= 1) return { score: s, label: "Weak",   color: "#ef4444" };
  if (s <= 2) return { score: s, label: "Fair",   color: "#f59e0b" };
  if (s <= 3) return { score: s, label: "Good",   color: "#22c55e" };
  return             { score: s, label: "Strong", color: "#4ade80" };
}

const page: React.CSSProperties = {
  minHeight: "100dvh",
  background: "linear-gradient(160deg,#0a0a0a 0%,#0f0d08 100%)",
  display: "flex", flexDirection: "column", alignItems: "center",
  justifyContent: "center", padding: "24px 20px",
  fontFamily: "'Switzer','Inter',sans-serif",
};
const card: React.CSSProperties = {
  width: "100%", maxWidth: 420,
  background: "rgba(15,13,8,0.96)",
  border: "1px solid rgba(200,170,90,0.2)",
  borderRadius: 18,
  boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
  padding: "32px 24px 28px",
};
const inp: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(200,170,90,0.2)",
  padding: "11px 14px", borderRadius: 8,
  fontFamily: "'Switzer','Inter',sans-serif", fontSize: 14,
  color: "#fff", outline: "none", boxSizing: "border-box",
};
const lbl: React.CSSProperties = {
  display: "block", fontSize: 10, letterSpacing: "0.18em",
  textTransform: "uppercase", color: "rgba(200,170,90,0.55)",
  marginBottom: 6, fontWeight: 600,
};
const goldBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
  width: "100%", padding: "13px",
  background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
  border: "none", borderRadius: 8,
  fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as const,
  color: "#080808", cursor: "pointer",
  boxShadow: "0 4px 16px rgba(200,170,90,0.25)",
};

export default function ResetPasswordPage() {
  const [, params] = useRoute("/reset-password/:token");
  const token = params?.token ?? "";

  const [status, setStatus] = useState<"loading" | "ready" | "invalid" | "done">("loading");
  const [agent, setAgent] = useState<{ name: string; email: string } | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!token) { setStatus("invalid"); setErrorMsg("No reset token."); return; }
    apiRequest("GET", `/api/reset-password/${token}`)
      .then(async r => {
        if (!r.ok) { const b = await r.json(); throw new Error(b.error); }
        return r.json();
      })
      .then(d => { setAgent(d); setStatus("ready"); })
      .catch(e => { setErrorMsg(e.message); setStatus("invalid"); });
  }, [token]);

  const pwStr = strength(pw);
  const valid = pw.length >= 8 && pw === pw2;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setErrorMsg("");
    try {
      const r = await apiRequest("POST", `/api/reset-password/${token}`, { password: pw });
      if (!r.ok) { const b = await r.json(); throw new Error(b.error); }
      setStatus("done");
    } catch (e: any) {
      setErrorMsg(e.message || "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  if (status === "loading") return (
    <div style={page}>
      <Logo />
      <div style={{ color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
        <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /> Verifying link…
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (status === "invalid") return (
    <div style={page}>
      <div style={card}>
        <Logo />
        <div style={{ textAlign: "center" }}>
          <AlertTriangle size={36} style={{ color: "#ef4444", marginBottom: 16 }} />
          <h2 style={{ color: "#fff", fontWeight: 300, fontSize: "1.4rem", margin: "0 0 12px" }}>Link Unavailable</h2>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, lineHeight: 1.7 }}>{errorMsg}</p>
          <a href="/" style={{ display: "inline-block", marginTop: 20, color: "#c8aa5a", fontSize: 13 }}>← Back to sign in</a>
        </div>
      </div>
    </div>
  );

  if (status === "done") return (
    <div style={page}>
      <div style={card}>
        <Logo />
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 60, height: 60, borderRadius: "50%", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
            <CheckCircle2 size={28} style={{ color: "#22c55e" }} />
          </div>
          <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", color: "#fff", fontWeight: 300, fontSize: "1.6rem", margin: "0 0 12px" }}>Password Updated</h2>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, lineHeight: 1.7, marginBottom: 28 }}>
            Your password has been reset. Sign in with your new credentials.
          </p>
          <a href="/" style={{ ...goldBtn, textDecoration: "none", display: "inline-flex", padding: "13px 32px", width: "auto" }}>
            Sign In <ChevronRight size={16} />
          </a>
        </div>
      </div>
    </div>
  );

  return (
    <div style={page}>
      <div style={card}>
        <Logo />
        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", color: "#fff", fontWeight: 300, fontSize: "1.5rem", margin: "0 0 6px" }}>
          Reset Password
        </h2>
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>
          {agent?.email}
        </p>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={lbl}><Lock size={9} style={{ display: "inline", marginRight: 4 }} />New Password</label>
            <div style={{ position: "relative" }}>
              <input
                type={showPw ? "text" : "password"}
                style={{ ...inp, paddingRight: 42 }}
                value={pw} onChange={e => setPw(e.target.value)}
                placeholder="Minimum 8 characters" autoFocus
              />
              <button type="button" onClick={() => setShowPw(v => !v)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.3)", padding: 0 }}>
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {pw.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <div style={{ flex: 1, height: 3, borderRadius: 99, background: "rgba(255,255,255,0.08)" }}>
                  <div style={{ height: "100%", borderRadius: 99, width: `${(pwStr.score / 5) * 100}%`, background: pwStr.color, transition: "width 0.3s" }} />
                </div>
                <span style={{ fontSize: 11, color: pwStr.color, minWidth: 40 }}>{pwStr.label}</span>
              </div>
            )}
          </div>

          <div>
            <label style={lbl}>Confirm Password</label>
            <input
              type={showPw ? "text" : "password"}
              style={{ ...inp, borderColor: pw2 && pw !== pw2 ? "rgba(239,68,68,0.5)" : "rgba(200,170,90,0.2)" }}
              value={pw2} onChange={e => setPw2(e.target.value)}
              placeholder="Re-enter your password"
            />
            {pw2 && pw !== pw2 && <p style={{ color: "#ef4444", fontSize: 11, marginTop: 6 }}>Passwords don't match</p>}
          </div>

          {errorMsg && <p style={{ color: "#ef4444", fontSize: 12 }}>{errorMsg}</p>}

          <button type="submit" style={{ ...goldBtn, opacity: valid && !saving ? 1 : 0.45, marginTop: 4 }} disabled={!valid || saving}>
            {saving ? <><Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> Updating…</> : "Set New Password"}
          </button>
        </form>

        <p style={{ textAlign: "center", marginTop: 16 }}>
          <a href="/" style={{ color: "rgba(255,255,255,0.25)", fontSize: 12 }}>← Back to sign in</a>
        </p>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
