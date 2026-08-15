/**
 * TutorialFlow — v16.7
 * Fullscreen fixed overlay (z-index 100), dark canvas background matching
 * the app. Cinematic + hands-on onboarding experience.
 *
 * v16.7 changes vs v15.x:
 *   - 8 chapters (was 7). New Ch 6.5 = Keep in Touch celebration.
 *     Matches the grand-celebration + gold shimmer an agent sees in prod.
 *   - New Ch 7 = The Team Pot + Champion's Bonus. Teaches the pre-filled
 *     $250 floor, the 10/20/30 ladder to $1,000, and the $100–$500 flat
 *     Champion's Bonus brackets.
 *   - Rewrote Ch 5 outcome descriptions to match current app: Owner–No
 *     Answer (never say "voicemail"), Recycle explicitly labeled as the
 *     Callback successor, Not a Working Line side effects called out.
 *   - Ch 3 rules updated: Pipeline persistence promise added, On-Air 5-tier
 *     card kept, offline-tap-queue promise added ("Nothing gets lost").
 *   - Ch 2 tab copy updated for the current 5-tab bottom nav order.
 *
 * Triggered from App.tsx when an agent's tutorialCompletedAt is NULL
 * (first login) or after "Replay tutorial" from Profile (rewatch).
 *
 * Alex's culture lines used verbatim throughout:
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
  CheckCircle2, Home, Award, Coins, Sparkles, Target,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { playSound, forceTutorialSounds } from "@/lib/sounds";
import Confetti from "./Confetti";

// ─── Shared visual tokens (matches app's dark-gold theme) ────────────────────
const GOLD = "#c8aa5a";
const GOLD_DIM = "rgba(200,170,90,0.55)";

// v14.10 — Mobile-safe chapter container.
//
// Previous version used `position: fixed, inset: 0, overflow: hidden` which
// worked fine on desktop but broke on iPhone Safari because:
//   1. `inset: 0` uses viewport height, but Safari's URL bar eats ~90px of
//      space when scrolled/idle, compressing content into an overlap zone.
//   2. `overflow: hidden` clipped the BEGIN button and Skip/Next controls
//      off the bottom of the screen with no way to recover.
//   3. Vertically-centered text + absolutely-positioned button collided on
//      short viewports (see the Alex Watson 2026-07-10 screenshot: BEGIN
//      button sat on top of "It reveals them.").
//
// Fix: use `100dvh` (dynamic viewport height — collapses correctly under
// Safari's URL bar) with `overflow-y: auto` as a safety net. Chapters can
// scroll on short viewports instead of clipping/overlapping.
const chapterWrap: React.CSSProperties = {
  position: "fixed", top: 0, left: 0, right: 0,
  width: "100vw", height: "100dvh", minHeight: "100dvh",
  zIndex: 100,
  background: "#080808",
  fontFamily: "'Switzer','Inter',sans-serif",
  display: "flex", flexDirection: "column",
  overflowY: "auto", overflowX: "hidden",
  WebkitOverflowScrolling: "touch",
};

// Mini nav icon config — mirrors AgentView's NAV array exactly.
// v19.0 — MINI_NAV mirrors the real bottom nav (see AgentView NAV constant).
// Order: Home / Pipeline / Lead Gen[+] / Challenges / Profile. The old
// Dashboard/Referrals/Dial trio was retired in v17.2–v18.4.
const MINI_NAV = [
  { id: "home",       label: "Home",       icon: Home },
  { id: "pipeline",   label: "Pipeline",   icon: Layers },
  { id: "leads",      label: "Lead Gen",   icon: Phone },
  { id: "challenges", label: "Challenges", icon: Target },
  { id: "profile",    label: "Profile",    icon: UserCircle2 },
] as const;

const TAB_COPY: Record<string, string> = {
  // v19.0 — copy rewritten to match the current 5-tab nav. Home replaces the
  // old Dashboard slot, Challenges replaces Referrals (referrals fold into the
  // yellow radial chooser on the Lead Gen [+] button), and Pipeline now has a
  // Kanban / List toggle.
  home:       "Your dashboard: live team leaderboard, Team Pot progress toward the $1,000 monthly pool, the ON AIR / Prime Time banner, and today's dial count. Toggle to the anonymized Team Map to see where BGRE is on the ground across NE Florida. Effort is visible — the standings update the moment someone logs an outcome.",
  pipeline:   "Every lead you personally moved forward — Lead, Contacted, Nurture, Hot, Appt Set, Client Active. Toggle List or Kanban view. This never gets pulled back to the pool. Ever. Boot to boot, month to month, it stays yours.",
  leads:      "The gold [+] button. Tap it and pick your leg: Dial, Open House, Door Knock, Direct Mail, or Network Referral. Every action is receipted — offline or online, no dial ever gets lost. This is where the money gets made.",
  challenges: "Daily and weekly challenges. Hit them to earn bonus points, unlock the Diversity Challenge streak, and stack toward the Champion's Bonus. Accept the ones that fit your day; claim gated ones with evidence.",
  profile:    "Your headshot, rank, sound preferences, Prime Time alert opt-in, and settings. Also where you replay this tutorial.",
};

// v15.0 — Tutorial OUTCOME_TILES now mirrors AgentView's OUTCOMES array
// EXACTLY (same 9 tiles, same order, same colors). This is the production
// 3x3 grid an agent sees the moment they exit the tutorial. Keeping the
// two in sync prevents the drift Alex caught in IMG_9283/9284/9285 (tutorial
// showed 7 tiles in the wrong order; the real app has 9 in a different
// order).
//
// Grid position mapping (0-indexed, row-major):
//   [0] No Answer     [1] Wrong #       [2] Disconnected
//   [3] Not Interest. [4] Recycle       [5] Listed
//   [6] Appt Set      [7] Keep in Touch [8] Left VM
//
// If AgentView's OUTCOMES ever changes, this array MUST change too. There's
// no runtime import because the tutorial's tile spec (icon + color + desc)
// diverges from AgentView's (bg/border/hoverBg) — they're intentionally
// separate types, but the labels/keys/order/positions are contract.
const OUTCOME_TILES = [
  // v16.7 — descriptions rewritten for current app behavior:
  //   • Owner–No Answer: never say "voicemail." This is confirmed-owner intel.
  //   • Recycle spelled out as the Callback successor (Callback is retired).
  //   • Keep in Touch calls out permanent Pipeline placement + celebration.
  //   • Appt Set calls out Pipeline + FUB Meet & Greet + celebration.
  //   • Not a Working Line calls out phone-line-removal side effect.
  //   • Listed calls out that lead stays out until listing expires.
  // Row 1 — fast per-line taps (what you tap FOR THIS PHONE NUMBER)
  { key: "no_answer",                label: "No Answer",     icon: PhoneMissed,   color: "#facc15", desc: "They didn't pick up. Lead goes back to the pool for someone else to try." },
  { key: "wrong_number",             label: "Wrong #",       icon: AlertTriangle, color: "#f87171", desc: "Not the person we're looking for. Lead is removed. Move on." },
  { key: "disconnected",             label: "Not a Working Line", icon: PhoneOff,   color: "#cbd5e1", desc: "Line is dead — no ring, nonstop tone, or 'not in service.' The system drops this number from the lead's phone list so no one calls it again." },
  // Row 2 — lead-level decisions (what you tap FOR THIS LEAD)
  { key: "contacted_not_interested", label: "Not Interested",icon: XCircle,       color: "#fca5a5", desc: "A real 'no.' We respect it. Lead is closed out." },
  { key: "recycled",                 label: "Recycle",       icon: RefreshCw,     color: "#67e8f9", desc: "Called them, revisit later. This replaces the old Callback — lead returns to the pool with no owner and no strings, so anyone can grab it next time." },
  { key: "listed",                   label: "Listed",        icon: Home,          color: "#c4b5fd", desc: "They already re-listed with another agent. Lead is paused until the listing expires, then re-enters the pool." },
  // Row 3 — wins
  { key: "contacted_appointment",    label: "Appt Set",      icon: CheckCircle2,  color: "#86efac", desc: "The green one. Appointment on the books — confetti fires, FUB Meet & Greet is pushed, and the lead is pinned to your Pipeline forever." },
  { key: "keep_in_touch",            label: "Keep in Touch", icon: Heart,         color: "#f9a8d4", desc: "Interested but not ready. Gold-shimmer celebration fires and the lead is yours — permanent Pipeline entry, no timeout, no pool-return." },
  { key: "left_voicemail",           label: "Owner - No Answer", icon: PhoneOff, color: "#93c5fd", desc: "You confirmed the owner picks up on this line but didn't answer today. The app strikes every other number on the lead, recycles it to the FRONT of the pool, and awards +6 points. This is NOT a voicemail — it's confirmed-owner intel." },
] as const;

// v15.0 — Grid position index for Appt Set. Used by Chapter 6 to glow the
// correct tile at its real production location (Row 3 Col 1 = index 6).
const APPT_SET_IDX = 6;

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

  // v14.10 — Rebuilt as a proper 3-row flex layout so the BEGIN button can
  // never overlap the text on short viewports (see IMG_9282 iPhone report).
  // Row 1: flex-grow spacer w/ decorative rings. Row 2: the cinematic copy.
  // Row 3: BEGIN button with reserved space. All three fit in a scrollable
  // container thanks to the new chapterWrap.
  return (
    <div style={{ ...chapterWrap, alignItems: "stretch", position: "relative" }}>
      {/* Subtle animated gold ring pulse — decorative only, doesn't affect layout */}
      <div style={{
        position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: 500, height: 500, borderRadius: "50%",
        border: `1px solid rgba(200,170,90,0.15)`,
        animation: "goModePulseRing 3.2s ease-in-out infinite",
        pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: 340, height: 340, borderRadius: "50%",
        border: `1px solid rgba(200,170,90,0.12)`,
        animation: "goModePulseRing 3.2s ease-in-out infinite 0.4s",
        pointerEvents: "none",
      }} />

      {/* Copy — centered vertically inside a flex-grow region */}
      <div style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        padding: "48px 32px 24px", minHeight: 0,
      }}>
        <div style={{ textAlign: "center", maxWidth: 560, position: "relative", zIndex: 2 }}>
          <p style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 400,
            fontSize: "clamp(1.4rem,5vw,2.2rem)", color: "#fff", lineHeight: 1.5,
            opacity: lineIdx >= 1 ? 1 : 0, transition: "opacity 700ms ease",
            marginBottom: 4, marginTop: 0,
          }}>
            Lead Depot doesn't create producers.
          </p>
          <p style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 500,
            fontSize: "clamp(1.4rem,5vw,2.2rem)", color: GOLD, lineHeight: 1.5,
            opacity: lineIdx >= 2 ? 1 : 0, transition: "opacity 700ms ease",
            marginBottom: 24, marginTop: 0,
          }}>
            It reveals them.
          </p>
          <p style={{
            fontFamily: "'Switzer','Inter',sans-serif", fontWeight: 400,
            fontSize: "clamp(0.95rem,3vw,1.2rem)", color: "rgba(255,255,255,0.75)", lineHeight: 1.6,
            opacity: lineIdx >= 3 ? 1 : 0, transition: "opacity 700ms ease",
            marginTop: 0, marginBottom: 0,
          }}>
            Around here, effort is visible and results are public.
          </p>
        </div>
      </div>

      {/* BEGIN button — always in its own row at the bottom, never overlapping copy */}
      <div style={{
        flexShrink: 0, display: "flex", justifyContent: "center",
        padding: "20px 0 max(44px, env(safe-area-inset-bottom))",
        position: "relative", zIndex: 3,
      }}>
        <GoldPillButton onClick={onNext} disabled={!canBegin} testId="tutorial-begin">
          BEGIN
        </GoldPillButton>
      </div>

      <style>{`
        @keyframes goModePulseRing {
          0%,100% { transform: translate(-50%,-50%) scale(0.94); opacity: 0.5; }
          50%     { transform: translate(-50%,-50%) scale(1.04); opacity: 0.9; }
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
    body: "No scripts to memorize — LPMAMA / CPMAMA / LPMA is the checklist. Say hi like a human, then walk it.",
    extra: "LPMAMA (buyer): Location · Price · Motivation · Agent · Mortgage · Appointment —— CPMAMA (seller): Condition · Price · Motivation · Agent · Mortgage · Appointment —— LPMA (renter): Location · Price · Motivation · Appointment",
  },
  {
    title: "Lead Depot exists to remove friction.",
    body: "Leads, scripts, dial priority, follow-up — the app handles it. Your job is the conversation.",
    extra: null,
  },
  {
    title: "Every action is logged.",
    body: "Dials, contacts, appointments — all counted in real time. Your rank on the Leaderboard updates instantly.",
    extra: null,
  },
  {
    // v16.7 — Pipeline permanence promise. Alex's non-negotiable: pipeline
    // and points cannot disappear between reset, boot, or deploy.
    title: "Your Pipeline stays yours.",
    body: "Every KIT and Appt Set you log gets pinned to your Pipeline tab — permanent, boot to boot, month to month. Monthly leaderboard resets don't touch it. Nothing here ever falls back into the shared pool.",
    extra: null,
  },
  {
    // v16.7 — Offline safety. Every outcome tap carries a UUID and is
    // persisted to localStorage before the request leaves the phone.
    title: "Nothing gets lost.",
    body: "Every outcome tap is receipted. If you're offline or the network hiccups, the tap sits safely on your phone and syncs the moment you're back — no dial ever disappears, no point ever gets counted twice.",
    extra: null,
  },
  {
    // v15.11.17 — On-Air banner + 5-tier call heat.
    title: "Call when the light is right.",
    body: "The banner at the top of the app is your On-Air light. It reads the day and hour and tells you what kind of dialing time this is — there are five tiers.",
    extra: "PRIME (red) — go now · MID (amber) — solid · LOW (yellow) — slow, confirm to dial · DOWN (grey) — poor odds, confirm to dial · TCPA BLOCK (dark) — illegal to call, hard-blocked.",
  },
  {
    title: "We're a well-oiled machine.",
    body: "All hands on deck. Everyone has a role. Your job on any given dial is simple — run the play, log the outcome, move to the next one. The system does the rest.",
    extra: null,
  },
];

function Chapter3({ onNext, showSkip, onSkip }: { onNext: () => void; showSkip: boolean; onSkip: () => void }) {
  // v14.81 — 4 rule cards now (was 3). NEXT unlocks only after all 4 expanded.
  const [expanded, setExpanded] = useState<boolean[]>(RULES.map(() => false));
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
            {/* v15.0 — all 9 real production tiles in real order (was showing */}
            {/* only the first 6, in the wrong order — IMG_9283 regression). */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {OUTCOME_TILES.map(o => {
                const Icon = o.icon;
                return (
                  <div key={o.key} style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                    padding: "9px 3px", borderRadius: 10,
                    background: `${o.color}22`, border: `1px solid ${o.color}70`,
                  }}>
                    <Icon size={14} style={{ color: o.color }} />
                    <span style={{ fontSize: 9, color: o.color, fontWeight: 700, textAlign: "center", lineHeight: 1.1 }}>{o.label}</span>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textAlign: "center", marginTop: 10, letterSpacing: "0.03em", lineHeight: 1.5 }}>
              This is the exact grid you'll see under every dial.
            </p>
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
  // v15.0 — rewritten to Alex's Option B spec (IMG_9284 report). The prior
  // version presented a "tap each tile to reveal" mini-game with only 7 of
  // the 9 real outcomes, in the wrong grid positions. Agents finished the
  // tutorial, hit Dial, and saw a completely different 3×3 layout.
  //
  // This version is static: renders the real production 3×3 grid in the
  // real production order, then shows every outcome's meaning in a list
  // below. No interactive puzzle — just read and move on.
  //
  // NEXT unlocks after a 6-second read timer (enough time to scan 9 items)
  // so agents can't blitz past the explainer, but nobody has to sit through
  // a 45-second countdown either.
  const [secondsLeft, setSecondsLeft] = useState(6);
  useEffect(() => {
    const interval = setInterval(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(interval);
  }, []);
  const unlocked = secondsLeft <= 0;

  return (
    <div style={{ ...chapterWrap, position: "relative" }}>
      {showSkip && <SkipButton onSkip={onSkip} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "32px 20px 20px", gap: 16 }}>
        <p style={{ fontSize: 10, letterSpacing: "0.24em", textTransform: "uppercase", color: GOLD_DIM, textAlign: "center" }}>
          The Outcome Grid
        </p>
        <p style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", textAlign: "center", maxWidth: 420, lineHeight: 1.5 }}>
          Every dial ends with one of these nine taps. This is exactly what you'll see under every lead.
        </p>

        {/* Static production grid — not interactive. Mirrors AgentView's */}
        {/* OUTCOMES layout: 3 rows, 3 columns, real colors, real order. */}
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {OUTCOME_TILES.map(o => {
              const Icon = o.icon;
              return (
                <div key={o.key} style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                  padding: "11px 3px", borderRadius: 10,
                  background: `${o.color}22`, border: `1px solid ${o.color}70`,
                }}>
                  <Icon size={15} style={{ color: o.color }} />
                  <span style={{ fontSize: 9, color: o.color, fontWeight: 700, textAlign: "center", lineHeight: 1.1 }}>{o.label}</span>
                </div>
              );
            })}
          </div>

          {/* Description list — one line per outcome, colored by the tile. */}
          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 8 }}>
            {OUTCOME_TILES.map(o => {
              const Icon = o.icon;
              return (
                <div key={o.key} style={{
                  display: "flex", alignItems: "flex-start", gap: 10,
                  padding: "8px 12px", borderRadius: 8,
                  background: `${o.color}0d`, border: `1px solid ${o.color}22`,
                }}>
                  <Icon size={13} style={{ color: o.color, flexShrink: 0, marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: o.color, letterSpacing: "0.02em" }}>{o.label}</span>
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginLeft: 6, lineHeight: 1.4 }}>— {o.desc}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "0 0 max(44px, env(safe-area-inset-bottom))", flexShrink: 0 }}>
        {!unlocked && (
          <p style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.05em", margin: 0 }}>
            take a moment · {secondsLeft}s
          </p>
        )}
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
            {/* v15.0 — callout pill points UP at Appt Set (Row 3 Col 1). Placed */}
            {/* below the grid so it doesn't overlap any tile above the target. */}
            {/* Left-aligned to first column so the pill and arrow both sit under */}
            {/* the Appt Set tile column. */}
            {!showModal && (
              <CalloutPill style={{
                position: "absolute", zIndex: 5,
                bottom: -34, left: "16.66%", transform: "translateX(-50%)",
              }}>
                ↑ Tap Appt Set
              </CalloutPill>
            )}
            {/* v15.0 — render the full 9-tile production grid. The 8 non-Appt- */}
            {/* Set tiles are dimmed; Appt Set at its REAL production index (6, */}
            {/* Row 3 Col 1) is the only interactive/glowing target. Previously */}
            {/* rendered only 5 dim tiles + Appt Set in slot 6 (Row 3 Col 3), */}
            {/* which did not match production and made Chapter 5 useless. */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 30 }}>
              {OUTCOME_TILES.map((o, i) => {
                const Icon = o.icon;
                const isApptSet = i === APPT_SET_IDX;
                if (isApptSet) {
                  return (
                    <button
                      key={o.key}
                      data-testid="tutorial-appt-set"
                      onClick={() => setShowModal(true)}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                        padding: "11px 3px", borderRadius: 10, cursor: "pointer",
                        background: "rgba(34,197,94,0.28)", border: "1px solid rgba(34,197,94,0.75)",
                        animation: "apptTilePulse 1.6s ease-in-out infinite",
                      }}
                    >
                      <Icon size={15} style={{ color: "rgb(134,239,172)" }} />
                      <span style={{ fontSize: 9, color: "rgb(134,239,172)", fontWeight: 700, lineHeight: 1.1 }}>Appt Set</span>
                    </button>
                  );
                }
                return (
                  <div key={o.key} style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                    padding: "11px 3px", borderRadius: 10,
                    background: `${o.color}14`, border: `1px solid ${o.color}44`, opacity: 0.45,
                  }}>
                    <Icon size={14} style={{ color: o.color }} />
                    <span style={{ fontSize: 9, color: o.color, fontWeight: 700, lineHeight: 1.1 }}>{o.label}</span>
                  </div>
                );
              })}
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
// Chapter 6.5 — Log a Keep in Touch + Celebration (NEW in v16.7)
// Mirrors Ch 6 structurally: fake lead, glowing target tile, small modal,
// then the grand-shimmer celebration that fires in production for KIT.
// This closes the gap where an agent going through onboarding never saw
// what a KIT tap looks like.
// ══════════════════════════════════════════════════════════════════════════
const KIT_TILE_IDX = 7; // Row 3 Col 2 in the 9-tile grid (keep_in_touch)

function ChapterKIT({ onNext, showSkip, onSkip }: { onNext: () => void; showSkip: boolean; onSkip: () => void }) {
  const [showModal, setShowModal] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [showContinue, setShowContinue] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setShowModal(false);
    setShowCelebration(true);
    playSound("chime");
    setTimeout(() => playSound("lift"), 250);
    setTimeout(() => setShowContinue(true), 2200);
  };

  return (
    <div style={{ ...chapterWrap, position: "relative" }}>
      {showSkip && !showCelebration && <SkipButton onSkip={onSkip} />}

      {!showCelebration ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", gap: 20 }}>
          <p style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", textAlign: "center", maxWidth: 420 }}>
            This one's interested but not ready yet. Let's Keep in Touch — permanent Pipeline entry.
          </p>

          <FakeLeadCard name="MARCUS DEMO" address="789 Nurture Ln, Jacksonville" score={76} phone="904-555-KEEP" tag="PRACTICE LEAD" />

          <div style={{ position: "relative", width: "100%", maxWidth: 380 }}>
            {!showModal && (
              <CalloutPill style={{
                position: "absolute", zIndex: 5,
                bottom: -34, left: "50%", transform: "translateX(-50%)",
              }}>
                ↑ Tap Keep in Touch
              </CalloutPill>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 30 }}>
              {OUTCOME_TILES.map((o, i) => {
                const Icon = o.icon;
                const isKit = i === KIT_TILE_IDX;
                if (isKit) {
                  return (
                    <button
                      key={o.key}
                      data-testid="tutorial-kit"
                      onClick={() => setShowModal(true)}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                        padding: "11px 3px", borderRadius: 10, cursor: "pointer",
                        background: "rgba(249,168,212,0.28)", border: "1px solid rgba(249,168,212,0.75)",
                        animation: "kitTilePulse 1.6s ease-in-out infinite",
                      }}
                    >
                      <Icon size={15} style={{ color: "rgb(249,168,212)" }} />
                      <span style={{ fontSize: 9, color: "rgb(249,168,212)", fontWeight: 700, lineHeight: 1.1 }}>Keep in Touch</span>
                    </button>
                  );
                }
                return (
                  <div key={o.key} style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                    padding: "11px 3px", borderRadius: 10,
                    background: `${o.color}14`, border: `1px solid ${o.color}44`, opacity: 0.45,
                  }}>
                    <Icon size={14} style={{ color: o.color }} />
                    <span style={{ fontSize: 9, color: o.color, fontWeight: 700, lineHeight: 1.1 }}>{o.label}</span>
                  </div>
                );
              })}
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
                border: "1px solid rgba(249,168,212,0.4)", borderRadius: 16, padding: "22px 20px",
                animation: "cardSlideIn 220ms ease",
              }}>
                <p style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgb(249,168,212)", marginBottom: 16, fontWeight: 700 }}>
                  Keep in Touch
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20, fontSize: 13 }}>
                  <FakeField label="Email" value="marcus@example.com" />
                  <FakeField label="Address" value="789 Nurture Ln, Jacksonville, FL" />
                  <FakeField label="Stage" value="Nurture — 6-12 months" />
                  <FakeField label="Intention" value="Sell eventually" />
                  <FakeField label="Source" value="Practice lead" />
                </div>
                <button
                  data-testid="tutorial-kit-save"
                  onClick={handleSave}
                  style={{
                    width: "100%", padding: "14px", borderRadius: 8,
                    background: "linear-gradient(135deg,#f9a8d4 0%,#ec4899 100%)",
                    border: "none", color: "#3b0764", fontWeight: 700, fontSize: 13,
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
          {/* Gold shimmer sweep — matches the KIT celebration in production */}
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(100deg, transparent 30%, rgba(200,170,90,0.45) 50%, transparent 70%)",
            backgroundSize: "250% 100%",
            animation: "apptShimmerSweep 500ms ease-out",
            pointerEvents: "none",
          }} />
          <Confetti duration={2600} />
          <p style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 500,
            fontSize: "clamp(1.8rem,6vw,2.6rem)", color: GOLD, marginBottom: 14,
            letterSpacing: "0.01em", position: "relative", zIndex: 3,
          }}>
            THAT'S YOURS. FOR GOOD.
          </p>
          <p style={{
            fontSize: 14, color: "rgba(255,255,255,0.7)", maxWidth: 420, lineHeight: 1.6,
            marginBottom: 32, position: "relative", zIndex: 3,
          }}>
            Every KIT gets a celebration and a permanent home in your Pipeline. Same energy as an Appt Set — because a nurture today is a commission next quarter.
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
        @keyframes kitTilePulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(249,168,212,0.5); }
          50%     { box-shadow: 0 0 0 6px rgba(249,168,212,0); }
        }
      `}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Chapter 8 (in flow) — The Team Pot (v20.7.34 ladder)
