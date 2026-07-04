/**
 * AccountSetupPage — shown when an agent clicks their invitation link.
 * Route: /#/setup/:token
 * The agent sets their password, phone, brokerage, home address, and optional headshot.
 */
import { useState, useRef, useEffect } from "react";
import { useRoute } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import {
  Lock, Eye, EyeOff, Phone, Building2, Home, Camera,
  CheckCircle2, AlertTriangle, ChevronRight, Loader2,
} from "lucide-react";

// ─── Styles ───────────────────────────────────────────────────────────────────
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
  boxShadow: "0 24px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(200,170,90,0.05)",
  padding: "32px 24px 28px",
};
const lbl: React.CSSProperties = {
  display: "block", fontSize: 10, letterSpacing: "0.18em",
  textTransform: "uppercase", color: "rgba(200,170,90,0.55)",
  marginBottom: 6, fontWeight: 600,
};
const inp: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(200,170,90,0.2)",
  padding: "11px 14px", borderRadius: 8,
  fontFamily: "'Switzer','Inter',sans-serif", fontSize: 14,
  color: "#fff", outline: "none", boxSizing: "border-box",
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
const fieldWrap: React.CSSProperties = { marginBottom: 16 };

// ─── Password strength ────────────────────────────────────────────────────────
function strength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8)  score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { score, label: "Weak",   color: "#ef4444" };
  if (score <= 2) return { score, label: "Fair",   color: "#f59e0b" };
  if (score <= 3) return { score, label: "Good",   color: "#22c55e" };
  return             { score, label: "Strong", color: "#4ade80" };
}

// ─── Logo ─────────────────────────────────────────────────────────────────────
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

