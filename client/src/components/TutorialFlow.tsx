/**
 * TutorialFlow — v14.81
 * Fullscreen fixed overlay (z-index 100), dark canvas background matching
 * the app. Replaces the old TutorialModal.tsx (help-button reference tour)
 * with a 7-chapter cinematic + hands-on onboarding experience.
 *
 * Triggered from App.tsx when an agent's tutorialCompletedAt is NULL
 * (first login) or after "Replay tutorial" from Profile (rewatch).
 *
 * Alex's culture lines used verbatim throughout, per the onboarding spec:
 *   "Lead Depot doesn't create producers; it reveals them."
 *   "Around here, effort is visible and results are public."
 *   "We keep it simple and real."
 *   "Lead Depot exists to remove friction, so you can spend more time doing
 *    the few things that actually move deals forward."
 *   Closing: "Show up ready to hustle. Process leads The Watson Brothers Way.
 *    Make money."
 */
import { useState, useEffect, useRef } from "react";
import {
  Trophy, Layers, Phone, UserPlus, UserCircle2, ChevronDown,
  PhoneMissed, AlertTriangle, PhoneOff, XCircle, RefreshCw, Heart,
  CheckCircle2, Voicemail,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { playSound, forceTutorialSounds } from "@/lib/sounds";
import Confetti from "./Confetti";

// ─── Shared visual tokens (matches app's dark-gold theme) ────────────────────
const GOLD = "#c8aa5a";
const GOLD_DIM = "rgba(200,170,90,0.55)";

const chapterWrap: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 100,
  background: "#080808",
  fontFamily: "'Switzer','Inter',sans-serif",
  display: "flex", flexDirection: "column",
  overflow: "hidden",
};

// Mini nav icon config — mirrors AgentView's NAV array exactly.
const MINI_NAV = [
  { id: "leaderboard", label: "Dashboard", icon: Trophy },
  { id: "pipeline",    label: "Pipeline",  icon: Layers },
  { id: "leads",       label: "Dial",      icon: Phone },
  { id: "refer",       label: "Referrals", icon: UserPlus },
  { id: "profile",     label: "Profile",   icon: UserCircle2 },
] as const;

const TAB_COPY: Record<string, string> = {
  leaderboard: "Where you check the score. Effort is visible.",
  pipeline:    "Every deal you've moved forward. Nothing here ever expires.",
  leads:       "The gold button. Where the money gets made.",
  refer:       "Send us a client or agent — you own that lead forever.",
  profile:     "Your headshot, rank, and identity on the team.",
};

const OUTCOME_TILES = [
  { key: "no_answer",    label: "No Answer",     icon: PhoneMissed,   color: "#facc15", desc: "Most common. Queued for another try later." },
  { key: "wrong_number",  label: "Wrong #",       icon: AlertTriangle, color: "#f87171", desc: "Dead phone. Lead moves on. No harm done." },
  { key: "recycled",     label: "Recycle",        icon: RefreshCw,     color: "#67e8f9", desc: "Called them, want to revisit later. Lead returns to the pool." },
  { key: "keep_in_touch", label: "Keep in Touch", icon: Heart,         color: "#f9a8d4", desc: "They're interested but not ready. This goes into YOUR pipeline forever." },
  { key: "not_interested",label: "Not Interested",icon: XCircle,       color: "#fca5a5", desc: "Real \u2018no.\u2019 We respect it and move on." },
  { key: "left_voicemail",label: "Left VM",       icon: Voicemail,     color: "#93c5fd", desc: "Voicemail left. Counts as contact attempt." },
  { key: "disconnected", label: "Disconnected",   icon: PhoneOff,      color: "#cbd5e1", desc: "Number doesn't work. System flags the phone." },
] as const;

function ProgressDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={{ display: "flex", gap: 7, justifyContent: "center", padding: "0 0 22px" }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{
          width: i === current ? 20 : 6, height: 6, borderRadius: 3,
          background: i === current ? GOLD : i < current ? "rgba(200,170,90,0.5)" : "rgba(255,255,255,0.15)",
          transition: "all 0.25s ease",
        }} />
      ))}
    </div>
  );
}

