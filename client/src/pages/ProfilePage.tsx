import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { soundsEnabled, setSoundsEnabled, playSound } from "@/lib/sounds";
import {
  User, Mail, Phone, Lock, Home, Building2, Trash2, MapPin,
  Camera, ChevronLeft, Check, AlertTriangle, Eye, EyeOff, Volume2, PlayCircle, Sparkles,
} from "lucide-react";

// v14.9 — Static changelog. Curated by hand each release. Keeps the last 5
// entries visible to agents so they see the app improving under them. Newest
// at the top. Keep entries short — one line, agent-facing plain English.
const CHANGELOG: { version: string; date: string; note: string }[] = [
  { version: "v15.3",    date: "Jul 11", note: "Bucket 3 closed: real-time “live now” dial indicator (green/gray, no fake counts), optimal call-time heat meter (Hot/Warm/Cool/Cold sourced from MIT and industry data), intent badges on every lead + admin filter + daily digest breakdown, and FUB Seller/Buyer/Buy&Sell tag automation." },
  { version: "v15.2",    date: "Jul 11", note: "Certify test infrastructure now accepts any version number — the nightly health check was still hardcoded to v14.x and fired a false alarm after the v15 rebase." },
  { version: "v15.1",    date: "Jul 10", note: "Tutorial cleanup: the ‘Tap Appt Set’ callout now sits below the grid pointing up, so it no longer overlaps the Not Interested tile in Chapter 6." },
  { version: "v15.0",    date: "Jul 10", note: "Tutorial now matches the real dial screen: the 3\u00d73 outcome grid you see under every lead is what the tutorial teaches. Also fixed tutorial layout on iPhone and added breathing room under the outcome buttons." },
  { version: "v14.9",    date: "Jul 10", note: "Replay Tutorial now works for admins. \u201CDialing now\u201D pill hides outside 8am\u20138pm ET. What\u2019s New card added." },
  { version: "v14.81.3", date: "Jul 10", note: "Fixed the \u201Cdatabase locked\u201D bug that blocked deactivating agents." },
  { version: "v14.81",   date: "Jul 10", note: "Onboarding: new agents fill their profile + walk through a 7-chapter tutorial before hitting Dial." },
  { version: "v14.80",   date: "Jul 10", note: "Opt-in sound effects toggle (default off). Live \u201Cdialing now\u201D pill added." },
  { version: "v14.74",   date: "Jul 09", note: "Unified LandVoice + BatchLeads CSV importer. Supports all three LandVoice export shapes." },
];

const COUNTIES = ["Nassau", "Duval", "St Johns"] as const;

const lbl: React.CSSProperties = {
  display: "block", fontSize: 10, letterSpacing: "0.18em",
  textTransform: "uppercase", color: "rgba(200,170,90,0.55)",
  marginBottom: 6, fontWeight: 600,
};
const inp: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.06)",
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
  fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase",
  color: "#080808", cursor: "pointer",
  boxShadow: "0 4px 16px rgba(200,170,90,0.25)",
};
const sectionCard: React.CSSProperties = {
  background: "linear-gradient(135deg,#0f0f0f 0%,#0a0a0a 100%)",
  border: "1px solid rgba(200,170,90,0.12)",
  borderRadius: 14, padding: "20px 18px", marginBottom: 16,
};

interface AgentProfile {
  id: number;
  name: string;
  email: string;
  phone: string;
  brokerage: string;
  homeAddress: string;
  headshotUrl: string;
  homeCounty: string;
  role: string;
}

