// v15.11.11 — 5-tier Sprint Mode schedule modal (illegal / dead / low / middle / prime).
// Opens when the OnAirBanner is tapped. Renders:
//   - 7-day × 8AM–7PM grid (last legal hour is 7 PM per Fla. Stat. § 501.616)
//   - motivational Cormorant italic callout that rotates with the current tier
//   - inline citations w/ links to primary sources
//
// Grid data must stay in sync with client/src/lib/callHeat.ts and
// shared/prime-schedule.ts. If you touch one, touch all three.

import { useEffect, useMemo, useState } from "react";
import { sprintTierForCell, type SprintTier } from "@/lib/callHeat";

interface Props {
  open: boolean;
  onClose: () => void;
  pushOptIn: boolean;
  onTogglePush: (v: boolean) => Promise<void> | void;
  pushCapable: boolean; // whether Notification API + service worker are usable
}

const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Legal window is 8 AM – 8 PM (last legal hour 7 PM). Grid shows exactly that.
const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

const MOTIVATIONAL: Record<SprintTier, string> = {
  prime:   "When the light is red, be relentless. Every dial now is worth two at any other time.",
  middle:  "Solid ground. Middle time is where consistent operators load the pipeline.",
  low:     "Low-yield window — dial if you must, but save the fresh leads for prime.",
  dead:    "Rest the leads. The data says pickup is too low to justify the list burn.",
  illegal: "Outside FL's 8AM–8PM window. Prep lists, don't dial. $500–$1,500 per violation.",
};

function hourLabel(h: number) {
  if (h === 0) return "12A";
  if (h < 12) return `${h}A`;
  if (h === 12) return "12P";
  return `${h - 12}P`;
}

