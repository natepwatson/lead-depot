/**
 * HeadshotGate — v11.39
 * Blocks app access until the user uploads a headshot photo.
 * Applies to ALL users (agents and admins) who don't have a headshot on file.
 * No back button, no skip. Must upload to continue.
 */
import { useState, useRef } from "react";
import { Camera, CheckCircle2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface HeadshotGateProps {
  userId: number;
  userName: string;
  onComplete: (headshotUrl: string) => void;
}

export default function HeadshotGate({ userId, userName, onComplete }: HeadshotGateProps) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/") && !file.name.toLowerCase().match(/\.(heic|heif)$/)) {
      toast({ title: "Please select an image file", variant: "destructive" }); return;
    }

    // Convert HEIC/HEIF (iPhone native format) to JPEG
    let processedFile: File | Blob = file;
    if (file.type === "image/heic" || file.type === "image/heif" || file.name.toLowerCase().match(/\.(heic|heif)$/)) {
      try {
        const heic2any = (await import("heic2any")).default;
        const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.88 });
        processedFile = Array.isArray(converted) ? converted[0] : converted;
      } catch {
        toast({ title: "Could not convert iPhone photo. Please export as JPEG from your Photos app.", variant: "destructive" });
        return;
      }
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      setPreview(e.target?.result as string);
    };
    reader.readAsDataURL(processedFile);
  };

  const handleUpload = async () => {
    if (!preview) return;
    setUploading(true);
    try {
      const [meta, imageData] = preview.split(",");
      const mimeType = meta.match(/:(.*?);/)?.[1] ?? "image/jpeg";
      const res = await apiRequest("POST", `/api/agents/${userId}/headshot`, { imageData, mimeType });
      if (!res.ok) {
        const d = await res.json();
        toast({ title: d.error || "Upload failed", variant: "destructive" });
        return;
      }
      const d = await res.json();
      setDone(true);
      setTimeout(() => onComplete(d.headshotUrl), 1200);
    } catch {
      toast({ title: "Upload failed. Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const firstName = userName.split(" ")[0];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "linear-gradient(160deg, #0a0a0a 0%, #0f0d08 100%)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: "24px 20px",
      fontFamily: "'Switzer','Inter',sans-serif",
    }}>
      {/* Ambient glow */}
      <div style={{
        position: "absolute", top: "30%", left: "50%", transform: "translate(-50%,-50%)",
        width: 400, height: 400, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(200,170,90,0.06) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      {/* Logo */}
      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <svg width="40" height="40" viewBox="0 0 36 36" fill="none" style={{ margin: "0 auto 10px", display: "block" }}>
          <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.6"/>
          <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
          <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.4"/>
        </svg>
        <p style={{ color: "rgba(200,170,90,0.6)", letterSpacing: "0.2em", fontSize: 10, textTransform: "uppercase", margin: 0 }}>
          Brothers Group · Momentum Realty
        </p>
      </div>

      <div style={{
        width: "100%", maxWidth: 380,
        background: "rgba(15,13,8,0.96)",
        border: "1px solid rgba(200,170,90,0.2)",
        borderRadius: 18, padding: "32px 24px 28px",
        boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
        textAlign: "center",
      }}>
        {done ? (
          <>
            <div style={{
              width: 64, height: 64, borderRadius: "50%",
              background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <CheckCircle2 size={28} style={{ color: "#22c55e" }} />
            </div>
            <h2 style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              color: "#fff", fontWeight: 300, fontSize: "1.6rem", margin: "0 0 8px",
            }}>
              You're all set, {firstName}!
            </h2>
            <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>
              Heading to your dashboard…
            </p>
          </>
        ) : (
          <>
            <h2 style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              color: "#fff", fontWeight: 300, fontSize: "1.5rem", margin: "0 0 8px",
            }}>
              One last step, {firstName}.
            </h2>
            <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, lineHeight: 1.7, marginBottom: 28 }}>
              A professional headshot is required to receive leads and appear on the leaderboard. Upload yours to get started.
            </p>

            {/* Photo picker */}
            <div
              onClick={() => fileRef.current?.click()}
              style={{
                width: 100, height: 100, borderRadius: "50%",
                border: preview ? "2px solid rgba(200,170,90,0.5)" : "2px dashed rgba(200,170,90,0.3)",
                background: preview ? "transparent" : "rgba(200,170,90,0.04)",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", margin: "0 auto 16px",
                overflow: "hidden", transition: "border-color 0.2s",
                position: "relative",
              }}
            >
              {preview ? (
                <>
                  <img src={preview} alt="preview" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  <div style={{
                    position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    opacity: 0, transition: "opacity 0.2s",
                  }}
                    onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={e => (e.currentTarget.style.opacity = "0")}
                  >
                    <Camera size={22} style={{ color: "#c8aa5a" }} />
                  </div>
                </>
              ) : (
                <Camera size={28} style={{ color: "rgba(200,170,90,0.4)" }} />
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.heic,.heif"
              capture="user"
              style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
            />

            <button
              onClick={() => fileRef.current?.click()}
              style={{
                fontSize: 11, color: "rgba(200,170,90,0.6)",
                background: "none", border: "none", cursor: "pointer",
                letterSpacing: "0.1em", textTransform: "uppercase",
                display: "flex", alignItems: "center", gap: 4,
                margin: "0 auto 24px",
              }}
            >
              <Camera size={11} /> {preview ? "Choose Different Photo" : "Choose Photo"}
            </button>
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginBottom: 20 }}>
              Any size · JPEG or PNG · will appear on leaderboard
            </p>

            <button
              onClick={handleUpload}
              disabled={!preview || uploading}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                width: "100%", padding: "13px",
                background: !preview || uploading
                  ? "rgba(200,170,90,0.2)"
                  : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                border: "none", borderRadius: 8,
                fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
                color: !preview || uploading ? "rgba(255,255,255,0.3)" : "#080808",
                cursor: !preview || uploading ? "not-allowed" : "pointer",
                boxShadow: preview && !uploading ? "0 4px 16px rgba(200,170,90,0.25)" : "none",
                transition: "all 0.2s",
              }}
            >
              {uploading ? "Uploading…" : "Upload & Continue"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