export default function ProfilePage({ onBack }: { onBack: () => void }) {
  const { user, logout, setHomeCounty, setTutorialCompleted, refreshUser } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  // v14.81 — Rewatch tutorial
  const [rewatching, setRewatching] = useState(false);

  // Profile fields — initialised from user context (extended data fetched below)
  const [profile, setProfile] = useState<AgentProfile>({
    id: user?.id ?? 0,
    name: user?.name ?? "",
    email: user?.email ?? "",
    phone: "",
    brokerage: "",
    homeAddress: "",
    headshotUrl: "",
    homeCounty: user?.homeCounty ?? "",
    role: user?.role ?? "agent",
  });
  const [savingCounty, setSavingCounty] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Password
  const [currentPw, setCurrentPw]   = useState("");
  const [newPw, setNewPw]           = useState("");
  const [confirmPw, setConfirmPw]   = useState("");
  const [showPw, setShowPw]         = useState(false);
  const [pwSaving, setPwSaving]     = useState(false);

  // Delete
  const [deletePw, setDeletePw]     = useState("");
  const [deleting, setDeleting]     = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Upload state
  const [uploading, setUploading]   = useState(false);

  // v14.81 — "Replay tutorial" from Profile. Flags sessionStorage BEFORE
  // reset-tutorial so TutorialFlow (mounted fresh by App.tsx once
  // tutorialCompletedAt flips to null) reads isFirstTime=false and shows
  // the Skip button on Chapters 2–7.
  const handleReplayTutorial = async () => {
    if (rewatching) return;
    setRewatching(true);
    try {
      sessionStorage.setItem("ld_tutorial_rewatch", "true");
    } catch { /* private browsing — rewatch will behave like first-time, acceptable fallback */ }
    try {
      await apiRequest("POST", "/api/agent/reset-tutorial", {});
      setTutorialCompleted(null);
      await refreshUser();
    } catch {
      toast({ title: "Could not start tutorial replay. Try again.", variant: "destructive" });
      try { sessionStorage.removeItem("ld_tutorial_rewatch"); } catch {}
    } finally {
      setRewatching(false);
    }
  };

  // v14.80 — Opt-in sound effects toggle (default OFF)
  const [soundsOn, setSoundsOn] = useState(false);
  useEffect(() => { setSoundsOn(soundsEnabled()); }, []);
  const handleToggleSounds = () => {
    const next = !soundsOn;
    setSoundsOn(next);
    setSoundsEnabled(next);
    if (next) playSound("chime");
  };

  // Fetch full profile on mount — v14.73: was useState(fn) which fired
  // synchronously once per render cycle; converted to a proper useEffect.
  useEffect(() => {
    if (!user?.id) { setProfileLoaded(true); return; }
    fetch(`/api/me/${user.id}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        if (d.agent) {
          setProfile(p => ({
            ...p,
            name:        d.agent.name        ?? p.name,
            email:       d.agent.email       ?? p.email,
            phone:       d.agent.phone       ?? "",
            brokerage:   d.agent.brokerage   ?? "",
            homeAddress: d.agent.homeAddress ?? d.agent.home_address ?? "",
            headshotUrl: d.agent.headshotUrl ?? d.agent.headshot_url ?? "",
            homeCounty:  d.agent.homeCounty  ?? d.agent.home_county ?? "",
            role:        d.agent.role        ?? p.role,
          }));
        }
        setProfileLoaded(true);
      })
      .catch(() => setProfileLoaded(true));
  }, [user?.id]);

  // ── Save profile ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!profile.name.trim() || !profile.email.trim()) {
      toast({ title: "Name and email are required", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      const res = await apiRequest("PATCH", `/api/agents/${user?.id}/profile`, {
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        brokerage: profile.brokerage,
        homeAddress: profile.homeAddress,
      });
      if (!res.ok) {
        const d = await res.json();
        toast({ title: d.error || "Failed to save", variant: "destructive" });
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      toast({ title: "Profile updated" });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // ── Upload headshot ───────────────────────────────────────────────────────
  const handleHeadshot = async (file: File) => {
    if (!file.type.startsWith("image/") && !file.name.toLowerCase().match(/\.(heic|heif)$/)) {
      toast({ title: "Please select an image file", variant: "destructive" }); return;
    }
    setUploading(true);
    try {
      // Convert HEIC/HEIF (iPhone native format) to JPEG before uploading
      let processedFile: File | Blob = file;
      if (file.type === "image/heic" || file.type === "image/heif" || file.name.toLowerCase().match(/\.(heic|heif)$/)) {
        try {
          const heic2any = (await import("heic2any")).default;
          const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.88 });
          processedFile = Array.isArray(converted) ? converted[0] : converted;
        } catch {
          toast({ title: "Could not convert iPhone photo. Please export as JPEG from your Photos app.", variant: "destructive" });
          setUploading(false);
          return;
        }
      }

      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target?.result as string;
        // dataUrl = "data:image/jpeg;base64,..."
        const [meta, imageData] = dataUrl.split(",");
        const mimeType = meta.match(/:(.*?);/)?.[1] ?? "image/jpeg";
        const res = await apiRequest("POST", `/api/agents/${user?.id}/headshot`, { imageData, mimeType });
        if (res.ok) {
          const d = await res.json();
          setProfile(p => ({ ...p, headshotUrl: d.headshotUrl }));
          toast({ title: "Photo updated" });
        } else {
          const d = await res.json();
          toast({ title: d.error || "Upload failed", variant: "destructive" });
        }
        setUploading(false);
      };
      reader.readAsDataURL(processedFile);
    } catch {
      toast({ title: "Upload failed", variant: "destructive" });
      setUploading(false);
    }
  };

  // ── Change password ───────────────────────────────────────────────────────
  const handlePasswordChange = async () => {
    if (!currentPw || !newPw || !confirmPw) {
      toast({ title: "All password fields required", variant: "destructive" }); return;
    }
    if (newPw !== confirmPw) {
      toast({ title: "New passwords don't match", variant: "destructive" }); return;
    }
    if (newPw.length < 6) {
      toast({ title: "Password must be at least 6 characters", variant: "destructive" }); return;
    }
    setPwSaving(true);
    try {
      const res = await apiRequest("PATCH", `/api/agents/${user?.id}/password`, {
        currentPassword: currentPw, newPassword: newPw,
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error || "Password change failed", variant: "destructive" }); return;
      }
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      toast({ title: "Password changed successfully" });
    } catch {
      toast({ title: "Failed to change password", variant: "destructive" });
    } finally {
      setPwSaving(false);
    }
  };

  // ── Delete account ────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deletePw) {
      toast({ title: "Enter your password to confirm deletion", variant: "destructive" }); return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/agents/${user?.id}/self`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deletePw }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error || "Deletion failed", variant: "destructive" });
        setDeleting(false);
        return;
      }
      logout();
    } catch {
      toast({ title: "Deletion failed", variant: "destructive" });
      setDeleting(false);
    }
  };

  const initials = profile.name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);

  return (
    <div style={{ minHeight: "100dvh", background: "#080808", display: "flex", flexDirection: "column" }}>
      {/* Ambient glows */}
      <div className="ld-glow" />
      <div className="ld-glow-corner" />

      {/* Header */}
      <header style={{
        position: "sticky", top: 0, zIndex: 20,
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 18px",
        background: "linear-gradient(180deg,rgba(14,12,8,0.99) 0%,rgba(8,8,8,0.97) 100%)",
        backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(200,170,90,0.2)",
        boxShadow: "0 2px 20px rgba(0,0,0,0.5)",
      }}>
        <button onClick={onBack} style={{
          display: "flex", alignItems: "center", gap: 5,
          fontSize: 11, color: "rgba(200,170,90,0.7)",
          background: "none", border: "none", cursor: "pointer",
          letterSpacing: "0.06em",
        }}>
          <ChevronLeft size={14} /> Back
        </button>
        <div style={{ flex: 1 }}>
          <p style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            fontSize: 16, fontWeight: 400, color: "#fff", lineHeight: 1,
            letterSpacing: "0.08em",
          }}>My Profile</p>
        </div>
      </header>

      {/* Scrollable content */}
      <main style={{ flex: 1, overflowY: "auto", padding: "20px 14px 48px" }}>

        {/* ── Avatar / headshot ── */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 28 }}>
          <div
            style={{
              width: 90, height: 90, borderRadius: "50%",
              border: "2px solid rgba(200,170,90,0.4)",
              background: "rgba(200,170,90,0.08)",
              display: "flex", alignItems: "center", justifyContent: "center",
              position: "relative", cursor: "pointer", overflow: "hidden",
              boxShadow: "0 0 30px rgba(200,170,90,0.15)",
            }}
            onClick={() => fileRef.current?.click()}
          >
            {profile.headshotUrl ? (
              <img src={profile.headshotUrl} alt="headshot" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span style={{ fontSize: 28, fontWeight: 600, color: "#c8aa5a", fontFamily: "'Cormorant Garamond','Georgia',serif" }}>
                {initials || <User size={28} />}
              </span>
            )}
            {/* Upload overlay */}
            <div style={{
              position: "absolute", inset: 0, borderRadius: "50%",
              background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
              opacity: 0, transition: "opacity 0.2s",
            }}
              onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
              onMouseLeave={e => (e.currentTarget.style.opacity = "0")}
            >
              <Camera size={20} style={{ color: "#c8aa5a" }} />
            </div>
          </div>
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleHeadshot(f); e.target.value = ""; }}
          />
          <button onClick={() => fileRef.current?.click()}
            style={{
              marginTop: 10, fontSize: 11, color: "rgba(200,170,90,0.65)",
              background: "none", border: "none", cursor: "pointer",
              letterSpacing: "0.1em", textTransform: "uppercase",
              display: "flex", alignItems: "center", gap: 4,
            }}>
            <Camera size={11} /> {uploading ? "Uploading…" : "Change Photo"}
          </button>
          <p style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
            {profile.role === "admin" ? "Admin" : profile.role === "recruiter" ? "Recruiter" : "Agent"} · {profile.email}
          </p>
        </div>

        {/* ── Profile info ── */}
        <div style={sectionCard}>
          <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(200,170,90,0.6)", marginBottom: 16, fontWeight: 600 }}>
            Personal Info
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={lbl}><User size={9} style={{ display: "inline", marginRight: 5 }} />Full Name</label>
              <input style={inp} value={profile.name} onChange={e => setProfile(p => ({ ...p, name: e.target.value }))} placeholder="Your full name" />
            </div>
            <div>
              <label style={lbl}><Mail size={9} style={{ display: "inline", marginRight: 5 }} />Email</label>
              <input style={inp} type="email" value={profile.email} onChange={e => setProfile(p => ({ ...p, email: e.target.value }))} placeholder="your@email.com" />
            </div>
            <div>
              <label style={lbl}><Phone size={9} style={{ display: "inline", marginRight: 5 }} />Phone</label>
              <input style={inp} type="tel" value={profile.phone} onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))} placeholder="(904) 555-0100" />
            </div>
            <div>
              <label style={lbl}><Building2 size={9} style={{ display: "inline", marginRight: 5 }} />Brokerage</label>
              <input style={inp} value={profile.brokerage} onChange={e => setProfile(p => ({ ...p, brokerage: e.target.value }))} placeholder="e.g. Momentum Realty" />
            </div>
            <div>
              <label style={lbl}><Home size={9} style={{ display: "inline", marginRight: 5 }} />Home Address</label>
              <input style={inp} value={profile.homeAddress} onChange={e => setProfile(p => ({ ...p, homeAddress: e.target.value }))} placeholder="123 Main St, Fernandina Beach, FL 32034" />
            </div>
            {profile.role === "agent" && (
              <div>
                <label style={lbl}><MapPin size={9} style={{ display: "inline", marginRight: 5 }} />Home County (Primary Lead Territory)</label>
                <select
                  style={inp}
                  value={profile.homeCounty}
                  disabled={savingCounty}
                  onChange={async (e) => {
                    const county = e.target.value;
                    if (!county || !COUNTIES.includes(county as any)) return;
                    const prev = profile.homeCounty;
                    setProfile(p => ({ ...p, homeCounty: county }));
                    setSavingCounty(true);
                    try {
                      const res = await apiRequest("PATCH", `/api/agents/${user?.id}/home-county`, { homeCounty: county });
                      if (!res.ok) throw new Error("failed");
                      setHomeCounty(county);
                      // v14.13 — Bug A fix: invalidate lead queries so the agent's next-lead
                      // pull and pipeline reflect the new territory immediately (no manual refresh).
                      qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
                      qc.invalidateQueries({ queryKey: [`/api/leads/my-count/${user?.id}`] });
                      // v14.38 — my-pipeline endpoint removed. KIT lives in FUB.
                      qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
                      toast({ title: `Home county set to ${county}`, description: "Your lead queue has been refreshed." });
                    } catch {
                      setProfile(p => ({ ...p, homeCounty: prev }));
                      toast({ title: "Could not update home county", variant: "destructive" });
                    } finally {
                      setSavingCounty(false);
                    }
                  }}
                >
                  <option value="" disabled>Select your county</option>
                  {COUNTIES.map(c => (
                    <option key={c} value={c} style={{ background: "#0a0a0a" }}>{c}</option>
                  ))}
                </select>
                <div style={{ fontSize: 10, color: "rgba(200,170,90,0.55)", marginTop: 6, letterSpacing: "0.05em" }}>
                  You get leads in this county first. Overflow from other counties only when yours runs dry.
                </div>
              </div>
            )}
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              ...goldBtn,
              marginTop: 20,
              background: saved
                ? "linear-gradient(135deg,#22c55e 0%,#16a34a 100%)"
                : saving
                  ? "rgba(200,170,90,0.3)"
                  : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saved ? <><Check size={14} /> Saved</> : saving ? "Saving…" : "Save Profile"}
          </button>
        </div>

        {/* ── Change password ── */}
        <div style={sectionCard}>
          <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(200,170,90,0.6)", marginBottom: 16, fontWeight: 600 }}>
            Change Password
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ position: "relative" }}>
              <label style={lbl}><Lock size={9} style={{ display: "inline", marginRight: 5 }} />Current Password</label>
              <input style={inp} type={showPw ? "text" : "password"} value={currentPw} onChange={e => setCurrentPw(e.target.value)} placeholder="Enter current password" />
            </div>
            <div>
              <label style={lbl}>New Password</label>
              <div style={{ position: "relative" }}>
                <input style={{ ...inp, paddingRight: 42 }} type={showPw ? "text" : "password"} value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="At least 6 characters" />
                <button onClick={() => setShowPw(s => !s)} style={{
                  position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.3)",
                }}>
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div>
              <label style={lbl}>Confirm New Password</label>
              <input style={{
                ...inp,
                borderColor: confirmPw && newPw !== confirmPw ? "rgba(239,68,68,0.5)" : "rgba(200,170,90,0.2)",
              }} type={showPw ? "text" : "password"} value={confirmPw} onChange={e => setConfirmPw(e.target.value)} placeholder="Repeat new password" />
            </div>
          </div>
          <button
            onClick={handlePasswordChange}
            disabled={pwSaving}
            style={{ ...goldBtn, marginTop: 16, opacity: pwSaving ? 0.5 : 1, cursor: pwSaving ? "not-allowed" : "pointer" }}
          >
            <Lock size={13} /> {pwSaving ? "Changing…" : "Change Password"}
          </button>
        </div>

        {/* ── Preferences (v14.80) ── */}
        <div style={sectionCard}>
          <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(200,170,90,0.6)", marginBottom: 16, fontWeight: 600 }}>
            Preferences
          </p>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%",
                background: "rgba(200,170,90,0.1)", border: "1px solid rgba(200,170,90,0.25)",
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>
                <Volume2 size={14} style={{ color: "#c8aa5a" }} />
              </div>
              <div>
                <p style={{ fontSize: 13, color: "#fff", fontWeight: 500 }}>Sound effects</p>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 1 }}>
                  Chime on Appt Set, tick on Keep in Touch
                </p>
              </div>
            </div>
            <button
              onClick={handleToggleSounds}
              data-testid="toggle-sound-effects"
              role="switch"
              aria-checked={soundsOn}
              style={{
                width: 44, height: 26, borderRadius: 13, position: "relative",
                border: `1px solid ${soundsOn ? "rgba(34,197,94,0.5)" : "rgba(255,255,255,0.15)"}`,
                background: soundsOn ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.06)",
                cursor: "pointer", flexShrink: 0, transition: "all 0.2s ease",
              }}
            >
              <span style={{
                position: "absolute", top: 2, left: soundsOn ? 20 : 2,
                width: 20, height: 20, borderRadius: "50%",
                background: soundsOn ? "#86efac" : "rgba(255,255,255,0.5)",
                transition: "left 0.2s ease",
                boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              }} />
            </button>
          </div>
        </div>

        {/* ── Onboarding (v14.81) ── */}
        <div style={sectionCard}>
          <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(200,170,90,0.6)", marginBottom: 16, fontWeight: 600 }}>
            Onboarding
          </p>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%",
                background: "rgba(200,170,90,0.1)", border: "1px solid rgba(200,170,90,0.25)",
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>
                <PlayCircle size={14} style={{ color: "#c8aa5a" }} />
              </div>
              <div>
                <p style={{ fontSize: 13, color: "#fff", fontWeight: 500 }}>Tutorial</p>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 1 }}>
                  Watch the onboarding walkthrough again
                </p>
              </div>
            </div>
          </div>
          <button
            onClick={handleReplayTutorial}
            disabled={rewatching}
            data-testid="replay-tutorial-button"
            style={{
              ...goldBtn,
              background: rewatching ? "rgba(200,170,90,0.25)" : goldBtn.background,
              cursor: rewatching ? "not-allowed" : "pointer",
            }}
          >
            <PlayCircle size={13} /> {rewatching ? "Loading…" : "Replay Tutorial"}
          </button>
        </div>

        {/* ── What's New (v14.9) ── */}
        <div style={sectionCard} data-testid="whats-new-card">
          <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(200,170,90,0.75)", marginBottom: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkles size={12} /> What's New
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {CHANGELOG.map((entry) => (
              <div key={entry.version} style={{
                display: "flex",
                gap: 12,
                paddingBottom: 10,
                borderBottom: "1px solid rgba(255,255,255,0.05)",
              }}>
                <div style={{
                  minWidth: 68,
                  fontSize: 11,
                  color: "rgba(200,170,90,0.85)",
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {entry.version}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", lineHeight: 1.55, margin: 0 }}>
                    {entry.note}
                  </p>
                  <p style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 3, marginBottom: 0 }}>
                    {entry.date}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Delete account ── */}
        <div style={{
          ...sectionCard,
          border: "1px solid rgba(239,68,68,0.15)",
          background: "rgba(239,68,68,0.03)",
        }}>
          <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(239,68,68,0.6)", marginBottom: 8, fontWeight: 600 }}>
            Delete Account
          </p>
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 14, lineHeight: 1.6 }}>
            Permanently removes your account from Lead Depot. Your active leads will be redistributed. This cannot be undone.
          </p>

          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: "100%", padding: "11px",
                background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
                borderRadius: 8, color: "#f87171", fontSize: 12, fontWeight: 600,
                letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
              }}
            >
              <Trash2 size={13} /> Delete My Account
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "10px 12px", borderRadius: 8,
                background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
              }}>
                <AlertTriangle size={13} style={{ color: "#f87171", flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: "#f87171" }}>Enter your password to confirm permanent deletion</span>
              </div>
              <input
                style={{ ...inp, borderColor: "rgba(239,68,68,0.3)" }}
                type="password"
                value={deletePw}
                onChange={e => setDeletePw(e.target.value)}
                placeholder="Your password"
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => { setConfirmDelete(false); setDeletePw(""); }}
                  style={{
                    flex: 1, padding: "11px", borderRadius: 8,
                    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                    color: "rgba(255,255,255,0.5)", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  style={{
                    flex: 1, padding: "11px", borderRadius: 8,
                    background: deleting ? "rgba(239,68,68,0.2)" : "rgba(239,68,68,0.8)",
                    border: "none", color: "#fff", fontSize: 12,
                    fontWeight: 700, cursor: deleting ? "not-allowed" : "pointer",
                    letterSpacing: "0.08em", textTransform: "uppercase",
                  }}
                >
                  {deleting ? "Deleting…" : "Confirm Delete"}
                </button>
              </div>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
