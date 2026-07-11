/**
 * ProfileGate — v14.81
 * Full-screen, non-dismissible modal-style page shown to any agent whose
 * profile_completed_at is NULL on login. Mirrors HomeCountyGate's shell
 * (fixed, z-index above app chrome) and ProfilePage's form field styling.
 *
 * Required: Full Name, Phone, Brokerage, Home Address, Home County.
 * Optional (strongly encouraged, skippable): Headshot.
 *
 * On save: PATCH /api/agents/:id/profile (existing endpoint) then
 * POST /api/agent/complete-profile, then hand off to the tutorial.
 */
import { useState, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  User, Phone, Building2, Home, MapPin, Camera, Check,
} from "lucide-react";

// Reused from HomeCountyGate.tsx / ProfilePage.tsx county list.
const COUNTIES = [
  { value: "Nassau",   desc: "Yulee, Fernandina Beach, Callahan, Hilliard" },
  { value: "Duval",    desc: "Jacksonville, Jax Beach, Atlantic Beach" },
  { value: "St Johns", desc: "St Augustine, Ponte Vedra, Nocatee, WGV" },
];

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
  width: "100%", padding: "14px",
  background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
  border: "none", borderRadius: 8,
  fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase",
  color: "#080808", cursor: "pointer",
  boxShadow: "0 4px 16px rgba(200,170,90,0.25)",
};