function SkipButton({ onSkip }: { onSkip: () => void }) {
  return (
    <button
      onClick={onSkip}
      data-testid="tutorial-skip"
      style={{
        position: "absolute", top: 18, right: 18, zIndex: 5,
        background: "none", border: "none", cursor: "pointer",
        color: "rgba(255,255,255,0.4)", fontSize: 12, letterSpacing: "0.08em",
        textTransform: "uppercase", padding: "6px 8px",
      }}
    >
      Skip tutorial
    </button>
  );
}

function GoldPillButton({ children, onClick, disabled, testId }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; testId?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      style={{
        padding: "15px 44px", borderRadius: 999,
        background: disabled ? "rgba(200,170,90,0.25)" : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
        border: "none", cursor: disabled ? "not-allowed" : "pointer",
        color: disabled ? "rgba(255,255,255,0.35)" : "#080808",
        fontSize: 13, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase",
        boxShadow: disabled ? "none" : "0 6px 24px rgba(200,170,90,0.35)",
        transition: "all 0.2s ease",
      }}
    >
      {children}
    </button>
  );
}

// ─── Fake lead card (styled to match the app's real LeadCard) ───────────────
function FakeLeadCard({ name, address, score, phone, tag }: { name: string; address: string; score: number; phone: string; tag: string }) {
  return (
    <div style={{
      background: "linear-gradient(160deg, #141414 0%, #0c0c0c 60%, #0a0a0a 100%)",
      border: "1px solid rgba(200,170,90,0.3)",
      borderRadius: 16, overflow: "hidden",
      width: "100%", maxWidth: 380,
      boxShadow: "0 0 40px rgba(200,170,90,0.06), 0 8px 32px rgba(0,0,0,0.6)",
      animation: "cardSlideIn 260ms cubic-bezier(0.4,0,0.2,1)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 18px",
        background: "linear-gradient(135deg, rgba(200,170,90,0.12) 0%, rgba(200,170,90,0.04) 100%)",
        borderBottom: "1px solid rgba(200,170,90,0.2)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: GOLD, fontWeight: 700 }}>
            {tag}
          </span>
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            minWidth: 24, height: 18, padding: "0 6px", borderRadius: 9, fontSize: 10, fontWeight: 800,
            background: "linear-gradient(135deg,#c8aa5a,#a8893a)", color: "#080808",
          }}>
            {score}
          </span>
        </div>
      </div>
      <div style={{ padding: "18px 18px 16px" }}>
        <h2 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "1.9rem", fontWeight: 400, color: "#fff", marginBottom: 6, lineHeight: 1.1,
        }}>
          {name}
        </h2>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>{address}</p>
        <p style={{ fontSize: 13, color: GOLD_DIM }}>{phone}</p>
      </div>
    </div>
  );
}

function CalloutPill({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      position: "absolute",
      background: "rgba(200,170,90,0.95)", color: "#080808",
      padding: "8px 14px", borderRadius: 10, fontSize: 12, fontWeight: 700,
      boxShadow: "0 4px 20px rgba(200,170,90,0.5)",
      whiteSpace: "nowrap", zIndex: 6,
      animation: "calloutBob 1.6s ease-in-out infinite",
      ...style,
    }}>
      {children}
      <div style={{
        position: "absolute", bottom: -6, left: "50%", transform: "translateX(-50%)",
        width: 0, height: 0,
        borderLeft: "6px solid transparent", borderRight: "6px solid transparent",
        borderTop: "6px solid rgba(200,170,90,0.95)",
      }} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Chapter 1 — Cinematic Intro