// v20.7.34: thresholds halved, floor rebased to $0. Payout stays 70/30 to
// #1 / #2. Champion's Bonus fully retired.
//   0 team appts → $0
//   1 team appt  → $250
//   5 team appts → $500
//   10 team appts → $750
//   15 team appts → $1,000
// ══════════════════════════════════════════════════════════════════════════
const POT_TIERS = [
  { appts: 1,   amount: 250,  label: "First appointment opens the pot", locked: false },
  { appts: 5,   amount: 500,  label: "Tier 1 unlock",                   locked: true  },
  { appts: 10,  amount: 750,  label: "Tier 2 unlock",                   locked: true  },
  { appts: 15,  amount: 1000, label: "Stretch — full pot",              locked: true  },
];

function ChapterTeamPot({ onNext, showSkip, onSkip }: { onNext: () => void; showSkip: boolean; onSkip: () => void }) {
  const [step, setStep] = useState(0); // 0 = ladder, 1 = champion bonus, 2 = ready

  return (
    <div style={{ ...chapterWrap, position: "relative" }}>
      {showSkip && <SkipButton onSkip={onSkip} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "36px 22px", gap: 22 }}>
        <p style={{ fontSize: 10, letterSpacing: "0.24em", textTransform: "uppercase", color: GOLD_DIM }}>
          The Team Pot
        </p>

        <p style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "clamp(1.6rem,5.5vw,2.2rem)", color: "#fff", textAlign: "center",
          maxWidth: 460, lineHeight: 1.25,
        }}>
          Everyone's shot at a monthly $1,000 pool.
        </p>

        {step === 0 && (
          <div style={{ width: "100%", maxWidth: 460, display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", textAlign: "center", lineHeight: 1.6, marginBottom: 6 }}>
              The pot starts at $0. The team's first appointment opens it at $250, then it climbs as more get booked this month:
            </p>
            {POT_TIERS.map((t, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "12px 16px", borderRadius: 10,
                background: i === 0 ? "rgba(200,170,90,0.12)" : "rgba(255,255,255,0.03)",
                border: i === 0 ? "1px solid rgba(200,170,90,0.4)" : "1px solid rgba(200,170,90,0.15)",
                animation: `cardSlideIn ${180 + i * 80}ms ease`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {i === 0 ? (
                    <Coins size={18} style={{ color: GOLD }} />
                  ) : (
                    <Sparkles size={16} style={{ color: GOLD_DIM }} />
                  )}
                  <div>
                    <p style={{ fontSize: 13, color: "#fff", fontWeight: 600 }}>
                      {typeof t.appts === "number" ? `${t.appts} team appts` : t.appts}
                    </p>
                    <p style={{ fontSize: 11, color: GOLD_DIM, marginTop: 2 }}>{t.label}</p>
                  </div>
                </div>
                <p style={{
                  fontFamily: "'Cormorant Garamond','Georgia',serif",
                  fontSize: 22, color: GOLD, fontWeight: 600,
                }}>
                  ${t.amount.toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}

        {step === 1 && (
          <div style={{ width: "100%", maxWidth: 460, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ textAlign: "center" }}>
              <Award size={32} style={{ color: GOLD, margin: "0 auto 6px" }} />
              <p style={{ fontSize: 16, color: "#fff", fontWeight: 600, marginBottom: 6 }}>
                Top 2 split the pot
              </p>
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.6 }}>
                At end of month, the top 2 agents on monthly points split the pot. #1 takes 70%, #2 takes 30%. Everyone else takes home the appointments they set.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
              <div style={{
                padding: "18px 14px", borderRadius: 12,
                background: "rgba(200,170,90,0.14)",
                border: "1px solid rgba(200,170,90,0.45)",
                textAlign: "center",
              }}>
                <p style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: GOLD_DIM, marginBottom: 6 }}>
                  #1 — 70%
                </p>
                <p style={{
                  fontFamily: "'Cormorant Garamond','Georgia',serif",
                  fontSize: 28, color: GOLD, fontWeight: 600,
                }}>
                  Up to $700
                </p>
              </div>
              <div style={{
                padding: "18px 14px", borderRadius: 12,
                background: "rgba(200,170,90,0.06)",
                border: "1px solid rgba(200,170,90,0.25)",
                textAlign: "center",
              }}>
                <p style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: GOLD_DIM, marginBottom: 6 }}>
                  #2 — 30%
                </p>
                <p style={{
                  fontFamily: "'Cormorant Garamond','Georgia',serif",
                  fontSize: 28, color: GOLD, fontWeight: 600,
                }}>
                  Up to $300
                </p>
              </div>
            </div>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", textAlign: "center", lineHeight: 1.5, marginTop: 4 }}>
              Requires ≥1 monthly appt to be eligible for a split.
            </p>
          </div>
        )}

        {step === 2 && (
          <p style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", textAlign: "center", maxWidth: 440, lineHeight: 1.7 }}>
            Every appointment YOU set moves the team pot forward and puts you in the running for the split. Top 2 eat.
          </p>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "center", padding: "0 0 44px" }}>
        <GoldPillButton
          testId="tutorial-next"
          onClick={() => {
            if (step < 2) setStep(step + 1);
            else onNext();
          }}
        >
          {step < 2 ? "NEXT" : "I'M IN"}
        </GoldPillButton>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Chapter 9 (in flow) — Finish
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
// v16.7 — 9 chapters (was 7). Added ChapterKIT (index 6) and ChapterTeamPot
// (index 7); the original Chapter7 (Finish) shifted to index 8.
const TOTAL_CHAPTERS = 9;

export default function TutorialFlow({ isFirstTime, onComplete }: { isFirstTime: boolean; onComplete: () => void }) {
  const [chapter, setChapter] = useState(0); // 0-indexed, 0..8

  // v14.81 — Force sounds on for the whole tutorial (celebration must always
  // sing) even if the agent has sound effects off. Restore preference on unmount.
  useEffect(() => {
    forceTutorialSounds(true);
    return () => forceTutorialSounds(false);
  }, []);

  const finish = async () => {
    // v15.11.7 — Persist to server FIRST. Only call onComplete (which flips
    // local state to "completed") if the server actually saved it. Prior
    // versions swallowed the error and marked completed only in localStorage,
    // so every fresh login refetched a NULL tutorial_completed_at and the
    // agent had to re-watch. Retry once on transient failure.
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      try {
        const r = await apiRequest("POST", "/api/agent/complete-tutorial", {});
        if (r?.ok !== false) saved = true;
      } catch (e) {
        if (attempt === 1) console.warn("[TutorialFlow] persist failed after 2 attempts:", e);
        await new Promise(res => setTimeout(res, 800));
      }
    }
    if (!saved) {
      // Fall through anyway — don't wall the agent off from the app. The
      // next login the tutorial will fire again, but at least they can work.
      console.error("[TutorialFlow] tutorial completion NOT persisted server-side. Agent will re-watch next login.");
    }
    onComplete();
  };

  // First-time: no skip button anywhere. Rewatch: skip shown on Chapters 2-7
  // (Chapter 1 never has skip, either way — it's only 45s).
  const showSkip = !isFirstTime;

  const next = () => setChapter(c => Math.min(c + 1, TOTAL_CHAPTERS - 1));

  return (
    <div data-testid="tutorial-flow" style={{ position: "fixed", inset: 0, zIndex: 100 }}>
      {/* v14.10 — ProgressDots overlay respects iPhone home-indicator safe area
          so it doesn't collide with the tap target of BEGIN/NEXT/FINISH. */}
      <div style={{
        position: "absolute",
        bottom: "max(4px, env(safe-area-inset-bottom))",
        left: 0, right: 0, zIndex: 101, pointerEvents: "none",
      }}>
        <ProgressDots total={TOTAL_CHAPTERS} current={chapter} />
      </div>

      {chapter === 0 && <Chapter1 onNext={next} />}
      {chapter === 1 && <Chapter2 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 2 && <Chapter3 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 3 && <Chapter4 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 4 && <Chapter5 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 5 && <Chapter6 onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 6 && <ChapterKIT onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 7 && <ChapterTeamPot onNext={next} showSkip={showSkip} onSkip={finish} />}
      {chapter === 8 && <Chapter7 onFinish={finish} showSkip={showSkip} onSkip={finish} />}
    </div>
  );
}
