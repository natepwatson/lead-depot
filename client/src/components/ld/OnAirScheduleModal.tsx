// v15.11.10 — Full 7-day × 6AM–10PM schedule modal.
// Opens when the OnAirBanner is tapped. Renders:
//   - the research-locked PRIME / MID / DOWN grid (cell colors + hover tooltip)
//   - TCPA hatching for hours outside Florida's 8AM–8PM legal window
//   - motivational Cormorant italic callout that rotates with the current tier
//   - inline citations w/ links to primary sources
//
// Grid data must stay in sync with client/src/lib/callHeat.ts and
// shared/prime-schedule.ts. If you touch one, touch all three.

import { useEffect, useMemo, useState } from "react";
import { tierForCell, type HeatTier } from "@/lib/callHeat";

interface Props {
  open: boolean;
  onClose: () => void;
  pushOptIn: boolean;
  onTogglePush: (v: boolean) => Promise<void> | void;
  pushCapable: boolean; // whether Notification API + service worker are usable
}

const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

const MOTIVATIONAL: Record<HeatTier, string> = {
  prime: "When the light is red, be relentless. Every dial now is worth two at any other time.",
  mid: "The warmup matters. Ten dials in mid time load the pipeline for the sprint.",
  low: "Shoulder hour — the data disagrees. Dial the ones you're already excited about.",
  down: "Rest the leads. The best callers dial when the data says answer — not when they feel like it.",
  illegal: "Outside the legal window. No cold calls, no exceptions — Fla. Stat. § 501.616.",
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

// Per-cell "why" tooltips — the receipts. Only fills PRIME + notable DOWN cells;
// unlisted cells fall back to a generic tier reason.
const CELL_REASONS: Record<string, string> = {
  // Sunday
  "0-11": "Post-church, pre-football — cleanest Sunday window in Florida (NBER worship data + NFL 1PM kickoff).",
  "0-12": "Massey/CDC Sunday 12–1PM contact climbing; ThinkingPhones ranks Sunday #1 for unknown-number pickup.",
  "0-14": "Sunday 2–3PM — post-lunch, ~half-time lull for early NFL game. Massey rising.",
  "0-17": "Sunday early-evening — Massey ranks 5–6PM at 57%.",
  "0-18": "Sunday 6PM — Massey 58.4%. Post-football, pre-dinner.",
  "0-19": "Sunday 7PM — Massey 62.1%, the STRONGEST weekday-comparable evening in the whole table.",
  // Monday–Thursday evening prime
  "1-18": "Massey Monday 6PM = 59.9%. INRIX names Monday the lightest commute day.",
  "1-19": "Massey Monday 7PM = 61.1%. Peak weekday reach.",
  "2-18": "Massey Tuesday 6PM = 58.3%. Homeowners home from work.",
  "2-19": "Massey Tuesday 7PM = 60.9%.",
  "3-18": "Wednesday 6PM = 60.4% — Massey's HIGHEST weekday evening cell.",
  "3-19": "Wednesday 7PM = 59.5%.",
  "4-18": "Thursday 6PM = 59.1%. Post-rush (INRIX names Thursday worst overall traffic day).",
  "4-19": "Thursday 7PM = 58.8%.",
  // Thursday DOWN 5-6
  "4-17": "Thursday 5–6PM is the deepest commute hole of the week (INRIX). Wait until 6PM.",
  // Friday
  "5-14": "Friday 2PM — homeowners home early. Avg Friday logoff = 4:03PM (ActivTrak, 75k workers). CATCH THEM.",
  "5-15": "Friday 3PM PRIME — CallHub ranks Friday best answer day (22.21%). WFH-Friday effect is real and large.",
  "5-16": "Friday 4PM PRIME — the pre-commute sweet spot. Get them BEFORE the 5PM snarl.",
  "5-17": "Friday 5–6PM = worst commute hour of the week per INRIX. Skip.",
  // Saturday
  "6-8": "Saturday 8AM PRIME — the classic real-estate window (Landvoice, coaches). Sellers home.",
  "6-9": "Saturday 9AM — Massey 60.7%. Longest, highest-quality conversations of the week (CallHub 41.4s avg).",
  "6-10": "Saturday 10AM — Massey 59.3%. Peak weekend residential window.",
  "6-11": "Saturday 11AM — Massey 55.5%. Still strong.",
  "6-16": "Saturday 4PM — pre-dinner sweet spot. Massey Saturday holds 51–61% all day.",
  "6-17": "Saturday 5PM — Massey Saturday hasn't broken 51% floor yet.",
  "6-18": "Saturday 6PM — Massey 55.4%.",
  "6-19": "Saturday 7PM — Massey 57.1%. Starts sliding into date-night after this.",
};

const CITATIONS: Array<{ n: number; label: string; url: string }> = [
  { n: 1, label: "Massey et al., CDC/NCHS RDD household contact study", url: "https://www.cdc.gov/nchs/data/nis/estimation_weighting/massey1996.pdf" },
  { n: 2, label: "CallHub — 2.2M residential/political calls (Aug–Dec 2020)", url: "https://callhub.io/blog/canvassing/best-phonebanking-times/" },
  { n: 3, label: "ThinkingPhones/Fuze — 25M+ inbound U.S. calls", url: "https://www.itbusinessedge.com/applications/how-to-create-an-optimized-calling-strategy/" },
  { n: 4, label: "NBER w32334 — worship attendance from 2.1M cellphones + ATUS", url: "https://www.nber.org/system/files/working_papers/w32334/w32334.pdf" },
  { n: 5, label: "ActivTrak (via Axios) — Friday logoff 4:03 PM, 75k workers", url: "https://www.axios.com/2024/03/30/work-log-off-early-fridays-early-weekend" },
  { n: 6, label: "INRIX National Traffic Scorecard", url: "https://inrix.com/press-releases/america-road-to-gridlock-inrix-scorecard/" },
  { n: 7, label: "Landvoice — expired-listing prospecting", url: "https://www.landvoice.com/blog/prospecting-expireds" },
  { n: 8, label: "Fla. Stat. § 501.616(6)(a) — FL 8AM–8PM cap", url: "https://www.flsenate.gov/laws/statutes/2021/501.616" },
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
    const tier = tierForCell(dow, hour);
    return { curDow: dow, curHour: hour, curTier: tier };
  }, [now]);

  const [hoverCell, setHoverCell] = useState<{ dow: number; hour: number } | null>(null);

  if (!open) return null;

  const hoverKey = hoverCell ? `${hoverCell.dow}-${hoverCell.hour}` : "";
  const hoverReason = hoverKey ? CELL_REASONS[hoverKey] : "";
  const hoverTier = hoverCell ? tierForCell(hoverCell.dow, hoverCell.hour) : null;

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
        /* v15.11.22 — New palette: green prime, yellow mid, orange low, light-gray down, darkest-gray illegal */
        .ld-schedmodal-cell.prime { background: linear-gradient(180deg,#22c55e 0%,#15803d 100%); color: rgba(0,0,0,0.85); }
        .ld-schedmodal-cell.mid   { background: linear-gradient(180deg,#eab308 0%,#a16207 100%); color: rgba(0,0,0,0.85); }
        .ld-schedmodal-cell.low   { background: linear-gradient(180deg,#f97316 0%,#c2410c 100%); color: rgba(0,0,0,0.85); }
        .ld-schedmodal-cell.down  { background: #9ca3af; color: rgba(0,0,0,0.55); }
        .ld-schedmodal-cell.illegal { background: repeating-linear-gradient(45deg,#1f2937 0 3px,#0a0a0a 3px 6px); color: rgba(255,255,255,0.35); font-size: 8px; cursor: not-allowed; }
        .ld-schedmodal-cell.tcpa  {
          background: repeating-linear-gradient(45deg,#1f2937 0 3px,#0a0a0a 3px 6px);
          color: rgba(255,255,255,0.35);
          font-size: 8px;
          cursor: not-allowed;
        }
        .ld-schedmodal-cell.now { outline: 1.5px solid #e8c96a; outline-offset: -1px; }
      `}</style>

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Prime Time Schedule"
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
              Prime Time Schedule
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
            Research-based · FL legal window 8AM–8PM · Eastern Time
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

          {/* Legend */}
          <div style={{ display: "flex", gap: 10, marginBottom: 10, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(243,243,243,0.6)", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "linear-gradient(180deg,#22c55e,#15803d)" }} />Prime 2×
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "linear-gradient(180deg,#eab308,#a16207)" }} />Mid 1.5×
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "linear-gradient(180deg,#f97316,#c2410c)" }} />Low 1.25×
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "#9ca3af" }} />Down 1×
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "repeating-linear-gradient(45deg,#1f2937 0 3px,#0a0a0a 3px 6px)" }} />Illegal
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
                  const tier = tierForCell(d, h);
                  const legal = tier !== "illegal";
                  const isNow = d === curDow && h === curHour;
                  const classes = [
                    "ld-schedmodal-cell",
                    tier === "illegal" ? "illegal" : tier,
                    isNow ? "now" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <div
                      key={`c-${d}-${h}`}
                      className={classes}
                      onClick={() => legal && setHoverCell({ dow: d, hour: h })}
                    >
                      {tier === "illegal" ? "TCPA" : tier[0].toUpperCase()}
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
                hoverTier === "prime" ? "Peak residential window — Massey/CDC + CallHub converge." :
                hoverTier === "mid" ? "Middle window. Reachable but not sprint-worthy." :
                hoverTier === "low" ? "Shoulder hour — sources disagree. Dial the ones you're already warm on." :
                hoverTier === "illegal" ? "Outside FL's 8 AM – 8 PM window. Do not dial." :
                "Low-yield window. Save leads for Prime Time."
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
                style={{ width: 18, height: 18, accentColor: "#22c55e", cursor: "pointer", flexShrink: 0 }}
              />
              <div style={{ flex: 1, fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600, color: "#f3f3f3", marginBottom: 2 }}>Alert me 15 min before Prime Time</div>
                <div style={{ color: "rgba(243,243,243,0.6)", fontSize: 11 }}>Buzz + push notification so you're ready to sprint.</div>
              </div>
            </div>
          )}

          {/* v15.11.22 — Multiplier value block */}
          <div style={{
            fontSize: 11, lineHeight: 1.55, color: "rgba(243,243,243,0.85)",
            marginTop: 6, paddingTop: 12, marginBottom: 4,
            borderTop: "0.5px solid rgba(200,170,90,0.2)",
            padding: "12px 12px 12px 12px",
            background: "rgba(34,197,94,0.05)",
            border: "0.5px solid rgba(34,197,94,0.25)",
            borderRadius: 8,
          }}>
            <div style={{ color: "#22c55e", fontWeight: 600, marginBottom: 6, letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Why bother — points multiply</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 12px", fontSize: 11 }}>
              <div><span style={{ color: "#22c55e", fontWeight: 600 }}>Prime</span> → 2× (appt = 80)</div>
              <div><span style={{ color: "#eab308", fontWeight: 600 }}>Mid</span> → 1.5× (appt = 60)</div>
              <div><span style={{ color: "#f97316", fontWeight: 600 }}>Low</span> → 1.25× (appt = 50)</div>
              <div><span style={{ color: "#9ca3af", fontWeight: 600 }}>Down</span> → 1× (appt = 40)</div>
            </div>
            <div style={{ marginTop: 6, color: "rgba(243,243,243,0.7)", fontSize: 10.5 }}>
              A prime-hour appt is worth double a downtime appt. Dial when it counts.
            </div>
          </div>

          {/* Why it's built this way — rewritten v15.11.22 to match the actual grid */}
          <div style={{
            fontSize: 11, lineHeight: 1.55, color: "rgba(243,243,243,0.72)",
            marginTop: 12, paddingTop: 12,
            borderTop: "0.5px solid rgba(200,170,90,0.2)",
          }}>
            <div><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why 4–7 PM is prime every weekday:</span> Massey/CDC, CallHub 2.2M-call analysis, ThinkingPhones 25M-call, WFM collections, and MIT lead-response all converge on late-afternoon / early-evening peak <sup>[1][2][3]</sup>. Homeowners are home from work and pre-dinner.</div>
            <div style={{ marginTop: 5 }}><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why Tue–Thu mornings are prime:</span> Homeowners run errands mid-morning but many are still home 8–10 AM before the day gets away. Mon is the exception — people are catching up on the weekend, less reachable.</div>
            <div style={{ marginTop: 5 }}><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why weekday lunch is dead:</span> Mon–Thu 12–2 PM is off. Massey shows 40–46% midday vs 58–65% evening <sup>[1]</sup>. Use lunch for list-prep, texts, or paperwork.</div>
            <div style={{ marginTop: 5 }}><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why Friday's afternoon flips:</span> Homeowners log off early (4:03 PM avg, 75k workers) <sup>[5]</sup>, so Fri 2–4 PM is prime. But 5–6 PM becomes the worst commute of the week <sup>[6]</sup> — downgraded to low.</div>
            <div style={{ marginTop: 5 }}><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why Saturday is mostly prime:</span> Massey Saturday holds 51–61% all day. CallHub found Saturday delivers the longest, highest-quality calls (41.38s avg) <sup>[1][2]</sup>. Only midday 12–3 PM softens to mid — people run errands then.</div>
            <div style={{ marginTop: 5 }}><span style={{ color: "#e8c96a", fontWeight: 500 }}>Why we stop at 8 PM:</span> Fla. Stat. § 501.616(6)(a) — commercial calls only 8 AM – 8 PM in the called party's local time. $500–$1,500 per violation <sup>[8]</sup>. Non-negotiable.</div>
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