// ══════════════════════════════════════════════════════════════════════════
function Chapter1({ onNext }: { onNext: () => void }) {
  const [lineIdx, setLineIdx] = useState(0); // 0 = none, 1, 2, 3 = all shown
  const [canBegin, setCanBegin] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setLineIdx(1), 400);
    const t2 = setTimeout(() => setLineIdx(2), 400 + 700);
    const t3 = setTimeout(() => setLineIdx(3), 400 + 700 + 700 + 1500);
    const t4 = setTimeout(() => setCanBegin(true), 5000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, []);

  return (
    <div style={{ ...chapterWrap, alignItems: "center", justifyContent: "center", position: "relative" }}>
      {/* Subtle animated gold ring pulse in the background */}
      <div style={{
        position: "absolute", width: 500, height: 500, borderRadius: "50%",
        border: `1px solid rgba(200,170,90,0.15)`,
        animation: "goModePulseRing 3.2s ease-in-out infinite",
      }} />
      <div style={{
        position: "absolute", width: 340, height: 340, borderRadius: "50%",
        border: `1px solid rgba(200,170,90,0.12)`,
        animation: "goModePulseRing 3.2s ease-in-out infinite 0.4s",
      }} />

      <div style={{ textAlign: "center", padding: "0 32px", maxWidth: 560, position: "relative", zIndex: 2 }}>
        <p style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 400,
          fontSize: "clamp(1.6rem,5vw,2.2rem)", color: "#fff", lineHeight: 1.5,
          opacity: lineIdx >= 1 ? 1 : 0, transition: "opacity 700ms ease",
          marginBottom: 4,
        }}>
          Lead Depot doesn't create producers.
        </p>
        <p style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 500,
          fontSize: "clamp(1.6rem,5vw,2.2rem)", color: GOLD, lineHeight: 1.5,
          opacity: lineIdx >= 2 ? 1 : 0, transition: "opacity 700ms ease",
          marginBottom: 24,
        }}>
          It reveals them.
        </p>
        <p style={{
          fontFamily: "'Switzer','Inter',sans-serif", fontWeight: 400,
          fontSize: "clamp(1rem,3vw,1.2rem)", color: "rgba(255,255,255,0.75)", lineHeight: 1.6,
          opacity: lineIdx >= 3 ? 1 : 0, transition: "opacity 700ms ease",
        }}>
          Around here, effort is visible and results are public.
        </p>
      </div>

      <div style={{ position: "absolute", bottom: 56, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <GoldPillButton onClick={onNext} disabled={!canBegin} testId="tutorial-begin">
          BEGIN
        </GoldPillButton>
      </div>

      <style>{`
        @keyframes goModePulseRing {
          0%,100% { transform: scale(0.94); opacity: 0.5; }
          50%     { transform: scale(1.04); opacity: 0.9; }
        }
      `}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Chapter 2 — The 5 Tabs Tour
// ══════════════════════════════════════════════════════════════════════════
function Chapter2({ onNext, showSkip, onSkip }: { onNext: () => void; showSkip: boolean; onSkip: () => void }) {
  const [idx, setIdx] = useState(0);
  const tab = MINI_NAV[idx];

  return (
    <div style={{ ...chapterWrap, justifyContent: "flex-end", position: "relative" }}>
      {showSkip && <SkipButton onSkip={onSkip} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 28px" }}>
        <p style={{ fontSize: 10, letterSpacing: "0.24em", textTransform: "uppercase", color: GOLD_DIM, marginBottom: 18 }}>
          The 5 Tabs
        </p>
        <div key={tab.id} style={{
          background: "rgba(200,170,90,0.08)", border: `1px solid rgba(200,170,90,0.3)`,
          borderRadius: 14, padding: "20px 24px", maxWidth: 420, textAlign: "center",
          animation: "cardSlideIn 260ms cubic-bezier(0.4,0,0.2,1)",
        }}>
          <p style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.6rem", color: "#fff", marginBottom: 8,
          }}>
            {tab.label}
          </p>
          <p style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", lineHeight: 1.6 }}>
            {TAB_COPY[tab.id]}
          </p>
        </div>
      </div>

      <ProgressDots total={5} current={idx} />

      {/* Mini nav mock */}
      <div style={{
        display: "flex", borderTop: "1px solid rgba(200,170,90,0.2)",
        background: "linear-gradient(180deg,#0c0c0c 0%,#080808 100%)",
        padding: "10px 0 14px",
      }}>
        {MINI_NAV.map((n, i) => {
          const Icon = n.icon;
          const active = i === idx;
          return (
            <div key={n.id} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
              <div style={{
                width: n.id === "leads" && active ? 46 : 34, height: n.id === "leads" && active ? 46 : 34,
                borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: active ? "linear-gradient(135deg,#c8aa5a,#a8893a)" : "transparent",
                boxShadow: active ? "0 0 0 3px rgba(6,6,6,0.98), 0 0 16px 2px rgba(200,170,90,0.5)" : "none",
                animation: active ? "goModePulse2 1.6s ease-in-out infinite" : undefined,
                transition: "all 0.2s ease",
              }}>
                <Icon size={active ? 20 : 18} style={{ color: active ? "#0a0700" : "rgba(255,255,255,0.35)" }} />
              </div>
              <span style={{ fontSize: 9, color: active ? GOLD : "rgba(255,255,255,0.3)", fontWeight: active ? 700 : 400 }}>
                {n.label}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "center", padding: "20px 0 44px" }}>
        <GoldPillButton
          testId="tutorial-next"
          onClick={() => {
            if (idx < MINI_NAV.length - 1) setIdx(idx + 1);
            else onNext();
          }}
        >
          {idx < MINI_NAV.length - 1 ? "NEXT" : "CONTINUE"}
        </GoldPillButton>
      </div>

      <style>{`
        @keyframes goModePulse2 {
          0%,100% { box-shadow: 0 0 0 3px rgba(6,6,6,0.98), 0 0 12px 2px rgba(200,170,90,0.35); }
          50%     { box-shadow: 0 0 0 3px rgba(6,6,6,0.98), 0 0 20px 4px rgba(200,170,90,0.6); }
        }
      `}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Chapter 3 — The Rules
// ══════════════════════════════════════════════════════════════════════════
const RULES = [
  {
    title: "We keep it simple and real.",
    body: "No scripts to memorize — LPMAMAB is the checklist.",
    extra: "L — Location · P — Price · M — Motivation · A — Agent · M — Mortgage · A — Appointment · B — Buyer",
  },
  {
    title: "Lead Depot exists to remove friction.",
    body: "So you spend more time doing the few things that actually move deals forward.",
    extra: null,
  },
  {
    title: "Every action is logged.",
    body: "The system remembers. Your rank updates in real time.",
    extra: null,
  },
];

function Chapter3({ onNext, showSkip, onSkip }: { onNext: () => void; showSkip: boolean; onSkip: () => void }) {
  const [expanded, setExpanded] = useState<boolean[]>([false, false, false]);
  const allExpanded = expanded.every(Boolean);

  return (
    <div style={{ ...chapterWrap, position: "relative" }}>
      {showSkip && <SkipButton onSkip={onSkip} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px" }}>
        <p style={{ fontSize: 10, letterSpacing: "0.24em", textTransform: "uppercase", color: GOLD_DIM, marginBottom: 20 }}>
          The Rules
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 480 }}>
          {RULES.map((rule, i) => {
            const isOpen = expanded[i];
            return (
              <div key={i} style={{
                background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,170,90,0.2)",
                borderRadius: 12, overflow: "hidden",
              }}>
                <button
                  data-testid={`tutorial-rule-${i}`}
                  onClick={() => setExpanded(e => e.map((v, idx) => idx === i ? true : v))}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "16px 18px", background: "none", border: "none", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 14, color: "#fff", fontWeight: 500 }}>{rule.title}</span>
                  <ChevronDown size={16} style={{
                    color: GOLD, transition: "transform 0.2s ease",
                    transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
                    flexShrink: 0, marginLeft: 10,
                  }} />
                </button>
                {isOpen && (
                  <div style={{ padding: "0 18px 16px", animation: "cardSlideIn 200ms ease" }}>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", lineHeight: 1.6, marginBottom: rule.extra ? 10 : 0 }}>
                      {rule.body}
                    </p>
                    {rule.extra && (
                      <p style={{ fontSize: 11, color: GOLD_DIM, letterSpacing: "0.03em", lineHeight: 1.7 }}>
                        {rule.extra}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center", padding: "0 0 44px" }}>
        <GoldPillButton onClick={onNext} disabled={!allExpanded} testId="tutorial-next">
          NEXT
        </GoldPillButton>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Chapter 4 — Make a Fake Dial (hands-on)
// ══════════════════════════════════════════════════════════════════════════
function Chapter4({ onNext, showSkip, onSkip }: { onNext: () => void; showSkip: boolean; onSkip: () => void }) {
  const [dialed, setDialed] = useState(false);
  const [pressed, setPressed] = useState(false);

  const handleDial = () => {
    if (dialed) return;
    setPressed(true);
    playSound("tick");
    setTimeout(() => {
      setPressed(false);
      setDialed(true);
    }, 320);
  };

  return (
    <div style={{ ...chapterWrap, position: "relative" }}>
      {showSkip && <SkipButton onSkip={onSkip} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", gap: 22 }}>
        <p style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", textAlign: "center", maxWidth: 420, lineHeight: 1.6 }}>
          {dialed
            ? "You just made your first dial. The system logged it. Now you pick an outcome."
            : "Tap the gold button. This is a practice lead — nothing will actually dial."}
        </p>

        <FakeLeadCard name="MICHAEL DEMO" address="123 Sample St, Jacksonville, FL" score={82} phone="904-555-DEMO" tag="PRACTICE LEAD" />

        <div style={{ position: "relative", marginTop: 6 }}>
          {!dialed && (
            <CalloutPill style={{ top: -46, left: "50%", transform: "translateX(-50%)" }}>
              Tap here
            </CalloutPill>
          )}
          <button
            data-testid="tutorial-fake-dial"
            onClick={handleDial}
            disabled={dialed}
            style={{
              width: 72, height: 72, borderRadius: "50%",
              background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
              border: "none", cursor: dialed ? "default" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: pressed
                ? "inset 0 3px 10px rgba(0,0,0,0.5), 0 0 0 3px rgba(6,6,6,0.98)"
                : "0 6px 24px rgba(200,170,90,0.45), 0 0 0 3px rgba(6,6,6,0.98)",
              transform: pressed ? "scale(0.92)" : "scale(1)",
              transition: "all 0.15s ease",
              animation: !dialed ? "goModePulseBtn 2s ease-in-out infinite" : undefined,
            }}
          >
            <Phone size={30} style={{ color: "#0a0700" }} />
          </button>
        </div>

        {dialed && (
          <div style={{ width: "100%", maxWidth: 380, animation: "cardSlideIn 300ms cubic-bezier(0.4,0,0.2,1)" }}>
            <p style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: GOLD_DIM, textAlign: "center", marginBottom: 10 }}>
              Pick an outcome
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {OUTCOME_TILES.slice(0, 6).map(o => {
                const Icon = o.icon;
                return (
                  <div key={o.key} style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    padding: "10px 4px", borderRadius: 10,
                    background: `${o.color}22`, border: `1px solid ${o.color}70`,
                  }}>
                    <Icon size={16} style={{ color: o.color }} />
                    <span style={{ fontSize: 9, color: o.color, fontWeight: 700, textAlign: "center" }}>{o.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "center", padding: "0 0 44px" }}>
        <GoldPillButton onClick={onNext} disabled={!dialed} testId="tutorial-next">
          NEXT
        </GoldPillButton>
      </div>

      <style>{`
        @keyframes goModePulseBtn {
          0%,100% { box-shadow: 0 6px 24px rgba(200,170,90,0.45), 0 0 0 3px rgba(6,6,6,0.98); }
          50%     { box-shadow: 0 6px 32px rgba(200,170,90,0.7), 0 0 0 4px rgba(6,6,6,0.98); }
        }
        @keyframes calloutBob {
          0%,100% { transform: translateX(-50%) translateY(0); }
          50%     { transform: translateX(-50%) translateY(-5px); }
        }
      `}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Chapter 5 — Outcomes Explained
// ══════════════════════════════════════════════════════════════════════════
function Chapter5({ onNext, showSkip, onSkip }: { onNext: () => void; showSkip: boolean; onSkip: () => void }) {
  const [tapped, setTapped] = useState<boolean[]>(OUTCOME_TILES.map(() => false));
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(45);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allTapped = tapped.every(Boolean);

  useEffect(() => {
    const interval = setInterval(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(interval);
  }, []);

  const handleTap = (i: number) => {
    if (tapped[i]) return;
    setActiveIdx(i);
    setTapped(t => t.map((v, idx) => idx === i ? true : v));
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    advanceTimer.current = setTimeout(() => setActiveIdx(null), 2000);
  };

  const unlocked = allTapped || secondsLeft <= 0;

  return (
    <div style={{ ...chapterWrap, position: "relative" }}>
      {showSkip && <SkipButton onSkip={onSkip} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", gap: 18 }}>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", textAlign: "center" }}>
          Tap each tile to reveal what it means.
        </p>

        <FakeLeadCard name="MICHAEL DEMO" address="123 Sample St, Jacksonville, FL" score={82} phone="904-555-DEMO" tag="PRACTICE LEAD" />

        <div style={{ width: "100%", maxWidth: 380 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {OUTCOME_TILES.map((o, i) => {
              const Icon = o.icon;
              const isActive = activeIdx === i;
              const done = tapped[i];
              return (
                <button
                  key={o.key}
                  data-testid={`tutorial-outcome-${o.key}`}
                  onClick={() => handleTap(i)}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    padding: "12px 4px", borderRadius: 10, cursor: "pointer",
                    background: isActive ? `${o.color}44` : done ? `${o.color}18` : `${o.color}22`,
                    border: `1px solid ${isActive ? o.color : `${o.color}70`}`,
                    boxShadow: isActive ? `0 0 18px ${o.color}66` : "none",
                    transition: "all 0.2s ease",
                  }}
                >
                  <Icon size={17} style={{ color: o.color }} />
                  <span style={{ fontSize: 9, color: o.color, fontWeight: 700, textAlign: "center" }}>{o.label}</span>
                </button>
              );
            })}
          </div>
          {activeIdx !== null && (
            <div style={{
              marginTop: 12, padding: "12px 14px", borderRadius: 10,
              background: "rgba(255,255,255,0.05)", border: `1px solid ${OUTCOME_TILES[activeIdx].color}55`,
              animation: "cardSlideIn 200ms ease",
            }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: OUTCOME_TILES[activeIdx].color, marginBottom: 4 }}>
                {OUTCOME_TILES[activeIdx].label}
              </p>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", lineHeight: 1.5 }}>
                {OUTCOME_TILES[activeIdx].desc}
              </p>
            </div>
          )}
          {!allTapped && (
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", textAlign: "center", marginTop: 10, letterSpacing: "0.05em" }}>
              tap tile to reveal · {OUTCOME_TILES.filter((_, i) => !tapped[i]).length} left
            </p>
          )}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center", padding: "0 0 44px" }}>
        <GoldPillButton onClick={onNext} disabled={!unlocked} testId="tutorial-next">
          NEXT
        </GoldPillButton>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Chapter 6 — Set an Appointment + Celebration (hands-on)
// ══════════════════════════════════════════════════════════════════════════
const APPT_STAGES = ["Hot Prospect", "Active", "Nurture"] as const;

function Chapter6({ onNext, showSkip, onSkip }: { onNext: () => void; showSkip: boolean; onSkip: () => void }) {
  const [showModal, setShowModal] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [showContinue, setShowContinue] = useState(false);

  const tomorrow = new Date(Date.now() + 86400000);
  const tomorrowStr = tomorrow.toLocaleDateString("en-US", { month: "long", day: "numeric" });

  const handleSave = () => {
    setSaved(true);
    setShowModal(false);
    setShowCelebration(true);
    playSound("chime");
    setTimeout(() => playSound("lift"), 250);
    setTimeout(() => setShowContinue(true), 2000);
  };

  return (
    <div style={{ ...chapterWrap, position: "relative" }}>
      {showSkip && !showCelebration && <SkipButton onSkip={onSkip} />}

      {!showCelebration ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", gap: 20 }}>
          <p style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", textAlign: "center", maxWidth: 420 }}>
            This one wants to sell. Let's set an appointment.
          </p>

          <FakeLeadCard name="SARAH SAMPLE" address="456 Practice Dr, Fernandina Beach" score={91} phone="904-555-SARA" tag="PRACTICE LEAD" />

          <div style={{ position: "relative", width: "100%", maxWidth: 380 }}>
            {!showModal && (
              <CalloutPill style={{ top: -38, left: "50%", transform: "translateX(-50%)" }}>
                Tap Appt Set
              </CalloutPill>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 30 }}>
              {OUTCOME_TILES.slice(0, 5).map(o => {
                const Icon = o.icon;
                return (
                  <div key={o.key} style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    padding: "10px 4px", borderRadius: 10,
                    background: `${o.color}18`, border: `1px solid ${o.color}55`, opacity: 0.5,
                  }}>
                    <Icon size={15} style={{ color: o.color }} />
                    <span style={{ fontSize: 9, color: o.color, fontWeight: 700 }}>{o.label}</span>
                  </div>
                );
              })}
              <button
                data-testid="tutorial-appt-set"
                onClick={() => setShowModal(true)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  padding: "10px 4px", borderRadius: 10, cursor: "pointer",
                  background: "rgba(34,197,94,0.28)", border: "1px solid rgba(34,197,94,0.7)",
                  animation: "apptTilePulse 1.6s ease-in-out infinite",
                }}
              >
                <CheckCircle2 size={17} style={{ color: "rgb(134,239,172)" }} />
                <span style={{ fontSize: 9, color: "rgb(134,239,172)", fontWeight: 700 }}>Appt Set</span>
              </button>
            </div>
          </div>

          {showModal && (
            <div style={{
              position: "fixed", inset: 0, zIndex: 110,
              background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)",
              display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
            }}>
              <div style={{
                width: "100%", maxWidth: 400, maxHeight: "85vh", overflowY: "auto",
                background: "linear-gradient(160deg,#141414 0%,#0c0c0c 100%)",
                border: "1px solid rgba(34,197,94,0.4)", borderRadius: 16, padding: "22px 20px",
                animation: "cardSlideIn 220ms ease",
              }}>
                <p style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgb(134,239,172)", marginBottom: 16, fontWeight: 700 }}>
                  Appointment Set
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20, fontSize: 13 }}>
                  <FakeField label="Email" value="sarah@example.com" />
                  <FakeField label="Address" value="456 Practice Dr, Fernandina Beach, FL" />
                  <FakeField label="Date" value={tomorrowStr} />
                  <FakeField label="Time" value="3:00 PM" />
                  <FakeField label="Stage" value="Ready to List" />
                  <FakeField label="Intention" value="Sell — motivated" />
                  <FakeField label="Source" value="Practice lead" />
                </div>
                <button
                  data-testid="tutorial-appt-save"
                  onClick={handleSave}
                  style={{
                    width: "100%", padding: "14px", borderRadius: 8,
                    background: "linear-gradient(135deg,#22c55e 0%,#16a34a 100%)",
                    border: "none", color: "#052e11", fontWeight: 700, fontSize: 13,
                    letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(4,4,4,0.97)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 24, textAlign: "center",
        }}>
          {/* Gold shimmer sweep */}
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(100deg, transparent 30%, rgba(200,170,90,0.35) 50%, transparent 70%)",
            backgroundSize: "250% 100%",
            animation: "apptShimmerSweep 400ms ease-out",
            pointerEvents: "none",
          }} />
          <Confetti duration={2500} />
          <p style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 500,
            fontSize: "clamp(1.8rem,6vw,2.6rem)", color: GOLD, marginBottom: 14,
            letterSpacing: "0.01em", position: "relative", zIndex: 3,
          }}>
            THAT'S A COMMISSION IN MOTION.
          </p>
          <p style={{
            fontSize: 14, color: "rgba(255,255,255,0.7)", maxWidth: 420, lineHeight: 1.6,
            marginBottom: 32, position: "relative", zIndex: 3,
          }}>
            This is what pays for the truck, the vacation, and everything that matters.
          </p>
          {showContinue && (
            <div style={{ position: "relative", zIndex: 3, animation: "cardSlideIn 300ms ease" }}>
              <GoldPillButton onClick={onNext} testId="tutorial-next">
                CONTINUE
              </GoldPillButton>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes apptTilePulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(34,197,94,0.5); }
          50%     { box-shadow: 0 0 0 6px rgba(34,197,94,0); }
        }
        @keyframes apptShimmerSweep {
          from { background-position: 150% 0; }
          to   { background-position: -100% 0; }
        }
      `}</style>
    </div>
  );
}

function FakeField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: GOLD_DIM, marginBottom: 3 }}>{label}</p>
      <div style={{
        padding: "9px 12px", borderRadius: 7,
        background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
        color: "rgba(255,255,255,0.85)", fontSize: 13,
      }}>
        {value}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Chapter 7 — Finish
// ══════════════════════════════════════════════════════════════════════════
function Chapter7({ onFinish, showSkip, onSkip }: { onFinish: () => void; showSkip: boolean; onSkip: () => void }) {
  const [lineIdx, setLineIdx] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setLineIdx(1), 400);
    const t2 = setTimeout(() => setLineIdx(2), 1200);
    const t3 = setTimeout(() => setLineIdx(3), 2000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <div style={{ ...chapterWrap, alignItems: "center", justifyContent: "center", position: "relative" }}>
      {showSkip && <SkipButton onSkip={onSkip} />}

      <div style={{ textAlign: "center", padding: "0 32px", maxWidth: 520 }}>
        <p style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 400,
          fontSize: "clamp(1.5rem,5vw,2rem)", color: "#fff", marginBottom: 8,
          opacity: lineIdx >= 1 ? 1 : 0, transition: "opacity 900ms ease",
        }}>
          You're ready.
        </p>
        <p style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 400,
          fontSize: "clamp(1.5rem,5vw,2rem)", color: "rgba(255,255,255,0.85)", marginBottom: 8,
          opacity: lineIdx >= 2 ? 1 : 0, transition: "opacity 900ms ease",
        }}>
          Show up. Hustle. Process leads.
        </p>
        <p style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 600,
          fontSize: "clamp(1.9rem,6.5vw,2.6rem)", color: GOLD, marginBottom: 40,
          opacity: lineIdx >= 3 ? 1 : 0, transition: "opacity 900ms ease",
        }}>
          The Watson Brothers Way.
        </p>

        <div style={{ opacity: lineIdx >= 3 ? 1 : 0, transition: "opacity 900ms ease" }}>
          <GoldPillButton onClick={onFinish} testId="tutorial-finish">
            TAKE ME TO MY FIRST REAL LEAD
          </GoldPillButton>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 18 }}>
            P.S. — Sounds are off by default. Toggle them on in Profile if you want them.
          </p>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Main TutorialFlow
// ══════════════════════════════════════════════════════════════════════════
const TOTAL_CHAPTERS = 7;

export default function TutorialFlow({ isFirstTime, onComplete }: { isFirstTime: boolean; onComplete: () => void }) {
  const [chapter, setChapter] = useState(0); // 0-indexed, 0..6

  // v14.81 — Force sounds on for the whole tutorial (celebration must always
  // sing) even if the agent has sound effects off. Restore preference on unmount.
  useEffect(() => {
    forceTutorialSounds(true);
    return () => forceTutorialSounds(false);
  }, []);

  const finish = async () => {
    try {
      await apiRequest("POST", "/api/agent/complete-tutorial", {});
    } catch { /* best-effort — don't block the agent from entering the app */ }
    onComplete();
  };

  // First-time: no skip button anywhere. Rewatch: skip shown on Chapters 2-7
  // (Chapter 1 never has skip, either way — it's only 45s).
  const showSkip = !isFirstTime;

  const next = () => setChapter(c => Math.min(c + 1, TOTAL_CHAPTERS - 1));

  return (
    <div data-testid="tutorial-flow" style={{ position: "fixed", inset: 0, zIndex: 100 }}>
      <div style={{ position: "absolute", bottom: 12, left: 0, right: 0, zIndex: 101, pointerEvents: "none" }}>
        <ProgressDots total={TOTAL_CHAPTERS} current={chapter} />
      </div>

      {chapter === 0 && <Chapter1 onNext={next} />}
      {chapter === 1 && <Chapter2 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 2 && <Chapter3 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 3 && <Chapter4 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 4 && <Chapter5 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 5 && <Chapter6 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 6 && <Chapter7 onFinish={finish} showSkip={showSkip} onSkip={finish} />}
    </div>
  );
}
