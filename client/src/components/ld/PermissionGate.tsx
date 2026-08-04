// v20.4.7 — Two-stage PermissionGate.
//
// Purpose: on first login and every 90 days, walk the agent through the 4
// permissions Lead Depot actually depends on:
//   1. Location  (Open House logging, Door Knock GPS, territory pins)
//   2. Photos    (Open House selfie, headshot upload)
//   3. Camera    (Open House selfie capture, ID/profile uploads)
//   4. Push      (Prime Time notifier, digest alerts)
//
// Two-stage means we EXPLAIN each permission (context screen) BEFORE we
// trigger the native browser prompt. Studies show a 3-4x accept rate when
// permissions are pre-explained vs surprised.
//
// Storage: localStorage `ld_perms_last_check_ms` — timestamp of last completion.
// Modal fires when now - stored > 90 days, or when no stamp exists.
//
// No server round-trip. Non-blocking: agent can Skip and continue using app.

import { useEffect, useState } from "react";
import { MapPin, Image as ImageIcon, Camera, Bell, ArrowRight, Check, X } from "lucide-react";

const STORAGE_KEY = "ld_perms_last_check_ms";
const RECHECK_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

type Step = "intro" | "location" | "photos" | "camera" | "push" | "done";

type StepMeta = {
  key: Step;
  title: string;
  why: string;
  cta: string;
  Icon: any;
  ask: () => Promise<"granted" | "denied" | "unavailable">;
};

async function askLocation(): Promise<"granted" | "denied" | "unavailable"> {
  if (!("geolocation" in navigator)) return "unavailable";
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve("granted"),
      () => resolve("denied"),
      { timeout: 8000, maximumAge: 60_000 }
    );
  });
}

async function askCamera(): Promise<"granted" | "denied" | "unavailable"> {
  if (!navigator.mediaDevices?.getUserMedia) return "unavailable";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach(t => t.stop());
    return "granted";
  } catch { return "denied"; }
}

async function askPush(): Promise<"granted" | "denied" | "unavailable"> {
  if (!("Notification" in window)) return "unavailable";
  const p = await Notification.requestPermission();
  return p === "granted" ? "granted" : "denied";
}

// Photos == storage/library access. On web there's no direct API — we can
// only prompt file-picker permission when the user actually taps an <input
// type="file">. So this "step" is informational only.
async function askPhotos(): Promise<"granted" | "denied" | "unavailable"> {
  return "granted"; // informational — real prompt fires on first file input
}

const STEPS: StepMeta[] = [
  {
    key: "location",
    title: "Location",
    why: "Log Open House check-ins, tag Door Knock routes, and drop pins on your territory map. Without it: no OH points, no knock proof.",
    cta: "Enable Location",
    Icon: MapPin,
    ask: askLocation,
  },
  {
    key: "photos",
    title: "Photos",
    why: "Upload your headshot, attach selfies to Open House logs, and share proof-of-work when Nate approves points. We only read what you pick — never scan your library.",
    cta: "Got it",
    Icon: ImageIcon,
    ask: askPhotos,
  },
  {
    key: "camera",
    title: "Camera",
    why: "Snap the OH selfie without leaving the app. Same story for door knock proof and any 'I was there' photo Nate asks for.",
    cta: "Enable Camera",
    Icon: Camera,
    ask: askCamera,
  },
  {
    key: "push",
    title: "Push Notifications",
    why: "Prime Time bell when Cliffside opens (5–7 PM ET = 2x points), digest of yesterday's numbers, and hot-prospect alerts. Nothing else.",
    cta: "Enable Push",
    Icon: Bell,
    ask: askPush,
  },
];

export function shouldPromptPermissions(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return true;
    const t = Number(raw);
    if (!Number.isFinite(t)) return true;
    return (Date.now() - t) > RECHECK_MS;
  } catch { return false; }
}

function markCompleted() {
  try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch { /* ignore */ }
}