// ─── Step indicator ───────────────────────────────────────────────────────────
function Steps({ current }: { current: number }) {
  const steps = ["Security", "Profile", "Done"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 28 }}>
      {steps.map((s, i) => (
        <div key={s} style={{ display: "flex", alignItems: "center", flex: 1 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%",
              background: i < current ? "#c8aa5a" : i === current ? "rgba(200,170,90,0.15)" : "rgba(255,255,255,0.05)",
              border: i === current ? "2px solid #c8aa5a" : i < current ? "none" : "1px solid rgba(255,255,255,0.1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700,
              color: i < current ? "#080808" : i === current ? "#c8aa5a" : "rgba(255,255,255,0.25)",
            }}>
              {i < current ? <CheckCircle2 size={14} /> : i + 1}
            </div>
            <span style={{ fontSize: 9, letterSpacing: "0.1em", color: i === current ? "#c8aa5a" : "rgba(255,255,255,0.25)", marginTop: 4 }}>
              {s}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div style={{ flex: 1, height: 1, background: i < current ? "rgba(200,170,90,0.5)" : "rgba(255,255,255,0.08)", marginBottom: 18 }} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function AccountSetupPage() {
  const [, params] = useRoute("/setup/:token");
  const token = params?.token ?? "";

  const [status, setStatus] = useState<"loading" | "ready" | "invalid" | "done">("loading");
  const [agent, setAgent] = useState<{ id: number; name: string; email: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [step, setStep] = useState(0); // 0 = security, 1 = profile

  // Step 0 fields
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);

  // Step 1 fields
  const [phone, setPhone]           = useState("");
  const [brokerage, setBrokerage]   = useState("");
  const [address, setAddress]       = useState("");
  const [headshotB64, setHeadshotB64] = useState("");
  const [headshotPreview, setHeadshotPreview] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);

  // Validate token on mount
  useEffect(() => {
    if (!token) { setStatus("invalid"); setErrorMsg("No setup token found."); return; }
    apiRequest("GET", `/api/agents/setup/${token}`)
      .then(async r => {
        if (!r.ok) { const b = await r.json(); throw new Error(b.error || "Invalid link"); }
        return r.json();
      })
      .then(data => { setAgent(data); setStatus("ready"); })
      .catch(e => { setErrorMsg(e.message); setStatus("invalid"); });
  }, [token]);

  const pwStr = strength(pw);
  const step0Valid = pw.length >= 8 && pw === pw2;

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Convert HEIC/HEIF (iPhone native format) to JPEG before reading
    let processedFile: File | Blob = file;
    if (file.type === "image/heic" || file.type === "image/heif" || file.name.toLowerCase().endsWith(".heic") || file.name.toLowerCase().endsWith(".heif")) {
      try {
        const heic2any = (await import("heic2any")).default;
        const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.88 });
        processedFile = Array.isArray(converted) ? converted[0] : converted;
      } catch {
        alert("Could not convert iPhone photo. Please export as JPEG from your Photos app and try again.");
        return;
      }
    }

    const reader = new FileReader();
    reader.onload = ev => {
      const result = ev.target?.result as string;
      setHeadshotB64(result);
      setHeadshotPreview(result);
    };
    reader.readAsDataURL(processedFile);
  }

  async function finish() {
    setSaving(true);
    try {
      const r = await apiRequest("POST", `/api/agents/setup/${token}`, {
        password: pw,
        phone,
        brokerage,
        homeAddress: address,
        headshotUrl: headshotB64,
      });
      if (!r.ok) {
        const b = await r.json();
        throw new Error(b.error || "Setup failed");
      }
      setStatus("done");
    } catch (e: any) {
      setErrorMsg(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Render states ──────────────────────────────────────────────────────────
  if (status === "loading") {
    return (
      <div style={page}>
        <Logo />
        <div style={{ color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
          <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
          Verifying your invitation…
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div style={page}>
        <div style={card}>
          <Logo />
          <div style={{ textAlign: "center" }}>
            <AlertTriangle size={36} style={{ color: "#ef4444", marginBottom: 16 }} />
            <h2 style={{ color: "#fff", fontWeight: 300, fontSize: "1.4rem", margin: "0 0 12px" }}>
              Link Unavailable
            </h2>
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, lineHeight: 1.7 }}>
              {errorMsg || "This setup link is invalid or has expired."}
            </p>
            <p style={{ color: "rgba(200,170,90,0.6)", fontSize: 13, marginTop: 20 }}>
              Contact your admin to resend the invitation.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div style={page}>
        <div style={card}>
          <Logo />
          <div style={{ textAlign: "center" }}>
            <div style={{
              width: 64, height: 64, borderRadius: "50%",
              background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 20px",
            }}>
              <CheckCircle2 size={30} style={{ color: "#22c55e" }} />
            </div>
            <h2 style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              color: "#fff", fontWeight: 300, fontSize: "1.8rem", margin: "0 0 12px",
            }}>
              You're all set, {agent?.name?.split(" ")[0]}.
            </h2>
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, lineHeight: 1.7, marginBottom: 28 }}>
              Your Lead Depot account is ready. Use your email and the password you just created to sign in.
            </p>
            <a href="/" style={{
              ...goldBtn,
              textDecoration: "none", display: "inline-flex",
              padding: "13px 32px", width: "auto",
            }}>
              Go to Sign In <ChevronRight size={16} />
            </a>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 0 — Security ──────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <div style={page}>
        <div style={card}>
          <Logo />
          <Steps current={0} />
          <h2 style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            color: "#fff", fontWeight: 300, fontSize: "1.5rem", margin: "0 0 6px",
          }}>
            Welcome, {agent?.name?.split(" ")[0]}.
          </h2>
          <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>
            Create a secure password for your Lead Depot account.
          </p>

          {/* Email (read-only) */}
          <div style={fieldWrap}>
            <label style={lbl}>Your Email</label>
            <input style={{ ...inp, color: "rgba(255,255,255,0.45)", cursor: "not-allowed" }} value={agent?.email} readOnly />
          </div>

          {/* Password */}
          <div style={fieldWrap}>
            <label style={lbl}>Create Password</label>
            <div style={{ position: "relative" }}>
              <input
                type={showPw ? "text" : "password"}
                style={{ ...inp, paddingRight: 42 }}
                value={pw}
                onChange={e => setPw(e.target.value)}
                placeholder="Minimum 8 characters"
                autoFocus
              />
              <button onClick={() => setShowPw(v => !v)} style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.3)",
                padding: 0,
              }}>
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {pw.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <div style={{ flex: 1, height: 3, borderRadius: 99, background: "rgba(255,255,255,0.08)" }}>
                  <div style={{
                    height: "100%", borderRadius: 99,
                    width: `${(pwStr.score / 5) * 100}%`,
                    background: pwStr.color, transition: "width 0.3s, background 0.3s",
                  }} />
                </div>
                <span style={{ fontSize: 11, color: pwStr.color, minWidth: 40 }}>{pwStr.label}</span>
              </div>
            )}
          </div>

          {/* Confirm */}
          <div style={fieldWrap}>
            <label style={lbl}>Confirm Password</label>
            <input
              type={showPw ? "text" : "password"}
              style={{
                ...inp,
                borderColor: pw2 && pw !== pw2 ? "rgba(239,68,68,0.5)" : "rgba(200,170,90,0.2)",
              }}
              value={pw2}
              onChange={e => setPw2(e.target.value)}
              placeholder="Re-enter your password"
            />
            {pw2 && pw !== pw2 && (
              <p style={{ color: "#ef4444", fontSize: 11, marginTop: 6 }}>Passwords don't match</p>
            )}
          </div>

          <button
            style={{ ...goldBtn, opacity: step0Valid ? 1 : 0.45, marginTop: 8 }}
            disabled={!step0Valid}
            onClick={() => setStep(1)}
          >
            Next — Profile Details <ChevronRight size={16} />
          </button>

          <p style={{ color: "rgba(255,255,255,0.2)", fontSize: 11, textAlign: "center", marginTop: 16, lineHeight: 1.6 }}>
            Use a unique password you don't use elsewhere. You can change it later in your profile settings.
          </p>
        </div>
      </div>
    );
  }

  // ── Step 1 — Profile ───────────────────────────────────────────────────────
  return (
    <div style={page}>
      <div style={card}>
        <Logo />
        <Steps current={1} />
        <h2 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          color: "#fff", fontWeight: 300, fontSize: "1.5rem", margin: "0 0 6px",
        }}>
          Complete Your Profile
        </h2>
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>
          This information helps your team know who you are. All fields are optional — you can update them anytime in Settings.
        </p>

        {/* Headshot */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
          <div
            onClick={() => fileRef.current?.click()}
            style={{
              width: 72, height: 72, borderRadius: "50%",
              background: headshotPreview ? "none" : "rgba(200,170,90,0.08)",
              border: "2px solid rgba(200,170,90,0.25)",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", overflow: "hidden", flexShrink: 0,
              position: "relative",
            }}
          >
            {headshotPreview
              ? <img src={headshotPreview} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="Headshot" />
              : <Camera size={22} style={{ color: "rgba(200,170,90,0.5)" }} />
            }
          </div>
          <div>
            <p style={{ color: "#fff", fontSize: 13, fontWeight: 600, margin: "0 0 4px" }}>Profile Photo</p>
            <button
              onClick={() => fileRef.current?.click()}
              style={{ fontSize: 12, color: "#c8aa5a", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              {headshotPreview ? "Change photo" : "Upload a photo"}
            </button>
            <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, margin: "3px 0 0" }}>JPG, PNG, or iPhone photo</p>
          </div>
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" style={{ display: "none" }} onChange={handlePhoto} />
        </div>

        {/* Phone */}
        <div style={fieldWrap}>
          <label style={lbl}><Phone size={9} style={{ display: "inline", marginRight: 4 }} />Phone Number</label>
          <input
            style={inp} type="tel" value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="(904) 555-0100"
          />
        </div>

        {/* Brokerage */}
        <div style={fieldWrap}>
          <label style={lbl}><Building2 size={9} style={{ display: "inline", marginRight: 4 }} />Brokerage</label>
          <input
            style={inp} value={brokerage}
            onChange={e => setBrokerage(e.target.value)}
            placeholder="Momentum Realty"
          />
        </div>

        {/* Home Address */}
        <div style={fieldWrap}>
          <label style={lbl}><Home size={9} style={{ display: "inline", marginRight: 4 }} />Home Address</label>
          <input
            style={inp} value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="123 Atlantic Ave, Fernandina Beach, FL 32034"
          />
        </div>

        {errorMsg && (
          <p style={{ color: "#ef4444", fontSize: 12, marginBottom: 12 }}>{errorMsg}</p>
        )}

        <button
          style={{ ...goldBtn, opacity: saving ? 0.6 : 1, marginTop: 4 }}
          disabled={saving}
          onClick={finish}
        >
          {saving ? <><Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> Finishing up…</> : "Complete Setup"}
        </button>

        <button
          onClick={() => setStep(0)}
          style={{ width: "100%", marginTop: 12, background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.3)", fontSize: 12 }}
        >
          ← Back to password
        </button>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
