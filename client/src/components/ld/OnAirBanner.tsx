// v15.11.10 — Tappable On Air banner + prime-transition haptic.
//
// Renders 24/7. Three states:
//   PRIME   → red "ON AIR — PRIME TIME" plate, flashing broadcast light both ends
//   MID     → amber "MID TIME — OK to dial" plate, static dots
//   DOWN    → dark gray "DOWNTIME — do not cold-call" plate, static dot
//
// Tap the banner → OnAirScheduleModal opens with the full 7-day × 6AM–10PM grid.
// When the tier flips from non-prime → prime, we buzz the phone (Android only).

import { useEffect, useMemo, useRef, useState } from "react";
import { computeCallHeat } from "@/lib/callHeat";
import { hapticOnAirStart } from "@/lib/haptics";
import OnAirScheduleModal from "./OnAirScheduleModal";

interface Props {
  agentId?: string | null; // optional — enables the push toggle
}

async function safeFetchJson<T = unknown>(url: string): Promise<T | null> {
  try { const r = await fetch(url); if (!r.ok) return null; return await r.json() as T; }
  catch { return null; }
}

export default function OnAirBanner({ agentId }: Props) {
  // Re-compute every 60s.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const heat = useMemo(() => computeCallHeat(), [tick]);
  const heatIn30 = useMemo(
    () => computeCallHeat(new Date(Date.now() + 30 * 60 * 1000)),
    [tick],
  );

  // Vibrate on prime transition (non-prime → prime)
  const prevTierRef = useRef(heat.tier);
  useEffect(() => {
    if (prevTierRef.current !== "prime" && heat.tier === "prime") {
      hapticOnAirStart();
    }
    prevTierRef.current = heat.tier;
  }, [heat.tier]);

  const [modalOpen, setModalOpen] = useState(false);
  const [pushOptIn, setPushOptIn] = useState(false);
  const [pushCapable] = useState(() => {
    if (typeof window === "undefined") return false;
    return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  });

  // Load current opt-in from server whenever the modal opens with a known agentId.
  useEffect(() => {
    if (!modalOpen || !agentId) return;
    let cancelled = false;
    (async () => {
      const j = await safeFetchJson<{ pushNotifOnAir?: boolean }>(`/api/agents/${agentId}/push-prefs`);
      if (!cancelled && j) setPushOptIn(!!j.pushNotifOnAir);
    })();
    return () => { cancelled = true; };
  }, [modalOpen, agentId]);

  const togglePush = async (v: boolean) => {
    setPushOptIn(v);
    if (!agentId) return;
    try {
      if (v) {
        // Request notification permission
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          const p = await Notification.requestPermission();
          if (p !== "granted") { setPushOptIn(false); return; }
        }
        if (Notification.permission !== "granted") { setPushOptIn(false); return; }
        // Fetch VAPID public key
        const keyRes = await safeFetchJson<{ publicKey?: string; enabled?: boolean }>(`/api/push/public-key`);
        if (!keyRes?.enabled || !keyRes.publicKey) {
          console.warn("[push] server VAPID not configured; opt-in saved but no subscription");
        } else {
          // Subscribe via SW
          const reg = await navigator.serviceWorker.ready;
          let sub = await reg.pushManager.getSubscription();
          if (!sub) {
            sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey),
            });
          }
          await fetch(`/api/push/subscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: Number(agentId),
              subscription: sub.toJSON(),
              userAgent: navigator.userAgent,
            }),
          });
        }
      } else {
        // Unsubscribe
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            await fetch(`/api/push/unsubscribe`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ endpoint: sub.endpoint }),
            });
            await sub.unsubscribe();
          }
        } catch { /* silent */ }
      }
      await fetch(`/api/agents/${agentId}/push-prefs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pushNotifOnAir: v }),
      });
    } catch (e) {
      console.warn("[push] toggle failed", e);
    }
  };

  // Convert VAPID base64url public key to Uint8Array
  function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // Style tokens per tier.
  const cfg = (() => {
    if (heat.tier === "prime") {
      return {
        bg: "linear-gradient(90deg, #1a0202 0%, #4a0a0a 50%, #1a0202 100%)",
        border: "rgba(239,68,68,0.55)",
        dotColor: "#ef4444",
        badgeColor: "#ef4444",
        badgeText: "ON AIR",
        subText: "PRIME TIME — call now. Tap for schedule.",
        anim: "ld-onair-blink 1.05s steps(1) infinite",
      };
    }
    if (heat.tier === "mid") {
      const soon = heatIn30.tier === "prime";
      return {
        bg: "linear-gradient(90deg, #1a1102 0%, #2f2004 50%, #1a1102 100%)",
        border: "rgba(245,158,11,0.45)",
        dotColor: "#f59e0b",
        badgeColor: "#f59e0b",
        badgeText: soon ? "STAND BY" : "MID TIME",
        subText: soon
          ? "On Air in ~30 min — tap for schedule."
          : "MID TIME — OK to dial. Tap for schedule.",
        anim: soon ? "ld-onair-pulse 2.2s ease-in-out infinite" : "none",
      };
    }
    // DOWN
    return {
      bg: "linear-gradient(90deg, #0a0a0a 0%, #1a1a1a 50%, #0a0a0a 100%)",
      border: "rgba(107,114,128,0.35)",
      dotColor: "#6b7280",
      badgeColor: "#9ca3af",
      badgeText: "OFF AIR",
      subText: heat.nextPrimeWindow || "Off air — tap for the schedule.",
      anim: "none",
    };
  })();

  return (
    <>
      <style>{`
        @keyframes ld-onair-pulse {
          0%, 100% { opacity: 1;   box-shadow: 0 0 24px rgba(239,68,68,0.55), 0 0 4px rgba(239,68,68,0.9); }
          50%      { opacity: 0.35; box-shadow: 0 0 6px  rgba(239,68,68,0.25), 0 0 0   rgba(239,68,68,0.0); }
        }
        @keyframes ld-onair-blink {
          0%, 44%, 100% { opacity: 1; }
          45%, 99%      { opacity: 0.15; }
        }
        .ld-onair-tap { transition: transform 80ms, filter 120ms; }
        .ld-onair-tap:active { transform: scale(0.985); filter: brightness(1.15); }
      `}</style>
      <div
        data-testid={`onair-banner-${heat.tier}`}
        data-tier={heat.tier}
        role="button"
        tabIndex={0}
        aria-label={`${cfg.badgeText}. Tap to view schedule.`}
        onClick={() => setModalOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setModalOpen(true); } }}
        className="ld-onair-tap"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 9999,
          width: "100%",
          padding: "8px 14px",
          background: cfg.bg,
          borderBottom: `1px solid ${cfg.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          textAlign: "center",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 12, height: 12, borderRadius: "50%",
            background: cfg.dotColor,
            animation: cfg.anim,
            flexShrink: 0,
          }}
        />
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", justifyContent: "center", minWidth: 0 }}>
          <span
            style={{
              fontSize: 11, letterSpacing: "0.32em", textTransform: "uppercase",
              fontWeight: 800, color: cfg.badgeColor,
              fontFamily: "'Switzer','Inter',sans-serif", whiteSpace: "nowrap",
            }}
          >
            {cfg.badgeText}
          </span>
          <span
            style={{
              fontSize: 12,
              color: heat.tier === "down" ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.92)",
              fontFamily: "'Switzer','Inter',sans-serif", fontWeight: 600, letterSpacing: "0.02em",
            }}
          >
            {cfg.subText}
          </span>
        </div>
        <span
          aria-hidden
          style={{
            width: 12, height: 12, borderRadius: "50%",
            background: cfg.dotColor,
            animation: cfg.anim,
            animationDelay: heat.tier === "prime" ? "0.55s" : "1.1s",
            flexShrink: 0,
          }}
        />
      </div>

      <OnAirScheduleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        pushOptIn={pushOptIn}
        onTogglePush={togglePush}
        pushCapable={pushCapable}
      />
    </>
  );
}