function fullHourLabel(h: number) {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

// Per-cell "why" tooltips — the receipts. Falls back to generic tier reason if unset.
const CELL_REASONS: Record<string, string> = {
  // Tue/Wed/Thu prime windows
  "2-8":  "Tuesday 8 AM — Day-1 expired golden hour. Be first before the other 20+ agents dial (REDX, Kravitz, Jamil Academy).",
  "2-9":  "Tuesday 9 AM — fresh-expired window continues. MIT: qualify rate 164% higher than 1–2 PM.",
  "2-16": "Tuesday 4 PM — MIT's #1 contact window. Orum, Gong, Revenue.io all peak here.",
  "2-17": "Tuesday 5 PM — PropContact HIGH. Post-work, pre-dinner. Dual-income households home.",
  "2-18": "Tuesday 6 PM — Kravitz names 6–7 PM the second-best expired window after 8 AM.",
  "3-8":  "Wednesday 8 AM — Day-1 expired golden hour. Best midweek day per MIT (Wed/Thu peak).",
  "3-9":  "Wednesday 9 AM — continues fresh-expired window.",
  "3-16": "Wednesday 4 PM — Gong's #1 mid-week peak. Consistent with MIT + PropContact.",
  "3-17": "Wednesday 5 PM — universal peak in every dataset.",
  "3-18": "Wednesday 6 PM — pre-dinner sweet spot.",
  "4-8":  "Thursday 8 AM — Day-1 expired golden hour. MIT ranks Thursday best qualify day.",
  "4-9":  "Thursday 9 AM — continues fresh-expired window.",
  "4-16": "Thursday 4 PM — MIT: 114% better than worst window (11 AM–12 PM).",
  "4-17": "Thursday 5 PM — peak weekday reach.",
  "4-18": "Thursday 6 PM — post-work pre-dinner.",
  // Saturday morning prime
  "6-10": "Saturday 10 AM — PropContact's #2 window overall. Especially strong for older owners + land-owner leads.",
  "6-11": "Saturday 11 AM — tail end of Saturday-morning prime.",
  // Notable dead
  "1-12": "Monday lunch — MIT's worst window (114% worse than 4–6 PM). Every dataset agrees.",
  "1-13": "Monday post-lunch — MIT explicitly worst hour.",
  "2-12": "Tuesday lunch — dead. Every dataset agrees.",
  "2-13": "Tuesday post-lunch — dead.",
  "3-12": "Wednesday lunch — dead.",
  "3-13": "Wednesday post-lunch — dead.",
  "4-12": "Thursday lunch — dead.",
  "4-13": "Thursday post-lunch — dead.",
  "5-12": "Friday lunch — dead.",
  "5-13": "Friday post-lunch — dead.",
  // Sunday all dead
  "0-10": "Sunday — family/church day. Bad ROI and bad taste. Save it for Monday.",
};

const CITATIONS: Array<{ n: number; label: string; url: string }> = [
  { n: 1, label: "MIT Lead Response Management Study — 4–6 PM contact 114% better than worst window", url: "https://25649.fs1.hubspotusercontent-na2.net/hub/25649/file-13535879-pdf/docs/mit_study.pdf" },
  { n: 2, label: "PropContact 2026 — real estate cold-call timing analysis", url: "https://propcontact.net/blog/best-time-to-call-real-estate-leads" },
  { n: 3, label: "Orum — State of Cold Calling (1B+ calls analyzed)", url: "https://www.orum.com/blog/cold-calling-2025" },
  { n: 4, label: "REDX — Day 1 Expired Listing Calls: Why Calling First Wins", url: "https://www.redx.com/blog/day-1-expired-listing-calls/" },
  { n: 5, label: "Jamil Academy — Expired Listing Scripts 2026 (8–10 AM / 4–6 PM)", url: "https://www.jamilacademy.com/blog/expired-listing-scripts" },
  { n: 6, label: "Revenue.io — Best Time to Cold Call Prospects 2026", url: "https://www.revenue.io/blog/the-best-time-to-cold-call-prospects" },
  { n: 7, label: "Convoso — Data-backed cold call timing (Gong + CallHippo synthesis)", url: "https://www.convoso.com/blog/best-time-to-cold-call/" },
  { n: 8, label: "Fla. Stat. § 501.616(6)(a) — FL 8AM–8PM commercial call cap", url: "https://www.flsenate.gov/laws/statutes/2021/501.616" },
];

export default function OnAirScheduleModal({ open, onClose, pushOptIn, onTogglePush, pushCapable }: Props) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, [open]);

  // Current cell for the gold outline
  const { curDow, curHour, curTier } = useMemo(() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false,
    }).formatToParts(now);
    const wd = parts.find(p => p.type === "weekday")?.value ?? "Mon";
    const hStr = parts.find(p => p.type === "hour")?.value ?? "0";
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dowMap[wd] ?? 1;
    let hour = parseInt(hStr, 10);
    if (hour === 24) hour = 0;
    const tier = sprintTierForCell(dow, hour);
    return { curDow: dow, curHour: hour, curTier: tier };
  }, [now]);

  const [hoverCell, setHoverCell] = useState<{ dow: number; hour: number } | null>(null);

  if (!open) return null;

  const hoverKey = hoverCell ? `${hoverCell.dow}-${hoverCell.hour}` : "";
  const hoverReason = hoverKey ? CELL_REASONS[hoverKey] : "";
  const hoverTier = hoverCell ? sprintTierForCell(hoverCell.dow, hoverCell.hour) : null;

  return (
    <>
      <style>{`
        @keyframes ld-schedmodal-fade { from { opacity:0 } to { opacity:1 } }
        @keyframes ld-schedmodal-rise { from { transform: translateY(24px); opacity:0 } to { transform: translateY(0); opacity:1 } }
        .ld-schedmodal-cell {
          height: 22px;
          border-radius: 3px;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.02em;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Switzer','Inter',sans-serif;
          cursor: pointer;
          transition: transform 80ms;
        }
        .ld-schedmodal-cell:active { transform: scale(0.94); }
        .ld-schedmodal-cell.prime   { background: linear-gradient(180deg,#ef4444 0%,#b91c1c 100%); color: rgba(0,0,0,0.9); }
        .ld-schedmodal-cell.middle  { background: linear-gradient(180deg,#22c55e 0%,#15803d 100%); color: rgba(0,0,0,0.85); }
        .ld-schedmodal-cell.low     { background: linear-gradient(180deg,#facc15 0%,#a16207 100%); color: rgba(0,0,0,0.85); }
        .ld-schedmodal-cell.dead    { background: #1f2937; color: rgba(255,255,255,0.4); }
        .ld-schedmodal-cell.illegal {
          background: repeating-linear-gradient(45deg,#3f1212 0 3px,#0a0000 3px 6px);
          color: rgba(255,255,255,0.4);
          font-size: 8px;
          cursor: not-allowed;
        }
        .ld-schedmodal-cell.now { outline: 1.5px solid #e8c96a; outline-offset: -1px; box-shadow: 0 0 0 1px #e8c96a inset; }
      `}</style>

      <div
        role="dialog"
        aria-modal="true"
        aria-label="On Air Schedule"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.85)",
          zIndex: 10001,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "16px 8px",
          overflowY: "auto",
          animation: "ld-schedmodal-fade 180ms ease-out",
          fontFamily: "'Switzer','Inter',sans-serif",
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            background: "#0a0a0a",
            border: "0.5px solid rgba(200,170,90,0.25)",
            borderRadius: 14,
            width: "100%",
            maxWidth: 560,
            padding: "18px 14px 20px",
            color: "#f3f3f3",
            animation: "ld-schedmodal-rise 220ms ease-out",
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
            <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 24, fontWeight: 500, letterSpacing: "0.02em" }}>
              On Air Schedule
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "transparent", border: "none", color: "rgba(243,243,243,0.5)",
                fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 4,
              }}
            >×</button>
          </div>
          <div style={{ fontSize: 10, color: "rgba(243,243,243,0.5)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>
            5-tier Sprint Mode · FL legal window 8AM–8PM · Eastern Time
          </div>

          {/* Motivational callout — rotates with current tier */}
          <div style={{
            fontFamily: "'Cormorant Garamond',Georgia,serif",
            fontStyle: "italic",
            fontSize: 15,
            color: "#e8c96a",
            letterSpacing: "0.02em",
            margin: "8px 0 14px",
            padding: "10px 0",
            borderTop: "0.5px solid rgba(200,170,90,0.2)",
            borderBottom: "0.5px solid rgba(200,170,90,0.2)",
            textAlign: "center",
          }}>
            "{MOTIVATIONAL[curTier]}"
          </div>

          {/* Legend — 5 tiers */}
          <div style={{ display: "flex", gap: 10, marginBottom: 10, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(243,243,243,0.7)", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "linear-gradient(180deg,#ef4444,#b91c1c)" }} />Prime
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "linear-gradient(180deg,#22c55e,#15803d)" }} />Middle
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "linear-gradient(180deg,#facc15,#a16207)" }} />Low
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "#1f2937" }} />Dead
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "repeating-linear-gradient(45deg,#3f1212 0 3px,#0a0000 3px 6px)" }} />Illegal
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "transparent", border: "1.5px solid #e8c96a" }} />Now
            </span>
          </div>

          {/* Grid */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "36px repeat(7, 1fr)",
            gap: "1.5px",
            marginBottom: 12,
          }}>
            <div />
            {DAYS_SHORT.map(d => (
              <div key={d} style={{
                fontSize: 9, color: "rgba(243,243,243,0.55)", textAlign: "center",
                padding: "3px 0", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 500,
              }}>{d}</div>
            ))}

            {HOURS.map(h => (
              <>
                <div key={`hlabel-${h}`} style={{
                  fontSize: 8.5, color: "rgba(243,243,243,0.5)",
                  display: "flex", alignItems: "center", justifyContent: "flex-end",
                  paddingRight: 4, letterSpacing: "0.02em",
                }}>{hourLabel(h)}</div>

                {DAYS_SHORT.map((_, d) => {
                  const tier = sprintTierForCell(d, h);
                  const isNow = d === curDow && h === curHour;
                  const classes = [
                    "ld-schedmodal-cell",
                    tier,
                    isNow ? "now" : "",
                  ].filter(Boolean).join(" ");
                  // Show first letter of tier: P/M/L/D/—
                  const label = tier === "prime" ? "P"
                    : tier === "middle" ? "M"
                    : tier === "low" ? "L"
                    : tier === "dead" ? "D"
                    : "—";
                  return (
                    <div
                      key={`c-${d}-${h}`}
                      className={classes}
                      onClick={() => setHoverCell({ dow: d, hour: h })}
                    >
                      {label}
                    </div>
                  );
                })}
              </>
            ))}
          </div>

          {/* Hover / tap tooltip */}
          {hoverCell && hoverTier && (
            <div style={{
              padding: "10px 12px",
              background: "rgba(200,170,90,0.06)",
              border: "0.5px solid rgba(200,170,90,0.28)",
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.55,
              marginBottom: 12,
              color: "rgba(243,243,243,0.9)",
            }}>
              <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "#e8c96a", marginBottom: 4 }}>
                {DAYS_SHORT[hoverCell.dow]} {fullHourLabel(hoverCell.hour)} · {hoverTier.toUpperCase()}
              </div>
              {hoverReason || (
                hoverTier === "prime" ? "Prime window — multiple independent studies converge (MIT, PropContact, Orum, Gong)." :
                hoverTier === "middle" ? "Middle window. Solid pickup, not sprint-worthy." :
                hoverTier === "low" ? "Low-yield window. Use for backfill, not fresh leads." :
                hoverTier === "dead" ? "Dead window — pickup too low to justify the list burn." :
                "Outside FL 8AM–8PM legal window. Prep lists, don't dial."
              )}
            </div>
          )}

          {/* Push opt-in */}
          {pushCapable && (
            <div style={{
              padding: "10px 12px",
              background: "rgba(239,68,68,0.06)",
              border: "0.5px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}>
              <input
                type="checkbox"
                checked={pushOptIn}
                onChange={(e) => onTogglePush(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: "#ef4444", cursor: "pointer", flexShrink: 0 }}
              />
              <div style={{ flex: 1, fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600, color: "#f3f3f3", marginBottom: 2 }}>Alert me 15 min before On Air</div>
                <div style={{ color: "rgba(243,243,243,0.6)", fontSize: 11 }}>Buzz + push notification so you're ready to sprint.</div>
              </div>
            </div>
          )}

          {/* Why it's built this way */}
          <div style={{
            fontSize: 11, lineHeight: 1.55, color: "rgba(243,243,243,0.72)",
            marginTop: 6, paddingTop: 12,
            borderTop: "0.5px solid rgba(200,170,90,0.2)",
          }}>
            <div><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why Tue/Wed/Thu 4–7 PM is prime:</span> MIT Lead Response: 114% better than worst window. PropContact rates HIGH. Orum (1B+ calls), Gong (100K calls), Revenue.io, CallHippo all peak 4–5 PM <sup>[1][2][3]</sup>.</div>
            <div style={{ marginTop: 5 }}><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why Tue/Wed/Thu 8–10 AM is prime:</span> Day-1 expired golden hour. Kravitz, Jamil Academy, and REDX converge — be first before the other 20+ agents dial <sup>[4][7]</sup>. MIT: qualify rate 164% higher than 1–2 PM.</div>
            <div style={{ marginTop: 5 }}><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why Sat 10 AM–noon is prime:</span> PropContact ranks it the #2 window overall — "especially strong for older owners." Fits our land-owner + long-tenure seller profile.</div>
            <div style={{ marginTop: 5 }}><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why 12–2 PM is dead:</span> MIT explicitly worst window (114% worse than 4–6 PM). Every dataset agrees. Save for list-prep, not calls.</div>
            <div style={{ marginTop: 5 }}><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why we stop at 8 PM:</span> Fla. Stat. § 501.616(6)(a) — commercial calls only 8 AM – 8 PM recipient-local. $500–$1,500 per violation <sup>[8]</sup>. Non-negotiable.</div>
          </div>

          {/* Sources */}
          <div style={{
            fontSize: 10.5, marginTop: 12, paddingTop: 10,
            borderTop: "0.5px solid rgba(200,170,90,0.15)",
          }}>
            <div style={{ color: "#e8c96a", fontWeight: 500, marginBottom: 5, letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 9 }}>Sources</div>
            {CITATIONS.map(c => (
              <div key={c.n} style={{ display: "flex", gap: 8, marginTop: 3, lineHeight: 1.5 }}>
                <span style={{ color: "#e8c96a", fontWeight: 500, minWidth: 18 }}>{c.n}.</span>
                <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: "rgba(243,243,243,0.72)", textDecoration: "underline", textDecorationColor: "rgba(200,170,90,0.35)" }}>
                  {c.label}
                </a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