export default function ProfileGate({ onComplete }: { onComplete: () => void }) {
  const { user, setHeadshot, setProfileCompleted } = useAuth();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(user?.name ?? "");
  const [phone, setPhone] = useState("");
  const [brokerage, setBrokerage] = useState("Momentum Realty");
  const [homeAddress, setHomeAddress] = useState("");
  const [homeCounty, setHomeCountyLocal] = useState(user?.homeCounty ?? "");
  const [headshotUrl, setHeadshotUrl] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const canSave = name.trim() && phone.trim() && brokerage.trim() && homeAddress.trim() && homeCounty.trim();

  const initials = (name || user?.name || "").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);

  const handleHeadshot = async (file: File) => {
    if (!file.type.startsWith("image/") && !file.name.toLowerCase().match(/\.(heic|heif)$/)) {
      toast({ title: "Please select an image file", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      let processedFile: File | Blob = file;
      if (file.type === "image/heic" || file.type === "image/heif" || file.name.toLowerCase().match(/\.(heic|heif)$/)) {
        try {
          const heic2any = (await import("heic2any")).default;
          const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.88 });
          processedFile = Array.isArray(converted) ? converted[0] : converted;
        } catch {
          toast({ title: "Could not convert iPhone photo. You can add it later from Profile.", variant: "destructive" });
          setUploading(false);
          return;
        }
      }
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target?.result as string;
        const [meta, imageData] = dataUrl.split(",");
        const mimeType = meta.match(/:(.*?);/)?.[1] ?? "image/jpeg";
        try {
          const res = await apiRequest("POST", `/api/agents/${user?.id}/headshot`, { imageData, mimeType });
          const d = await res.json();
          setHeadshotUrl(d.headshotUrl);
          setHeadshot(d.headshotUrl);
          toast({ title: "Photo added" });
        } catch {
          toast({ title: "Upload failed. You can add it later from Profile.", variant: "destructive" });
        }
        setUploading(false);
      };
      reader.readAsDataURL(processedFile);
    } catch {
      toast({ title: "Upload failed", variant: "destructive" });
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!canSave || !user?.id) return;
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/agents/${user.id}/profile`, {
        name: name.trim(),
        phone: phone.trim(),
        brokerage: brokerage.trim(),
        homeAddress: homeAddress.trim(),
      });

      // Home county uses its own dedicated endpoint (drives lead routing).
      if (homeCounty && homeCounty !== user.homeCounty) {
        try {
          await apiRequest("PATCH", `/api/agents/${user.id}/home-county`, { homeCounty });
        } catch { /* non-fatal — county can be fixed later in Profile */ }
      }

      const completeRes = await apiRequest("POST", "/api/agent/complete-profile", {});
      const d = await completeRes.json();
      setProfileCompleted(d.profileCompletedAt);
      onComplete();
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("profile_incomplete")) {
        toast({ title: "Please fill in all required fields", variant: "destructive" });
      } else {
        toast({ title: "Could not save profile. Try again.", variant: "destructive" });
      }
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9998,
      background: "linear-gradient(160deg, #0a0a0a 0%, #0f0d08 100%)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "flex-start",
      padding: "28px 20px 40px",
      fontFamily: "'Switzer','Inter',sans-serif",
      overflowY: "auto",
    }}>
      {/* Ambient glow */}
      <div style={{
        position: "absolute", top: "20%", left: "50%", transform: "translate(-50%,-50%)",
        width: 420, height: 420, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(200,170,90,0.08) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      {/* Logo */}
      <div style={{ marginBottom: 20, textAlign: "center" }}>
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" style={{ margin: "0 auto 8px", display: "block" }}>
          <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.6"/>
          <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
          <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.4"/>
        </svg>
        <p style={{ color: "rgba(200,170,90,0.6)", letterSpacing: "0.2em", fontSize: 10, textTransform: "uppercase", margin: 0 }}>
          Brothers Group · Momentum Realty
        </p>
      </div>

      <div style={{
        width: "100%", maxWidth: 460,
        background: "rgba(15,13,8,0.96)",
        border: "1px solid rgba(200,170,90,0.2)",
        borderRadius: 18, padding: "28px 22px 26px",
        boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
      }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <h1 style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            color: "#fff", fontWeight: 400, fontSize: "1.7rem", margin: "0 0 8px",
          }}>
            Complete your profile
          </h1>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            Takes 60 seconds. This is what your team + leads see.
          </p>
        </div>

        {/* Headshot */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 22 }}>
          <div
            style={{
              width: 78, height: 78, borderRadius: "50%",
              border: "2px solid rgba(200,170,90,0.4)",
              background: "rgba(200,170,90,0.08)",
              display: "flex", alignItems: "center", justifyContent: "center",
              position: "relative", cursor: "pointer", overflow: "hidden",
              boxShadow: "0 0 30px rgba(200,170,90,0.15)",
            }}
            onClick={() => fileRef.current?.click()}
          >
            {headshotUrl ? (
              <img src={headshotUrl} alt="headshot" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span style={{ fontSize: 24, fontWeight: 600, color: "#c8aa5a", fontFamily: "'Cormorant Garamond','Georgia',serif" }}>
                {initials || <User size={24} />}
              </span>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleHeadshot(f); e.target.value = ""; }}
          />
          <button onClick={() => fileRef.current?.click()}
            style={{
              marginTop: 8, fontSize: 11, color: "rgba(200,170,90,0.65)",
              background: "none", border: "none", cursor: "pointer",
              letterSpacing: "0.1em", textTransform: "uppercase",
              display: "flex", alignItems: "center", gap: 4,
            }}>
            <Camera size={11} /> {uploading ? "Uploading…" : headshotUrl ? "Change Photo" : "Add Headshot (optional)"}
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 22 }}>
          <div>
            <label style={lbl}><User size={9} style={{ display: "inline", marginRight: 5 }} />Full Name *</label>
            <input style={inp} value={name} onChange={e => setName(e.target.value)} placeholder="Your full name" />
          </div>
          <div>
            <label style={lbl}><Phone size={9} style={{ display: "inline", marginRight: 5 }} />Phone *</label>
            <input style={inp} type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(904) 555-0100" />
          </div>
          <div>
            <label style={lbl}><Building2 size={9} style={{ display: "inline", marginRight: 5 }} />Brokerage *</label>
            <input style={inp} value={brokerage} onChange={e => setBrokerage(e.target.value)} placeholder="Momentum Realty" />
          </div>
          <div>
            <label style={lbl}><Home size={9} style={{ display: "inline", marginRight: 5 }} />Home Address *</label>
            <input style={inp} value={homeAddress} onChange={e => setHomeAddress(e.target.value)} placeholder="123 Main St, Fernandina Beach, FL 32034" />
          </div>
          <div>
            <label style={lbl}><MapPin size={9} style={{ display: "inline", marginRight: 5 }} />Home County *</label>
            <select style={inp} value={homeCounty} onChange={e => setHomeCountyLocal(e.target.value)}>
              <option value="" disabled>Select your county</option>
              {COUNTIES.map(c => (
                <option key={c.value} value={c.value} style={{ background: "#0a0a0a" }}>{c.value} County</option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          style={{
            ...goldBtn,
            background: !canSave || saving ? "rgba(200,170,90,0.25)" : goldBtn.background,
            color: !canSave || saving ? "rgba(255,255,255,0.35)" : "#080808",
            cursor: !canSave || saving ? "not-allowed" : "pointer",
            boxShadow: !canSave || saving ? "none" : goldBtn.boxShadow,
          }}
        >
          {saving ? "Saving…" : <><Check size={14} /> Save & Continue</>}
        </button>

        <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", textAlign: "center", marginTop: 14 }}>
          Required fields are marked *. Headshot can be skipped and added later from Profile.
        </p>
      </div>
    </div>
  );
}
