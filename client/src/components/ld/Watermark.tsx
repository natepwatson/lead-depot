// v16.7 — Identity watermark overlay.
//
// Renders a faint diagonal tiled watermark across every authenticated screen
// showing the logged-in agent's name + email + current ET timestamp. This does
// NOT technically prevent screenshots (browsers don't expose that capability),
// but every screenshot taken through this UI will carry the exact identity of
// who took it and when. Deters casual leaking; enables forensic identification
// if a screenshot ever shows up somewhere it shouldn't.
//
// Rendered inside <AuthProvider> so `useAuth()` is safe. If no user is logged
// in, renders nothing (login page and public /join pages stay clean).
//
// The overlay is pointer-events: none so it never blocks any click, and uses
// a very low opacity so it doesn't visually interfere with the UI. It sits at
// z-index: 9998 — above app chrome but below any full-screen modals that use
// z-index: 9999+ (very rare in this codebase; only the OnAirBanner uses 100).
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

function useEtTimestamp(refreshMs = 60_000) {
  const [ts, setTs] = useState<string>(() => formatEt(new Date()));
  useEffect(() => {
    const id = setInterval(() => setTs(formatEt(new Date())), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);
  return ts;
}

function formatEt(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ET`;
}

export default function Watermark() {
  const { user } = useAuth();
  const ts = useEtTimestamp();
  if (!user) return null;

  // Build the watermark text once — kept short so it tiles well.
  const line1 = user.name || user.email || `Agent ${user.id}`;
  const line2 = user.email || "";
  const label = `${line1}  ·  ${line2}  ·  ${ts}`;

  // Encode SVG as a data-URI so CSS background-image can tile it. The SVG
  // itself is rotated -30deg. text-anchor="middle" keeps it centered.
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">` +
      `<g transform="rotate(-30 300 100)">` +
      `<text x="300" y="100" text-anchor="middle" ` +
      `font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" ` +
      `font-size="14" font-weight="500" ` +
      `fill="rgba(0,0,0,0.06)">${escapeXml(label)}</text>` +
      `</g>` +
      `</svg>`
  );

  const style: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 9998,
    pointerEvents: "none",
    userSelect: "none",
    backgroundImage: `url("data:image/svg+xml;utf8,${svg}")`,
    backgroundRepeat: "repeat",
    backgroundSize: "600px 200px",
    // v16.7 — media query at runtime: darker on dark backgrounds is impossible
    // to detect from React without a theme context, so we use mix-blend-mode
    // which auto-inverts for us. difference works on both light and dark UIs.
    mixBlendMode: "difference",
    opacity: 0.9,  // combined with the low SVG fill alpha = ~5% effective opacity
  };

  return <div aria-hidden="true" data-watermark="lead-depot-v19.3" style={style} />;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