export default function PermissionGate({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("intro");
  const [results, setResults] = useState<Record<string, "granted" | "denied" | "unavailable" | "skipped">>({});
  const [busy, setBusy] = useState(false);

  const currentIdx = STEPS.findIndex(s => s.key === step);
  const current = currentIdx >= 0 ? STEPS[currentIdx] : null;

  function next() {
    const nextIdx = currentIdx + 1;
    if (nextIdx >= STEPS.length) {
      markCompleted();
      setStep("done");
      setTimeout(onDone, 900);
    } else {
      setStep(STEPS[nextIdx].key);
    }
  }

  async function grant() {
    if (!current || busy) return;
    setBusy(true);
    try {
      const r = await current.ask();
      setResults(prev => ({ ...prev, [current.key]: r }));
    } finally {
      setBusy(false);
      next();
    }
  }

  function skip() {
    if (!current) return;
    setResults(prev => ({ ...prev, [current.key]: "skipped" }));
    next();
  }

  function skipAll() {
    markCompleted();
    onDone();
  }

  const totalSteps = STEPS.length;
  const stepNum = currentIdx + 1;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.82)",
      backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16,
    }}>
      <div style={{
        width: "100%", maxWidth: 380,
        background: "linear-gradient(180deg,#0f0e0c 0%,#0a0908 100%)",
        border: "1px solid rgba(200,170,90,0.35)",
        borderRadius: 16,
        boxShadow: "0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(200,170,90,0.08)",
        overflow: "hidden",
      }}>
        {step === "intro" && (
          <div style={{ padding: "24px 22px" }}>
            <div style={{ fontSize: 9.5, letterSpacing: "0.22em", color: "#c8aa5a", textTransform: "uppercase", fontWeight: 800, marginBottom: 6 }}>
              Quick setup · takes 30 seconds
            </div>
            <h2 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, fontWeight: 600, color: "#fff", margin: "0 0 10px", lineHeight: 1.15 }}>
              Let's get your phone dialed in.
            </h2>
            <p style={{ fontSize: 13.5, color: "rgba(255,255,255,0.75)", lineHeight: 1.5, margin: "0 0 20px" }}>
              Lead Depot needs 4 quick permissions so it can log your work automatically. You'll see each one explained first, then your phone will ask. Nothing runs in the background.
            </p>
            <button
              onClick={() => setStep(STEPS[0].key)}
              style={{
                width: "100%", padding: "13px 16px", borderRadius: 10,
                background: "linear-gradient(90deg,#c8aa5a,#e6c37a)",
                color: "#0a0908", fontWeight: 800, fontSize: 14, letterSpacing: "0.02em",
                border: "none", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              Start setup <ArrowRight size={16} />
            </button>
            <button
              onClick={skipAll}
              style={{
                width: "100%", marginTop: 8, padding: "10px 16px", borderRadius: 10,
                background: "transparent", color: "rgba(255,255,255,0.4)",
                border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >
              Skip for now
            </button>
          </div>
        )}

        {current && step !== "intro" && step !== "done" && (
          <div style={{ padding: "22px 22px 20px" }}>
            {/* countdown */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontSize: 9, letterSpacing: "0.22em", color: "rgba(200,170,90,0.85)", textTransform: "uppercase", fontWeight: 800 }}>
                Step {stepNum} of {totalSteps}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {STEPS.map((_, i) => (
                  <div key={i} style={{
                    width: 22, height: 3, borderRadius: 2,
                    background: i <= currentIdx ? "#c8aa5a" : "rgba(255,255,255,0.12)",
                    transition: "background 240ms ease",
                  }} />
                ))}
              </div>
            </div>

            <div style={{
              width: 56, height: 56, borderRadius: "50%",
              background: "linear-gradient(135deg, rgba(200,170,90,0.22), rgba(200,170,90,0.08))",
              border: "1px solid rgba(200,170,90,0.4)",
              display: "flex", alignItems: "center", justifyContent: "center",
              marginBottom: 14,
            }}>
              <current.Icon size={26} style={{ color: "#c8aa5a" }} />
            </div>

            <h3 style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: 26, fontWeight: 600, color: "#fff",
              margin: "0 0 8px", lineHeight: 1.15,
            }}>
              {current.title}
            </h3>
            <p style={{ fontSize: 13.5, color: "rgba(255,255,255,0.78)", lineHeight: 1.5, margin: "0 0 18px" }}>
              {current.why}
            </p>

            <button
              onClick={grant}
              disabled={busy}
              style={{
                width: "100%", padding: "13px 16px", borderRadius: 10,
                background: "linear-gradient(90deg,#c8aa5a,#e6c37a)",
                color: "#0a0908", fontWeight: 800, fontSize: 14, letterSpacing: "0.02em",
                border: "none", cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.7 : 1,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              {busy ? "Waiting..." : current.cta} <ArrowRight size={16} />
            </button>
            <button
              onClick={skip}
              disabled={busy}
              style={{
                width: "100%", marginTop: 8, padding: "10px 16px", borderRadius: 10,
                background: "transparent", color: "rgba(255,255,255,0.4)",
                border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >
              Skip this one
            </button>
          </div>
        )}

        {step === "done" && (
          <div style={{ padding: "28px 22px", textAlign: "center" }}>
            <div style={{
              width: 64, height: 64, borderRadius: "50%",
              background: "linear-gradient(135deg,#4ade80,#22c55e)",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              marginBottom: 14, boxShadow: "0 0 30px rgba(74,222,128,0.5)",
            }}>
              <Check size={32} style={{ color: "#0a0908" }} strokeWidth={3} />
            </div>
            <h3 style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: 28, fontWeight: 600, color: "#fff", margin: "0 0 6px",
            }}>You're all set.</h3>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", margin: 0 }}>
              We'll check in again in 90 days.
            </p>
            <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 16 }}>
              {STEPS.map(s => {
                const r = results[s.key];
                const ok = r === "granted";
                return (
                  <div key={s.key} title={`${s.title}: ${r || "skipped"}`} style={{
                    display: "flex", alignItems: "center", gap: 3,
                    fontSize: 10, color: ok ? "#4ade80" : "rgba(255,255,255,0.3)",
                    fontWeight: 700,
                  }}>
                    {ok ? <Check size={11} /> : <X size={11} />} {s.title}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
