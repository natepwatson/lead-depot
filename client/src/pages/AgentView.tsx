import React, { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Phone, PhoneMissed, PhoneOff, XCircle,
  CheckCircle2, AlertTriangle, MapPin, Mail, LogOut,
  TrendingUp, ChevronLeft, ChevronDown,
  Trophy, Users, Send, UserPlus, Heart,
  RefreshCw, Briefcase, Clock, PhoneCall, Star, UserCircle2,
  Home, Voicemail, Layers, Calendar,
} from "lucide-react";
import ProfilePage from "./ProfilePage";
import ConfettiCelebration from "../components/ld/ConfettiCelebration";
import { RankTrophy } from "../components/ld/RankTrophy";
import { playSound } from "@/lib/sounds";
import { hapticApptSet, hapticKit } from "@/lib/haptics";
import AnimatedNumber from "../components/AnimatedNumber";
import { computeCallHeat } from "@/lib/callHeat";
import type { Lead as LeadRow } from "@shared/schema";

// v14.81 — myAttemptsToday is a synthetic field the server attaches on top of
// the real lead row (see server/routes.ts countMyAttemptsToday call sites) —
// it's never a DB column, so it doesn't belong in shared/schema.ts's Drizzle-
// inferred Lead type. Extend it locally so LeadCard can read it type-safely.
type Lead = LeadRow & { myAttemptsToday?: number };

// ─── LPMAMA fields config ─────────────────────────────────────────────────────
// v14.56 — removed dead LogoIcon component (last usage stripped in v14.54 header cleanup).
// v14.20 — split into SELLER (6 fields, drops the buyer catch-all) and BUYER (5 fields,
// only shown when the seller says they're also buying). The Buyer LPMAMA is the whole
// point of the redesign: we can now give buyer-side service without cramming it into
// a single text field.
const SELLER_LPMAMA_FIELDS = [
  // v14.53 — was L Location; now C Condition (same db col l_location, preserved data)
  { key: "location",    label: "C — Condition",   color: "#c8aa5a", hint: "What condition is the property in? Updates, repairs, deferred maintenance?", leadField: "lLocation" },
  { key: "price",       label: "P — Price",       color: "#e2d5b0", hint: "What are they thinking price-wise? Ballpark only.",      leadField: "lPricePaid" },
  { key: "motivation",  label: "M — Motivation",  color: "#7ec8e3", hint: "Why are they selling? Divorce, downsizing, job move?",   leadField: "lMotivation" },
  { key: "agent",       label: "A — Agent",       color: "#a8d5a2", hint: "Are they working with an agent already?",                leadField: "lAgentHistory" },
  { key: "mortgage",    label: "M — Mortgage",    color: "#e2d5b0", hint: "Do they have a loan? Paid off? Roughly what's owed?",   leadField: "lMortgage" },
  { key: "appointment", label: "A — Appointment", color: "#c8aa5a", hint: "Are they open to a meeting? Any dates that work?",       leadField: "lAppointment" },
] as const;

const BUYER_LPMAMA_FIELDS = [
  { key: "bLocation",   label: "B-L — Location",   color: "#93c5fd", hint: "Where do they want to buy? Area / school district?",           leadField: "bLocation" },
  { key: "bPrice",      label: "B-P — Price",      color: "#93c5fd", hint: "What's their budget? Comfortable price range?",                 leadField: "bPrice" },
  { key: "bMotivation", label: "B-M — Motivation", color: "#93c5fd", hint: "Why buying? Upsizing, downsizing, first home, investment?",     leadField: "bMotivation" },
  { key: "bAgent",      label: "B-A — Agent",      color: "#93c5fd", hint: "Working with a buyer's agent already? Signed anything?",        leadField: "bAgent" },
  { key: "bMortgage",   label: "B-M — Mortgage",   color: "#93c5fd", hint: "Pre-approved? Cash? Need a lender referral?",                    leadField: "bMortgage" },
] as const;

// ─── Outcome configs ───────────────────────────────────────────────────────────
// v14.16 — 9 outcomes in a 3×3 grid.
// Row 1 (fast, per-line):     No Answer      · Wrong #        · Disconnected
// Row 2 (decision, lead-lvl): Not Interested · Recycle        · Listed
// Row 3 (wins):               Appt Set       · Keep in Touch  · Left VM
// v14.79 — Outcome tiles: brightened + fuller. Prior palette (bg 0.12, border 0.4)
// read as flat/dark against the deep card. Bumped bg to 0.22, border to 0.55, and
// added an inner sheen via linear-gradient in the render layer for dimensionality.
const OUTCOMES = [
  // Row 1 — fast per-line taps
  { key: "no_answer",               label: "No Answer",     icon: PhoneMissed,   bg: "rgba(234,179,8,0.22)",   border: "rgba(234,179,8,0.55)",    text: "rgb(253,224,71)",       hoverBg: "rgba(234,179,8,0.34)" },
  { key: "wrong_number",            label: "Wrong #",       icon: AlertTriangle, bg: "rgba(239,68,68,0.16)",   border: "rgba(239,68,68,0.40)",    text: "rgba(252,165,165,0.95)",hoverBg: "rgba(239,68,68,0.28)" },
  // v15.11.12 — Renamed "Disconnected" → "Not a Working Line". Agents were
  // confusing "disconnected" with "the call dropped mid-conversation". Backend
  // outcome key stays `disconnected` so historical activity + reports are intact.
  { key: "disconnected",            label: "Not a Working Line", icon: PhoneOff,   bg: "rgba(148,163,184,0.20)", border: "rgba(148,163,184,0.50)", text: "rgb(203,213,225)",      hoverBg: "rgba(148,163,184,0.32)" },
  // Row 2 — decision, lead-level
  { key: "contacted_not_interested",label: "Not Interested",icon: XCircle,       bg: "rgba(239,68,68,0.22)",   border: "rgba(239,68,68,0.55)",    text: "rgb(252,165,165)",      hoverBg: "rgba(239,68,68,0.34)" },
  { key: "recycled",                label: "Recycle",       icon: RefreshCw,     bg: "rgba(34,211,238,0.22)",  border: "rgba(34,211,238,0.55)",   text: "rgb(103,232,249)",      hoverBg: "rgba(34,211,238,0.34)" },
  { key: "listed",                  label: "Listed",        icon: Home,          bg: "rgba(139,92,246,0.22)",  border: "rgba(139,92,246,0.55)",   text: "rgb(196,181,253)",      hoverBg: "rgba(139,92,246,0.34)" },
  // Row 3 — wins
  { key: "contacted_appointment",   label: "Appt Set",      icon: CheckCircle2,  bg: "rgba(34,197,94,0.22)",   border: "rgba(34,197,94,0.55)",    text: "rgb(134,239,172)",      hoverBg: "rgba(34,197,94,0.34)" },
  { key: "keep_in_touch",           label: "Keep in Touch", icon: Heart,         bg: "rgba(236,72,153,0.22)",  border: "rgba(236,72,153,0.55)",   text: "rgb(249,168,212)",      hoverBg: "rgba(236,72,153,0.34)" },
  // v15.8 — Renamed from "Left VM" to "Confirmed Owner - No Answer". Alex
  // clarified voicemail isn't actually happening here — this outcome fires when
  // the agent confirmed the identity of the owner (e.g. through a spouse, or
  // partial pickup) but couldn't get a full conversation. Backend key stays
  // `left_voicemail` for historical data continuity; icon swapped from Voicemail
  // to PhoneOff so the visual matches the corrected meaning.
  { key: "left_voicemail",          label: "Owner - No Answer", icon: PhoneOff,      bg: "rgba(59,130,246,0.22)",  border: "rgba(59,130,246,0.55)",   text: "rgb(147,197,253)",      hoverBg: "rgba(59,130,246,0.34)" },
] as const;

// v15.11.12 — One-line plain-English meaning per outcome, referenced by the
// dial-screen legend sheet AND the pre-fire confirm sheet. Update one place
// only — the tutorial reads the same source in its next refresh.
const OUTCOME_MEANINGS: Record<string, string> = {
  no_answer:            "Ringing, no pickup. Lead stays alive — someone (you or another agent) can try later.",
  wrong_number:         "Someone answered but it's not the owner. This phone line is removed from the lead.",
  disconnected:         "Dead number — no dial tone, endless ringing, or 'not in service'. Line removed from the lead.",
  contacted_not_interested: "Real conversation with the owner and they said no. Nice = 180-day icebox. Rude = hard remove.",
  recycled:             "You spoke with them and want to circle back later. Lead returns to the pool for anyone.",
  listed:               "Owner told you they've already relisted with another agent. Lead closes out.",
  contacted_appointment:"Meeting is booked. Fires FUB Meet & Greet appointment + creates the deal in the right pipeline.",
  keep_in_touch:        "Real relationship signal. Lead stays with you for 60 days and joins your FUB action plan.",
  left_voicemail:       "You confirmed the owner's identity (spouse, partial pickup) but couldn't get a real conversation.",
};

// ─── Gold divider ─────────────────────────────────────────────────────────────
function GoldDivider() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 20px 16px" }}>
      <div style={{ flex: 1, height: 1, background: "linear-gradient(to right, transparent, rgba(200,170,90,0.35))" }} />
      <div style={{ width: 4, height: 4, borderRadius: "50%", background: "rgba(200,170,90,0.5)" }} />
      <div style={{ flex: 1, height: 1, background: "linear-gradient(to left, transparent, rgba(200,170,90,0.35))" }} />
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────
function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <p style={{
      fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase",
      color: "rgba(200,170,90,0.6)", marginBottom: 10, fontWeight: 600,
      ...style,
    }}>
      {children}
    </p>
  );
}

// ─── Appt / Keep-in-Touch Modal ─────────────────────────────────────────────
const STAGES = ["Hot Prospect", "Active", "Nurture"] as const;
const INTENTIONS = [
  { key: "sell_now",      label: "Sell Now" },
  { key: "future_sell",  label: "Future Sell" },
  { key: "buy_now",      label: "Buy Now" },
  { key: "future_buy",  label: "Future Buy" },
  { key: "rental_now",  label: "Rental Now" },
  { key: "rental_later",label: "Rental Later" },
] as const;

// v14.16 — KIT follow-up timing options (4 pill picker)
const FOLLOW_UP_TIMING_OPTIONS = [
  { key: "a_few_days",  label: "A few days" },
  { key: "few_weeks",   label: "2–3 weeks" },
  { key: "few_months",  label: "2–3 months" },
  { key: "six_months",  label: "6 months+ · No rush" },
] as const;

function ApptModal({
  lead, outcome, onClose, onSubmit, isPending,
}: {
  lead: Lead;
  outcome: "contacted_appointment" | "keep_in_touch";
  onClose: () => void;
  onSubmit: (data: {
    apptEmail: string; confirmedAddress: string;
    apptDate: string; apptTime: string; stage: string; intention: string;
    followUpTiming?: string;
  }) => void;
  isPending: boolean;
}) {
  const isAppt = outcome === "contacted_appointment";
  const isKit = outcome === "keep_in_touch";
  const [apptEmail, setApptEmail] = React.useState(lead.email || "");
  const [addressConfirmed, setAddressConfirmed] = React.useState(true);
  const [altAddress, setAltAddress] = React.useState("");
  const [apptDate, setApptDate] = React.useState("");
  const [apptTime, setApptTime] = React.useState("");
  const [stage, setStage] = React.useState<string>("Hot Prospect");
  const [intentions, setIntentions] = React.useState<string[]>([]);
  // v14.16 — 4-option follow-up timing picker (KIT only)
  const [followUpTiming, setFollowUpTiming] = React.useState<string>("few_weeks");

  const toggleIntention = (key: string) => {
    setIntentions(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const confirmedAddress = addressConfirmed ? (lead.address || "") : altAddress;
  const canSubmit = apptEmail.trim() &&
    (addressConfirmed || altAddress.trim()) &&
    (!isAppt || (apptDate && apptTime)) &&
    (!isKit || followUpTiming) &&
    stage && intentions.length > 0;

  const sourceLabel: Record<string, string> = {
    expired: "Expired Listing", network: "Network / Inbound",
  };

  // v15.8 — hide bottom nav while this modal is open (see RecycleModal).
  React.useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);

  const inputStyle: React.CSSProperties = {
    width: "100%", background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(200,170,90,0.3)",
    padding: "12px 14px", borderRadius: 10,
    fontFamily: "'Switzer','Inter',sans-serif", fontSize: 14,
    color: "#fff", outline: "none", colorScheme: "dark",
    boxSizing: "border-box" as const,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase" as const,
    color: "rgba(200,170,90,0.7)", marginBottom: 7, display: "block", fontWeight: 600,
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
    }}>
      <div onClick={onClose} style={{
        position: "absolute", inset: 0,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
      }} />
      <div style={{
        position: "relative", zIndex: 1,
        background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
        border: "1px solid rgba(200,170,90,0.3)",
        borderBottom: "none",
        borderRadius: "20px 20px 0 0",
        padding: "28px 22px 48px",
        maxHeight: "90dvh",
        overflowY: "auto",
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 22px" }} />
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 26, fontWeight: 400, color: "#fff", margin: 0 }}>
            {isAppt ? "Appointment Set" : "Keep in Touch"}
          </h2>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>
            {isAppt ? "In-person appointment" : "Connected — future opportunity"}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <label style={labelStyle}>Owner Email</label>
            <input type="email" value={apptEmail} onChange={e => setApptEmail(e.target.value)}
              placeholder="owner@email.com" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Subject Property</label>
            <div style={{ padding: "12px 14px", background: "rgba(200,170,90,0.07)", border: "1px solid rgba(200,170,90,0.25)", borderRadius: 10, marginBottom: 10 }}>
              <p style={{ fontSize: 14, color: "rgba(255,255,255,0.8)", margin: 0 }}>{lead.address || "No address on file"}</p>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13, color: "rgba(255,255,255,0.65)" }}>
              <input type="checkbox" checked={addressConfirmed} onChange={e => setAddressConfirmed(e.target.checked)}
                style={{ width: 17, height: 17, accentColor: "#c8aa5a", flexShrink: 0 }} />
              This is the correct subject property
            </label>
            {!addressConfirmed && (
              <input type="text" value={altAddress} onChange={e => setAltAddress(e.target.value)}
                placeholder="Enter correct property address" style={{ ...inputStyle, marginTop: 12 }} />
            )}
          </div>
          {isAppt && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>Appointment Date</label>
                <input type="date" value={apptDate} onChange={e => setApptDate(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Appointment Time</label>
                <input type="time" value={apptTime} onChange={e => setApptTime(e.target.value)} style={inputStyle} />
              </div>
            </div>
          )}
          {/* v14.16 — KIT follow-up timing (4 pill picker) */}
          {isKit && (
            <div>
              <label style={labelStyle}>Follow up in <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>(pick one)</span></label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {FOLLOW_UP_TIMING_OPTIONS.map(o => {
                  const selected = followUpTiming === o.key;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => setFollowUpTiming(o.key)}
                      style={{
                        padding: "12px 8px", borderRadius: 9, border: "1px solid",
                        fontSize: 12, fontWeight: 600, cursor: "pointer",
                        transition: "all 0.15s", textAlign: "center",
                        borderColor: selected ? "#c8aa5a" : "rgba(255,255,255,0.12)",
                        background: selected ? "rgba(200,170,90,0.18)" : "rgba(255,255,255,0.04)",
                        color: selected ? "#c8aa5a" : "rgba(255,255,255,0.5)",
                      }}
                    >{o.label}</button>
                  );
                })}
              </div>
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "rgba(255,255,255,0.35)", letterSpacing: "0.02em" }}>
                We'll send them a warm intro email today and file this lead in your pipeline.
              </p>
            </div>
          )}
          <div>
            <label style={labelStyle}>Stage</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
              {STAGES.map(s => (
                <button key={s} type="button" onClick={() => setStage(s)} style={{
                  padding: "11px 6px", borderRadius: 9, border: "1px solid",
                  fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
                  borderColor: stage === s ? "#c8aa5a" : "rgba(255,255,255,0.15)",
                  background: stage === s ? "rgba(200,170,90,0.18)" : "rgba(255,255,255,0.04)",
                  color: stage === s ? "#c8aa5a" : "rgba(255,255,255,0.5)",
                }}>{s}</button>
              ))}
            </div>
          </div>
          <div>
            {/* v15.11.12 — Intention is REQUIRED. Frontend gate on canSubmit
                already enforced it; label now clearly marks it required so
                agents don't fill everything else and wonder why Save is greyed out. */}
            <label style={labelStyle}>
              Client Intention <span style={{ color: "#fca5a5", fontWeight: 700, letterSpacing: 0 }}>*</span>
              <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400, letterSpacing: 0, textTransform: "none" }}> (required — select all that apply)</span>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {INTENTIONS.map(i => {
                const selected = intentions.includes(i.key);
                return (
                  <button
                    key={i.key}
                    type="button"
                    onClick={() => toggleIntention(i.key)}
                    style={{
                      padding: "11px 8px", borderRadius: 9, border: "1px solid",
                      fontSize: 12, fontWeight: 600, cursor: "pointer",
                      transition: "all 0.15s", textAlign: "center",
                      borderColor: selected ? "#93c5fd" : "rgba(255,255,255,0.12)",
                      background: selected ? "rgba(147,197,253,0.15)" : "rgba(255,255,255,0.04)",
                      color: selected ? "#93c5fd" : "rgba(255,255,255,0.45)",
                    }}
                  >{i.label}</button>
                );
              })}
            </div>
            {intentions.length > 1 && (
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "#fbbf24", letterSpacing: "0.04em" }}>
                Multi-transaction client — {intentions.length} intentions selected
              </p>
            )}
            {intentions.length === 0 && (
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "rgba(252,165,165,0.85)", letterSpacing: "0.02em" }}>
                Pick at least one so we route the FUB action plan correctly.
              </p>
            )}
          </div>
          <div>
            <label style={labelStyle}>Source</label>
            <div style={{ padding: "12px 14px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, fontSize: 13, color: "rgba(255,255,255,0.5)" }}>
              {sourceLabel[lead.leadType] || lead.leadType}
            </div>
          </div>
        </div>
        <button
          onClick={() => onSubmit({ apptEmail, confirmedAddress, apptDate, apptTime, stage, intention: intentions.map(k => INTENTIONS.find(i => i.key === k)?.label || k).join(" + "), followUpTiming: isKit ? followUpTiming : undefined })}
          disabled={!canSubmit || isPending}
          style={{
            marginTop: 28, width: "100%", padding: "16px", borderRadius: 12, border: "none",
            background: canSubmit && !isPending ? "linear-gradient(135deg,#c8aa5a,#a8893a)" : "rgba(255,255,255,0.08)",
            color: canSubmit && !isPending ? "#080808" : "rgba(255,255,255,0.3)",
            fontSize: 15, fontWeight: 700, cursor: canSubmit && !isPending ? "pointer" : "default",
            letterSpacing: "0.04em",
          }}
        >
          {isPending ? "Saving…" : "Confirm & Submit"}
        </button>
      </div>
    </div>
  );
}


// ─── Recycle Confirm Sheet ─────────────────────────────────────────────────
function RecycleModal({
  onClose, onSubmit, isPending,
}: {
  onClose: () => void;
  onSubmit: () => void;
  isPending: boolean;
}) {
  // v15.8 — hide the bottom nav (which uses backdrop-filter / creates its own
  // iOS Safari stacking context that punches through zIndex ordering) while
  // this modal is open. See BUGLIST 15.8 nav-z fix.
  React.useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
    }}>
      <div onClick={onClose} style={{
        position: "absolute", inset: 0,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
      }} />
      <div style={{
        position: "relative", zIndex: 1,
        background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
        border: "1px solid rgba(34,211,238,0.3)",
        borderBottom: "none",
        borderRadius: "20px 20px 0 0",
        padding: "28px 22px 48px",
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 22px" }} />
        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 26, fontWeight: 400, color: "#fff", margin: "0 0 8px" }}>
          Recycle Lead
        </h2>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 0, marginBottom: 28, lineHeight: 1.5 }}>
          This lead will be immediately returned to the shared pool. The next agent who taps Load Next Lead can pick it up — just like a fresh lead.
        </p>
        <button
          onClick={onSubmit}
          disabled={isPending}
          style={{
            width: "100%", padding: "16px", borderRadius: 12, border: "none",
            background: !isPending ? "linear-gradient(135deg,#22d3ee,#0891b2)" : "rgba(255,255,255,0.08)",
            color: !isPending ? "#080808" : "rgba(255,255,255,0.3)",
            fontSize: 15, fontWeight: 700, cursor: !isPending ? "pointer" : "default",
            letterSpacing: "0.04em",
          }}
        >
          {isPending ? "Recycling…" : "Recycle to Pool"}
        </button>
      </div>
    </div>
  );
}

// v14.14 — The old standalone RecycleButton component was removed. Recycle is
// now delivered exclusively through the outcome grid "Recycle" slot, which
// opens RecycleModal and posts outcome="recycled" via outcomeMutation.

// v15.11.18 — Skip modal. Escape hatch for glitched/stuck leads (e.g. a
// won lead that shouldn't be in the pool but is showing on the card, or a
// lead that won't advance after an outcome). 3 skips per agent per local
// day, minimum 60 minutes between skips. Skipped leads go back to the pool
// AND get held out from this agent for the rest of the day.
function SkipModal({
  onClose, onSubmit, isPending, remaining, cap, inCooldown, cooldownExpiresAt,
}: {
  onClose: () => void;
  onSubmit: () => void;
  isPending: boolean;
  remaining: number;
  cap: number;
  inCooldown: boolean;
  cooldownExpiresAt: string | null;
}) {
  React.useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);
  const cooldownMinsLeft = cooldownExpiresAt
    ? Math.max(0, Math.ceil((new Date(cooldownExpiresAt).getTime() - Date.now()) / 60_000))
    : 0;
  const blocked = remaining <= 0 || inCooldown;
  const primaryLabel = isPending ? "Skipping…"
    : remaining <= 0 ? `${cap}/${cap} used — resets midnight`
    : inCooldown ? `Next skip in ${cooldownMinsLeft}m`
    : "Skip Lead";
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
    }}>
      <div onClick={onClose} style={{
        position: "absolute", inset: 0,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
      }} />
      <div style={{
        position: "relative", zIndex: 1,
        background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
        border: "1px solid rgba(200,170,90,0.3)",
        borderBottom: "none",
        borderRadius: "20px 20px 0 0",
        padding: "28px 22px 48px",
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 22px" }} />
        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 26, fontWeight: 400, color: "#fff", margin: "0 0 8px" }}>
          Skip Lead
        </h2>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", marginTop: 0, marginBottom: 16, lineHeight: 1.55 }}>
          Use this when something's wrong — a glitched card, a lead that's already yours, or one you can't advance past. The lead goes back to the pool and won't come back to you today.
        </p>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "10px 12px", borderRadius: 8, background: "rgba(200,170,90,0.06)",
          border: "1px solid rgba(200,170,90,0.15)", marginBottom: 22,
        }}>
          <span style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(200,170,90,0.75)" }}>Skips today</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#e5c98a" }}>{cap - remaining} / {cap}</span>
        </div>
        <button
          onClick={onSubmit}
          disabled={isPending || blocked}
          style={{
            width: "100%", padding: "16px", borderRadius: 12, border: "none",
            background: (!isPending && !blocked) ? "linear-gradient(135deg,#c8aa5a,#a8893a)" : "rgba(255,255,255,0.06)",
            color: (!isPending && !blocked) ? "#0a0700" : "rgba(255,255,255,0.3)",
            fontSize: 15, fontWeight: 700, cursor: (!isPending && !blocked) ? "pointer" : "default",
            letterSpacing: "0.04em",
          }}
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}

// ─── Generic Outcome Confirm Sheet (v15.11.12) ────────────────────
// Alex 2026-07-13: agents were fat-fingering outcomes and asking for an
// undo button. Instead we insert a confirm step. Every outcome that DOESN'T
// already have a modal (KIT/Appt/Recycle/Not Interested) now opens this compact
// sheet before firing. Cancel = go back, Confirm = fire the outcome.
//
// Outcomes with their own modal keep their own confirm; adding a second one
// would be a double-tap.
function OutcomeConfirmSheet({
  label, toneColor, borderColor, description, onClose, onConfirm, isPending,
}: {
  label: string;
  toneColor: string;
  borderColor: string;
  description: string;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  React.useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
    }}>
      <div onClick={onClose} style={{
        position: "absolute", inset: 0,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
      }} />
      <div style={{
        position: "relative", zIndex: 1,
        background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
        border: `1px solid ${borderColor}`,
        borderBottom: "none",
        borderRadius: "20px 20px 0 0",
        padding: "28px 22px 40px",
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 20px" }} />
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)", textAlign: "center", marginBottom: 8 }}>
          Confirm outcome
        </div>
        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 30, fontWeight: 400, color: toneColor, margin: "0 0 10px", textAlign: "center" }}>
          {label}
        </h2>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", marginTop: 0, marginBottom: 24, lineHeight: 1.55, textAlign: "center" }}>
          {description}
        </p>
        <button
          onClick={onConfirm}
          disabled={isPending}
          style={{
            width: "100%", padding: "16px", borderRadius: 12, border: "none",
            background: !isPending ? toneColor : "rgba(255,255,255,0.08)",
            color: !isPending ? "#080808" : "rgba(255,255,255,0.3)",
            fontSize: 15, fontWeight: 800, cursor: !isPending ? "pointer" : "default",
            letterSpacing: "0.04em", marginBottom: 10, textTransform: "uppercase",
          }}
        >
          {isPending ? "Logging…" : `Log ${label}`}
        </button>
        <button
          onClick={onClose}
          disabled={isPending}
          style={{
            width: "100%", padding: "12px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)",
            background: "transparent", color: "rgba(255,255,255,0.7)",
            fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Outcome Legend Sheet (v15.11.12) ────────────────────────
// One-tap reference from the dial screen. Lists every outcome tile with its
// color, icon, and one-line meaning. Prevents agents from hunting the tutorial
// to check a single definition mid-call.
function OutcomeLegendSheet({ onClose }: { onClose: () => void }) {
  React.useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
    }}>
      <div onClick={onClose} style={{
        position: "absolute", inset: 0,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
      }} />
      <div style={{
        position: "relative", zIndex: 1,
        background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
        border: "1px solid rgba(200,170,90,0.28)",
        borderBottom: "none",
        borderRadius: "20px 20px 0 0",
        padding: "22px 18px 28px",
        maxHeight: "88vh", overflowY: "auto",
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 16px" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)" }}>
              Quick reference
            </div>
            <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 26, fontWeight: 400, color: "#fff", margin: "2px 0 0" }}>
              Outcome meanings
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)",
            color: "rgba(255,255,255,0.75)", borderRadius: 999, width: 32, height: 32,
            fontSize: 18, fontWeight: 600, cursor: "pointer", lineHeight: 1,
          }}>×</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
          {OUTCOMES.map(o => {
            const Icon = o.icon;
            return (
              <div key={o.key} style={{
                display: "flex", alignItems: "flex-start", gap: 12,
                padding: "12px 12px", borderRadius: 12,
                background: o.bg,
                border: `1px solid ${o.border}`,
              }}>
                <div style={{
                  flexShrink: 0, width: 34, height: 34, borderRadius: 8,
                  background: "rgba(0,0,0,0.35)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <Icon size={18} color={o.text as string} strokeWidth={2} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: o.text, letterSpacing: "0.01em", marginBottom: 3 }}>
                    {o.label}
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.45 }}>
                    {OUTCOME_MEANINGS[o.key] || ""}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ marginTop: 16, marginBottom: 0, fontSize: 11, color: "rgba(255,255,255,0.35)", textAlign: "center", letterSpacing: "0.04em" }}>
          Every outcome now asks for confirmation before it's logged.
        </p>
      </div>
    </div>
  );
}

// ─── Not Interested Sheet (v15.11.11) ─────────────────────────────────
// Two-branch confirm. When agent taps Not Interested we ask them to categorize:
//
//   NICE  → outcome = "nice_not_interested" → server sets status=recycled and
//           callback_date = now + 180 days. Lead sleeps until then, then re-
//           enters the shared pool automatically (pool query already gates on
//           callback_date IS NULL OR callback_date <= now).
//
//   RUDE  → outcome = "contacted_not_interested" → existing behavior (dead lead,
//           unassigned, no pipeline entry).
//
// Rationale (Alex 2026-07-13): confirmed real owners who politely decline are
// worth 6 months of nurture — life changes (relocation, divorce, birth, job
// move, market swings) routinely flip "not right now" into a real conversation
// within 90–180 days. Only rude / never-owned / no-signal decliners get the
// hard-delete path.
function NotInterestedModal({
  onClose, onNice, onRude, isPending,
}: {
  onClose: () => void;
  onNice: () => void;
  onRude: () => void;
  isPending: boolean;
}) {
  React.useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
    }}>
      <div onClick={onClose} style={{
        position: "absolute", inset: 0,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
      }} />
      <div style={{
        position: "relative", zIndex: 1,
        background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
        border: "1px solid rgba(239,68,68,0.3)",
        borderBottom: "none",
        borderRadius: "20px 20px 0 0",
        padding: "28px 22px 48px",
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 22px" }} />
        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 26, fontWeight: 400, color: "#fff", margin: "0 0 8px" }}>
          Not Interested — which kind?
        </h2>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 0, marginBottom: 22, lineHeight: 1.5 }}>
          If they're a real owner who was polite — keep them. Life changes in 6 months. If they were rude or clearly not the owner, remove.
        </p>

        <button
          onClick={onNice}
          disabled={isPending}
          style={{
            width: "100%", padding: "16px", borderRadius: 12, border: "1px solid rgba(34,211,238,0.4)",
            background: !isPending ? "linear-gradient(135deg,rgba(34,211,238,0.18),rgba(8,145,178,0.12))" : "rgba(255,255,255,0.05)",
            color: !isPending ? "#a7f3d0" : "rgba(255,255,255,0.3)",
            fontSize: 15, fontWeight: 700, cursor: !isPending ? "pointer" : "default",
            letterSpacing: "0.03em", marginBottom: 12, textAlign: "left",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Nice — Confirmed Owner, Not Now</div>
          <div style={{ fontSize: 12, fontWeight: 500, color: "rgba(167,243,208,0.75)", letterSpacing: 0 }}>
            Real owner, polite decline. Lead sleeps 180 days, then re-enters the pool for another try.
          </div>
        </button>

        <button
          onClick={onRude}
          disabled={isPending}
          style={{
            width: "100%", padding: "14px 16px", borderRadius: 12, border: "1px solid rgba(239,68,68,0.35)",
            background: !isPending ? "rgba(239,68,68,0.10)" : "rgba(255,255,255,0.05)",
            color: !isPending ? "rgb(252,165,165)" : "rgba(255,255,255,0.3)",
            fontSize: 14, fontWeight: 700, cursor: !isPending ? "pointer" : "default",
            letterSpacing: "0.03em", marginBottom: 12, textAlign: "left",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 3 }}>Rude / Not the Owner — Remove</div>
          <div style={{ fontSize: 11, fontWeight: 500, color: "rgba(252,165,165,0.7)", letterSpacing: 0 }}>
            Hostile, hung up, bad data, or clearly not the property owner. Lead deleted, no pipeline entry.
          </div>
        </button>

        <button
          onClick={onClose}
          disabled={isPending}
          style={{
            width: "100%", padding: "12px", borderRadius: 10, border: "none",
            background: "transparent", color: "rgba(255,255,255,0.5)",
            fontSize: 13, fontWeight: 500, cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Lead card ────────────────────────────────────────────────────────────────
// v14.22 IntelStrip — pills under the address (list price, AVM delta, years owned, equity, score)
// Palette per Alex spec: strong-green / muted-green / yellow / red only. No grey.
function IntelPill({ tone, children }: { tone: "g" | "g2" | "y" | "r"; children: React.ReactNode }) {
  const palette = {
    g:  { bg: "rgba(34,197,94,0.18)",  bd: "rgba(34,197,94,0.45)",  fg: "#4ade80" },
    g2: { bg: "rgba(34,197,94,0.09)",  bd: "rgba(34,197,94,0.25)",  fg: "#86efac" },
    y:  { bg: "rgba(234,179,8,0.16)",  bd: "rgba(234,179,8,0.42)",  fg: "#fde047" },
    r:  { bg: "rgba(239,68,68,0.16)",  bd: "rgba(239,68,68,0.42)",  fg: "#fca5a5" },
  }[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "3px 9px", borderRadius: 999,
      background: palette.bg, border: `1px solid ${palette.bd}`,
      color: palette.fg, fontSize: 11, fontWeight: 600,
      letterSpacing: "0.02em", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function IntelStrip({ lead }: { lead: any }) {
  const pills: React.ReactNode[] = [];
  const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`;

  if (lead.listPrice && lead.listPrice > 0) {
    pills.push(<IntelPill key="lp" tone="g2">Listed {fmt(lead.listPrice)}</IntelPill>);
  }

  if (lead.assessedValue && lead.assessedValue > 0 && lead.listPrice && lead.listPrice > 0) {
    const delta = ((lead.assessedValue - lead.listPrice) / lead.listPrice) * 100;
    const pct = Math.round(delta);
    let tone: "g" | "g2" | "y" | "r" = "g2";
    if (delta <= -3) tone = "g";
    else if (delta > -3 && delta < 3) tone = "y";
    else if (delta >= 10) tone = "r";
    else tone = "g2";
    const sign = pct > 0 ? "+" : "";
    pills.push(<IntelPill key="avm" tone={tone}>AVM {fmt(lead.assessedValue)} ({sign}{pct}%)</IntelPill>);
  } else if (lead.assessedValue && lead.assessedValue > 0) {
    pills.push(<IntelPill key="avm" tone="g2">AVM {fmt(lead.assessedValue)}</IntelPill>);
  }

  if (lead.yearPurchased && lead.yearPurchased > 1900) {
    const yrs = new Date().getFullYear() - lead.yearPurchased;
    let tone: "g" | "g2" | "y" | "r" = "g2";
    if (yrs >= 10) tone = "g";
    else if (yrs >= 5) tone = "y";
    else if (yrs >= 2) tone = "g2";
    else tone = "r";
    pills.push(<IntelPill key="yr" tone={tone}>{yrs}yr owned</IntelPill>);
  }

  if (lead.listPrice && lead.listPrice > 0 && lead.lastSalePrice && lead.lastSalePrice > 0) {
    const equityPct = Math.round(((lead.listPrice - lead.lastSalePrice) / lead.listPrice) * 100);
    if (equityPct >= 100) {
      pills.push(<IntelPill key="eq" tone="g">Free &amp; Clear</IntelPill>);
    } else if (equityPct >= 50) {
      pills.push(<IntelPill key="eq" tone="g">High Equity ~{equityPct}%</IntelPill>);
    } else if (equityPct >= 25) {
      pills.push(<IntelPill key="eq" tone="y">Some Equity ~{equityPct}%</IntelPill>);
    }
  }

  if (typeof lead.score === "number" && lead.score > 0) {
    let tone: "g" | "g2" | "y" | "r" = "g2";
    if (lead.score >= 65) tone = "g";
    else if (lead.score >= 50) tone = "g2";
    else tone = "g2";
    pills.push(<IntelPill key="sc" tone={tone}>Score {lead.score}</IntelPill>);
  }

  if (pills.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
      {pills}
    </div>
  );
}

function LeadCard({ lead }: { lead: Lead }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");
  // v15.11.2 — Live heat tier so we can block the gold dial button during
  // Downtime. Re-computes every 60s so the button unlocks the moment we
  // cross into Mid or Prime.
  const [heatTick, setHeatTick] = useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setHeatTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const cardHeat = React.useMemo(() => computeCallHeat(), [heatTick]);
  // v15.11.13 — Three-tier dial gate.
  //   Illegal hours (outside 8AM–8PM FL statute) → HARD BLOCK, no override.
  //   Legal Downtime (or Mid, if agent is aggressive) → CONFIRM before dial.
  //   Prime Time → free dial.
  // Alex 2026-07-13: agents want to grind during off-peak daytime hours;
  // giving them an ask-first path preserves the research nudge without
  // blocking productive dialing. Statute stays absolute.
  const dialHardBlocked = !cardHeat.legal;                  // afterhours/too-early
  const dialNeedsConfirm = cardHeat.legal && cardHeat.tier !== "prime"; // Mid + Downtime
  const dialLocked = dialHardBlocked;                       // legacy flag — used only for hard-block UI
  const [pendingDialConfirm, setPendingDialConfirm] = useState<string | null>(null);
  const [showScript, setShowScript] = useState(false);
  const [hoveredOutcome, setHoveredOutcome] = useState<string | null>(null);
  const [pendingOutcome, setPendingOutcome] = useState<"contacted_appointment" | "keep_in_touch" | null>(null);
  const [pendingRecycle, setPendingRecycle] = useState(false);
  // v15.11.18 — Skip confirm sheet. 3/day + 60min cooldown enforced server-side.
  const [pendingSkip, setPendingSkip] = useState(false);
  const [skipQuota, setSkipQuota] = useState<{ used: number; remaining: number; cap: number; inCooldown: boolean; cooldownExpiresAt: string | null; nextAvailableAt: string | null; resetAt: string } | null>(null);
  // v15.11.11 — Two-branch confirm sheet for Not Interested (Nice=180d recycle / Rude=delete).
  const [pendingNotInterested, setPendingNotInterested] = useState(false);
  // v15.11.12 — Generic confirm sheet for the 5 outcomes that DON'T have their
  // own modal (No Answer, Wrong #, Not a Working Line, Listed, Owner-No Answer).
  // Holds the outcome key that's waiting on confirmation.
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  // v15.11.12 — Outcome legend. Agents were tapping into the full tutorial just
  // to check what one outcome meant. Now the legend sits one tap away from the
  // dial screen.
  const [legendOpen, setLegendOpen] = useState(false);
  // v14.20 — lpmOpen/toneOpen state removed. Seller LPMAMA is always visible;
  // Tone Rules + Guardrails + Branch Cues moved to the Scripts admin page.
  const [outcomeFlash, setOutcomeFlash] = useState<{ label: string; color: string } | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  // v14.80 — Tier 3 celebration: bumping this key re-triggers the Appt Set shimmer sweep
  const [apptShimmerKey, setApptShimmerKey] = useState(0);
  const [lpmData, setLpmData] = useState<Record<string, string>>({
    // Seller LPMAMA
    location: lead.lLocation ?? "",
    price: lead.lPricePaid ?? "",
    motivation: lead.lMotivation ?? "",
    agent: lead.lAgentHistory ?? "",
    mortgage: lead.lMortgage ?? "",
    appointment: lead.lAppointment ?? "",
    // Buyer LPMAMA (v14.20)
    bLocation:   (lead as any).bLocation   ?? "",
    bPrice:      (lead as any).bPrice      ?? "",
    bMotivation: (lead as any).bMotivation ?? "",
    bAgent:      (lead as any).bAgent      ?? "",
    bMortgage:   (lead as any).bMortgage   ?? "",
  });
  // v14.53 — Intent selector: 3-way mutually-exclusive choice.
  //   sell_only     → Seller CPMAMA only
  //   sell_and_buy  → Seller CPMAMA + Buyer LPMAMA
  //   buy_only      → Buyer LPMAMA only (no seller card at all)
  // Backward compat: derive from existing lead.intent if present, otherwise from alsoBuying flag.
  type Intent = "sell_only" | "sell_and_buy" | "buy_only";
  const initialIntent: Intent = ((lead as any).intent as Intent) ||
    ((lead as any).alsoBuying ? "sell_and_buy" : "sell_only");
  const [intent, setIntent] = useState<Intent>(initialIntent);
  const alsoBuying = intent === "sell_and_buy"; // preserved derived flag for downstream code / FUB
  const showSellerCard = intent !== "buy_only";
  const showBuyerCard = intent !== "sell_only";

  const extra = (() => { try { return JSON.parse(lead.extraData || "{}"); } catch { return {}; } })();

  const { data: script } = useQuery<{ content: string }>({
    queryKey: ["/api/scripts", lead.leadType],
    queryFn: () => apiRequest("GET", `/api/scripts/${lead.leadType}`).then(r => r.json()),
    staleTime: 60000,
  });

  // v15.11.18 — Skip quota. Refetched every 60s so the cooldown countdown
  // and daily reset stay accurate without needing a websocket push.
  const { data: skipQuotaData } = useQuery<any>({
    queryKey: [`/api/agent/${user?.id}/skip-quota`],
    queryFn: () => apiRequest("GET", `/api/agent/${user?.id}/skip-quota`).then(r => r.json()),
    enabled: !!user?.id,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  React.useEffect(() => {
    if (skipQuotaData) setSkipQuota(skipQuotaData);
  }, [skipQuotaData]);

  const OUTCOME_FLASH: Record<string, { label: string; color: string }> = {
    keep_in_touch:            { label: "Keep in Touch — Logged", color: "rgb(249,168,212)" },
    contacted_appointment:    { label: "Appointment Set!",         color: "rgb(134,239,172)" },
    no_answer:                { label: "No Answer — Logged",      color: "rgb(253,224,71)" },
    contacted_not_interested: { label: "Not Interested — Logged", color: "rgb(252,165,165)" },
    // v15.11.11 — Nice Confirmed Owner Not Interested → 180-day ICE recycle toast.
    nice_not_interested:      { label: "Iced 180 days — will re-enter pool", color: "#a7f3d0" },
    wrong_number:             { label: "Wrong # — Logged",        color: "rgba(252,165,165,0.8)" },
    recycled:                 { label: "Recycled to Pool",         color: "#22d3ee" },
    // v14.16 — 9-outcome grid additions
    // v15.11.12 — relabeled per Alex to remove agent confusion.
    disconnected:             { label: "Not a Working Line — Logged", color: "rgb(203,213,225)" },
    listed:                   { label: "Listed — Closed Out",      color: "rgb(196,181,253)" },
    left_voicemail:           { label: "Confirmed Owner — No Answer", color: "rgb(147,197,253)" },
  };

  // v15.11.18 — Skip mutation. POST /api/leads/:id/skip. Server enforces
  // the 3/day + 60min cooldown; we surface any 429 rate-limit error via toast
  // and re-open the modal with the fresh quota state.
  const skipMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/leads/${lead.id}/skip`, {
        agentId: user?.id,
      }).then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw { status: r.status, body };
        return body;
      }),
    onSuccess: (data: any) => {
      setOutcomeFlash({ label: "Lead Skipped", color: "#c8aa5a" });
      setPendingSkip(false);
      // Update quota state locally from the server response so button repaints instantly.
      if (data?.quota) setSkipQuota(data.quota);
      setTimeout(() => {
        setOutcomeFlash(null);
        qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
        qc.invalidateQueries({ queryKey: [`/api/leads/my-count/${user?.id}`] });
        qc.invalidateQueries({ queryKey: [`/api/agent/${user?.id}/skip-quota`] });
      }, 900);
    },
    onError: (err: any) => {
      const code = err?.body?.code;
      if (code === "DAILY_CAP") {
        toast({ title: "Daily skip limit reached", description: `You've used all ${err.body.cap} skips today. Resets midnight.`, variant: "destructive" });
      } else if (code === "COOLDOWN") {
        toast({ title: "Skip cooldown active", description: "Only 1 skip per hour. Try again shortly.", variant: "destructive" });
      } else {
        toast({ title: "Error skipping lead", variant: "destructive" });
      }
      // Refresh quota from server so the modal reflects reality.
      qc.invalidateQueries({ queryKey: [`/api/agent/${user?.id}/skip-quota`] });
    },
  });

  // v14.14 — Recycle hits /api/leads/:id/recycle. One tap, no date, no strings.
  // Lead unassigns to the shared pool; next agent pulls it via my-next.
  const recycleMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/leads/${lead.id}/recycle`, {
        agentId: user?.id,
        notes: notes || "Recycled to pool for reassignment.",
      }).then(r => r.json()),
    onSuccess: () => {
      setOutcomeFlash({ label: "Recycled to Pool", color: "#22d3ee" });
      setTimeout(() => {
        setOutcomeFlash(null);
        qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
        qc.invalidateQueries({ queryKey: [`/api/leads/my-count/${user?.id}`] });
        qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
      }, 900);
    },
    onError: () => toast({ title: "Error recycling lead", variant: "destructive" }),
  });

  const outcomeMutation = useMutation({
    mutationFn: (data: { outcome: string; notes?: string; callbackDate?: string; apptEmail?: string; confirmedAddress?: string; apptDate?: string; apptTime?: string; stage?: string; intention?: string; dialedPhone?: string; followUpTiming?: string }) =>
      // v14.20 — include alsoBuying + Buyer LPMAMA inside lpmamab payload so
      // server /outcome handler + pushOutcomeToFub both get the buyer context.
      apiRequest("POST", `/api/leads/${lead.id}/outcome`, {
        ...data,
        agentId: user?.id,
        // v14.53 — include intent so server persists it + FUB note reflects the right script
        lpmamab: { ...lpmData, alsoBuying, intent },
      }).then(r => r.json()),
    onSuccess: (data, variables) => {
      // Show success flash for 900ms, then load next lead
      const flash = OUTCOME_FLASH[variables.outcome] ?? { label: "Outcome Logged", color: "#c8aa5a" };
      setOutcomeFlash(flash);
      // Confetti for appointments!
      if (variables.outcome === "contacted_appointment") {
        setShowConfetti(true);
        // v14.80 — Tier 3: gold shimmer sweep on the Appt Set tile + chime sound (opt-in)
        setApptShimmerKey(k => k + 1);
        playSound("chime");
        // v15.11.10 — celebratory buzz (Android only; iOS silently ignores)
        hapticApptSet();
      }
      // v14.80 — Tier 3: quiet tick sound when a KIT (Keep in Touch) submits successfully
      if (variables.outcome === "keep_in_touch") {
        playSound("tick");
        hapticKit();
      }

      // v14.11 — Advance toast: make the phone advance visible.
      // No Answer: if untried lines remain, server keeps same lead + advances active phone.
      // If all tried, lead returns to pool — next lead loads.
      // Wrong #: server always returns lead to pool (unless all struck → deleted).
      if (
        variables.outcome === "no_answer" ||
        variables.outcome === "wrong_number" ||
        variables.outcome === "disconnected" ||
        variables.outcome === "left_voicemail"
      ) {
        const total = allPhones.length;
        const dialed = variables.dialedPhone || activePhone;
        const currentIdx = allPhones.findIndex(p => p === dialed);
        const currentLineNum = currentIdx >= 0 ? currentIdx + 1 : 1;

        // Compute remaining untried after this outcome
        const projectedStates = { ...phoneStates };
        if (variables.outcome === "no_answer" && dialed)      projectedStates[dialed] = "no_answer_today";
        if (variables.outcome === "wrong_number" && dialed)   projectedStates[dialed] = "struck";
        if (variables.outcome === "disconnected" && dialed)   projectedStates[dialed] = "struck";
        if (variables.outcome === "left_voicemail" && dialed) projectedStates[dialed] = "no_answer_today";
        const untriedRemaining = allPhones.filter(p => (projectedStates[p] || "untried") === "untried");

        if (variables.outcome === "no_answer") {
          if (untriedRemaining.length > 0) {
            const nextIdx = allPhones.findIndex(p => p === untriedRemaining[0]);
            toast({
              title: `No answer — line ${currentLineNum} rested`,
              description: `Now dialing line ${nextIdx + 1} of ${total}.`,
              duration: 3000,
            });
          } else {
            toast({
              title: "All numbers tried today",
              description: "Lead returned to pool. Loading next lead…",
              duration: 3000,
            });
          }
        } else if (variables.outcome === "wrong_number" || variables.outcome === "disconnected") {
          // v14.65 — Struck phone is physically removed from the candidate list.
          //          Whatever was line N+1 becomes the new line N. "1 of (total-1)".
          const label = variables.outcome === "disconnected" ? "Not a Working Line" : "Wrong #";
          const newTotal = Math.max(0, total - 1);
          if (data && data.deleted) {
            toast({
              title: `${label} — line ${currentLineNum} removed`,
              description: "All numbers dead — lead removed.",
              duration: 3000,
            });
          } else if (data && data.keptOnLead) {
            toast({
              title: `${label} — line ${currentLineNum} removed`,
              description: `Now dialing line 1 of ${newTotal}.`,
              duration: 3000,
            });
          } else {
            toast({
              title: `${label} — line ${currentLineNum} removed`,
              description: "All viable numbers rested. Loading next lead…",
              duration: 3000,
            });
          }
        } else if (variables.outcome === "left_voicemail") {
          if (untriedRemaining.length > 0) {
            const nextIdx = allPhones.findIndex(p => p === untriedRemaining[0]);
            toast({
              title: `Voicemail — line ${currentLineNum} logged`,
              description: `Now dialing line ${nextIdx + 1} of ${total}.`,
              duration: 3000,
            });
          } else {
            toast({
              title: "Voicemail logged",
              description: "All lines contacted today. Loading next lead…",
              duration: 3000,
            });
          }
        }
      }

      setTimeout(() => {
        setOutcomeFlash(null);
        qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
        qc.invalidateQueries({ queryKey: [`/api/leads/my-count/${user?.id}`] });
        qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
      }, 900);
    },
    onError: () => toast({ title: "Error saving outcome", variant: "destructive" }),
  });

  // Parse multi-number state from lead
  const allPhones: string[] = React.useMemo(() => {
    try { return lead.phones ? JSON.parse(lead.phones) : (lead.phone ? [lead.phone] : []); } catch { return lead.phone ? [lead.phone] : []; }
  }, [lead.phones, lead.phone]);
  const phoneStates: Record<string, string> = React.useMemo(() => {
    try { return lead.phoneStates ? JSON.parse(lead.phoneStates) : {}; } catch { return {}; }
  }, [lead.phoneStates]);
  // Active phone is whatever is currently on lead.phone (server keeps it current)
  const activePhone = lead.phone || allPhones[0] || "";
  // v14.65 — Struck phones are physically removed from allPhones on the server,
  // so allPhones is now our live candidate list. Slot numbering renumbers as
  // candidates die.
  const triedTodayCount = allPhones.filter(p => phoneStates[p] === "no_answer_today").length;
  const untriedCount = allPhones.filter(p => phoneStates[p] === "untried" || !phoneStates[p]).length;

  const handleOutcome = (key: string) => {
    if (key === "contacted_appointment" || key === "keep_in_touch") {
      setPendingOutcome(key as "contacted_appointment" | "keep_in_touch");
      return;
    }
    if (key === "recycled") {
      setPendingRecycle(true);
      return;
    }
    // v15.11.11 — Not Interested opens a two-branch confirm sheet so agents
    // decide: Nice (180-day recycle) or Rude (hard delete). Never fires the
    // outcome directly without this split.
    if (key === "contacted_not_interested") {
      setPendingNotInterested(true);
      return;
    }
    // v15.11.12 — Every remaining outcome (No Answer, Wrong #, Not a Working
    // Line, Listed, Owner-No Answer) now routes through a compact confirm sheet.
    // Prevents fat-finger — tap wrong tile, cancel, pick right one.
    setPendingConfirm(key);
  };

  // v15.11.12 — fire the confirmed outcome and dismiss the sheet.
  const handleConfirmOutcome = () => {
    if (!pendingConfirm) return;
    outcomeMutation.mutate({ outcome: pendingConfirm, notes, dialedPhone: activePhone });
    setPendingConfirm(null);
  };

  // v15.11.11 — Not Interested → Nice branch (180-day ICE recycle)
  const handleNotInterestedNice = () => {
    outcomeMutation.mutate({ outcome: "nice_not_interested", notes, dialedPhone: activePhone });
    setPendingNotInterested(false);
  };
  // v15.11.11 — Not Interested → Rude branch (existing hard-delete path)
  const handleNotInterestedRude = () => {
    outcomeMutation.mutate({ outcome: "contacted_not_interested", notes, dialedPhone: activePhone });
    setPendingNotInterested(false);
  };

  // v14.14 — Recycle confirm triggers immediate unassign to pool (no date, no schedule).
  // Next agent pulls it via my-next (respects home-county).
  const handleRecycleSubmit = () => {
    recycleMutation.mutate();
    setPendingRecycle(false);
  };

  const handleApptSubmit = (data: { apptEmail: string; confirmedAddress: string; apptDate: string; apptTime: string; stage: string; intention: string; followUpTiming?: string }) => {
    if (!pendingOutcome) return;
    outcomeMutation.mutate({
      outcome: pendingOutcome,
      notes,
      ...data,
    });
    setPendingOutcome(null);
  };

  const zillow = lead.address ? `https://www.zillow.com/homes/${encodeURIComponent(lead.address)}_rb/` : null;

  // v15.11.5 — All email affordances removed. No mailto, no Flow 1/2/3/4, no badges.

  const typeLabel: Record<string, string> = {
    expired: "Expired", network: "Network",
  };

  return (
    <div style={{
      background: "linear-gradient(160deg, #141414 0%, #0c0c0c 60%, #0a0a0a 100%)",
      border: "1px solid rgba(200,170,90,0.3)",
      borderRadius: 16, overflow: "hidden",
      width: "100%",
      boxShadow: "0 0 40px rgba(200,170,90,0.06), 0 8px 32px rgba(0,0,0,0.6)",
      position: "relative",
    }}>

      {/* ── Confetti celebration (appointment) ── */}
      {showConfetti && <ConfettiCelebration onDone={() => setShowConfetti(false)} />}

      {/* ── Outcome success flash overlay ── */}
      {outcomeFlash && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 50,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16,
          background: "rgba(8,8,8,0.92)",
          backdropFilter: "blur(6px)",
          borderRadius: 16,
          animation: "ldFlashIn 0.18s ease",
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: "50%",
            border: `2px solid ${outcomeFlash.color}`,
            background: `${outcomeFlash.color}18`,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 0 32px ${outcomeFlash.color}40`,
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={outcomeFlash.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p style={{
            fontSize: 15, fontWeight: 700, letterSpacing: "0.06em",
            color: outcomeFlash.color, textAlign: "center",
          }}>{outcomeFlash.label}</p>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Loading next lead…</p>
        </div>
      )}
      <style>{`@keyframes ldFlashIn { from { opacity: 0; } to { opacity: 1; } }`}</style>

      {/* ── Type bar ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 20px",
        background: "linear-gradient(135deg, rgba(200,170,90,0.12) 0%, rgba(200,170,90,0.04) 100%)",
        borderBottom: "1px solid rgba(200,170,90,0.2)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase",
            color: "#c8aa5a", fontWeight: 700,
          }}>
            {typeLabel[lead.leadType] || lead.leadType}
          </span>
          {/* v15.3 — Intent badge (per INTENT_SPEC Q2): Gold=Sell, Blue=Buy,
              Gold→Blue gradient=Sell&Buy. Reads from lead.intent (or legacy alsoBuying).
              Only shows when intent is explicitly set so unlogged leads stay clean. */}
          {(() => {
            const rawIntent = (lead as any).intent as string | null | undefined;
            const derived = rawIntent || ((lead as any).alsoBuying ? "sell_and_buy" : null);
            if (!derived) return null;
            const styles: Record<string, { bg: string; fg: string; border: string; label: string; title: string }> = {
              sell_only:    { bg: "rgba(200,170,90,0.18)", fg: "#c8aa5a", border: "rgba(200,170,90,0.55)", label: "SELL",       title: "Seller intent — CPMAMA script" },
              buy_only:     { bg: "rgba(147,197,253,0.18)", fg: "#93c5fd", border: "rgba(59,130,246,0.55)", label: "BUY",       title: "Buyer intent — Buyer LPMAMA script" },
              sell_and_buy: { bg: "linear-gradient(90deg, rgba(200,170,90,0.22) 0%, rgba(147,197,253,0.22) 100%)", fg: "#f0f0f0", border: "rgba(200,170,90,0.5)", label: "SELL & BUY", title: "Multi-transaction — CPMAMA + Buyer LPMAMA" },
            };
            const s = styles[derived];
            if (!s) return null;
            return (
              <span
                title={s.title}
                data-testid="intent-badge"
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  height: 20, padding: "0 8px",
                  borderRadius: 10, fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
                  background: s.bg,
                  color: s.fg,
                  border: `1px solid ${s.border}`,
                  cursor: "default", whiteSpace: "nowrap",
                }}>
                {s.label}
              </span>
            );
          })()}
          {/* Score badge — only show for leads with a BatchLeads/pipeline score */}
          {(lead as any).score > 0 && (
            <span title={`Lead score: ${(lead as any).score} — higher = more motivated seller`} style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              minWidth: 26, height: 20, padding: "0 6px",
              borderRadius: 10, fontSize: 10, fontWeight: 800, letterSpacing: "0.05em",
              background: (lead as any).score >= 12
                ? "linear-gradient(135deg,#c8aa5a,#a8893a)"
                : (lead as any).score >= 7
                ? "rgba(200,170,90,0.25)"
                : "rgba(255,255,255,0.1)",
              color: (lead as any).score >= 12 ? "#080808" : "#c8aa5a",
              border: (lead as any).score >= 12 ? "none" : "1px solid rgba(200,170,90,0.4)",
              cursor: "default",
            }}>
              {(lead as any).score}
            </span>
          )}
          {/* v14.0 — Territory badge removed. Kept the render guard so old data is a no-op. */}
          {false && (lead as any).territory && (
            <span style={{
              fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase",
              color: "rgba(200,170,90,0.55)", fontWeight: 600,
            }}>
              {String((lead as any).territory).replace(/_/g, " ")}
            </span>
          )}
        </div>
        <span style={{ fontSize: 11, color: "rgba(200,170,90,0.45)", letterSpacing: "0.1em" }}>
          #{lead.id}
        </span>
      </div>

      {/* ── Lead info ── */}
      <div style={{ padding: "22px 20px 16px" }}>
        <h2 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "clamp(1.8rem,7vw,2.4rem)", fontWeight: 400,
          color: "#fff", letterSpacing: "0.01em", marginBottom: 6, lineHeight: 1.1,
        }}>
          {lead.ownerName || "Unknown Owner"}
        </h2>

        {lead.address && (
          <p style={{
            fontSize: 13, color: "rgba(255,255,255,0.6)",
            display: "flex", alignItems: "flex-start", gap: 6,
            marginBottom: 12, lineHeight: 1.4,
          }}>
            <MapPin size={13} style={{ marginTop: 1, flexShrink: 0, color: "#c8aa5a" }} />
            {lead.address}
          </p>
        )}

        {/* ── v14.22 — Intel strip (pills under address) ── */}
        <IntelStrip lead={lead as any} />

        {/* ── v14.11 — Line indicator ── */}
        {allPhones.length > 0 && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 10, paddingBottom: 8,
            borderBottom: "1px solid rgba(200,170,90,0.15)",
          }}>
            <span style={{
              fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase",
              color: "#c8aa5a", fontWeight: 700,
            }}>
              {allPhones.length === 1 ? "Single Line" : `Line ${Math.max(1, allPhones.findIndex(p => p === activePhone) + 1)} of ${allPhones.length}`}
            </span>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", letterSpacing: "0.08em" }}>
              {untriedCount > 0 ? `${untriedCount} untried` : ""}
              {untriedCount > 0 && triedTodayCount > 0 ? " · " : ""}
              {triedTodayCount > 0 ? `${triedTodayCount} tried today` : ""}
            </span>
          </div>
        )}

        {/* ── v14.52 — ELEGANT DIAL CARD: only the active line renders. Inactive rows removed entirely
            for max visual relief. The header above already shows `LINE 1 OF 5 · 5/5 viable` so counts
            aren't lost; struck/no-answer state is surfaced via the header “N struck / N tried today” chips. ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {/* v14.74 — "Who am I calling?" chip above the Dial button. Pulls from
              extra.phoneMeta[] (populated by the LandVoice/BatchLeads importer)
              and shows the person's name + role + DNC badge for the current line. */}
          {activePhone && Array.isArray(extra.phoneMeta) && (() => {
            const meta = extra.phoneMeta.find((m: any) => (m.number || "").replace(/\D/g, "").slice(-10) === (activePhone || "").replace(/\D/g, "").slice(-10));
            if (!meta) return null;
            return (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                padding: "6px 12px",
                background: "rgba(200,170,90,0.06)",
                border: "1px solid rgba(200,170,90,0.18)",
                borderRadius: 8, marginBottom: 4,
                flexWrap: "wrap",
              }}>
                {meta.personName && (
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", fontWeight: 600 }}>
                    {meta.personName}
                  </span>
                )}
                {meta.role && (
                  <span style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>
                    {meta.role}
                  </span>
                )}
                {meta.dnc && (
                  <span style={{
                    padding: "2px 8px", borderRadius: 999,
                    background: "rgba(252,165,165,0.15)", border: "1px solid rgba(252,165,165,0.4)",
                    fontSize: 10, letterSpacing: "0.12em", color: "#fca5a5", fontWeight: 700,
                  }}>
                    DNC — do not call
                  </span>
                )}
              </div>
            );
          })()}
          {/* Gold Dial button — the only phone-line UI element on the card */}
          {activePhone && (() => {
            const activeIdx = allPhones.findIndex(p => p === activePhone);
            return (
              <a
                href={(dialHardBlocked || dialNeedsConfirm) ? undefined : `tel:${activePhone}`}
                onClick={(e) => {
                  // v15.11.13 — Three-tier gate:
                  //   1) Illegal hours → hard block, destructive toast, NO override path.
                  //   2) Legal-but-not-Prime → open confirm sheet; agent may proceed.
                  //   3) Prime → native tel: link fires with no interruption.
                  if (dialHardBlocked) {
                    e.preventDefault();
                    toast({
                      title: "Afterhours — dialing blocked",
                      description: cardHeat.reason || "Outside Florida's 8 AM – 8 PM legal window. Wait until 8 AM (Fla. Stat. § 501.616).",
                      variant: "destructive",
                    });
                    return;
                  }
                  if (dialNeedsConfirm) {
                    e.preventDefault();
                    setPendingDialConfirm(activePhone);
                  }
                }}
                aria-disabled={dialHardBlocked}
                data-testid={dialHardBlocked ? "dial-line-locked" : dialNeedsConfirm ? "dial-line-confirm" : "dial-line"}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  gap: 2, padding: "11px 18px",
                  background: dialLocked
                    ? "linear-gradient(135deg,#2a2a2a 0%,#1a1a1a 100%)"
                    : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                  borderRadius: 10, textDecoration: "none",
                  color: dialLocked ? "#6b7280" : "#080808", minHeight: 56,
                  border: `1px solid ${dialLocked ? "rgba(107,114,128,0.35)" : "#e8c96a"}`,
                  boxShadow: dialLocked ? "none" : "0 4px 14px rgba(200,170,90,0.28)",
                  opacity: dialLocked ? 0.7 : 1,
                  cursor: dialLocked ? "not-allowed" : "pointer",
                }}>
                <span style={{
                  fontSize: 8, letterSpacing: "0.22em", fontWeight: 800,
                  color: dialLocked ? "rgba(255,255,255,0.35)" : "rgba(8,8,8,0.6)",
                }}>
                  {dialHardBlocked ? "AFTERHOURS — LOCKED" : dialNeedsConfirm ? `${cardHeat.label} — CONFIRM` : `DIAL LINE ${activeIdx + 1}`}
                </span>
                <span style={{
                  fontSize: "clamp(1.15rem, 5.2vw, 1.55rem)", fontWeight: 800,
                  letterSpacing: "0.02em", display: "flex", alignItems: "center", gap: 8,
                  lineHeight: 1,
                }}>
                  <Phone size={18} strokeWidth={2.5} /> {activePhone}
                </span>
              </a>
            );
          })()}
        </div>


        {/* v15.11.5 — All email affordances removed. Only Zillow link remains. */}
        {zillow && (
          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            <a href={zillow} target="_blank" rel="noopener noreferrer" style={{
              flex: 1, minWidth: 140,
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "13px 18px",
              background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.3)",
              borderRadius: 8, textDecoration: "none",
              fontSize: 13, color: "rgba(147,197,253,0.9)", minHeight: 48,
            }}>
              <TrendingUp size={13} /> Zillow
            </a>
          </div>
        )}

        {/* ── Motivation ── */}
        {lead.motivation && (
          <div style={{
            padding: "12px 16px", marginBottom: 16,
            background: "rgba(200,170,90,0.07)", border: "1px solid rgba(200,170,90,0.22)",
            borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start",
          }}>
            <AlertTriangle size={14} style={{ color: "#c8aa5a", marginTop: 1, flexShrink: 0 }} />
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", lineHeight: 1.55 }}>{lead.motivation}</p>
          </div>
        )}

        {/* ── Extra details ── */}
        {(extra.county || extra.propertyType || extra.estimatedValue || extra.timeframe) && (
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px",
            marginBottom: 14, padding: "12px 14px",
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
          }}>
            {extra.county && <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>County: <span style={{ color: "rgba(255,255,255,0.75)" }}>{extra.county}</span></p>}
            {extra.propertyType && <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Type: <span style={{ color: "rgba(255,255,255,0.75)" }}>{extra.propertyType}</span></p>}
            {extra.estimatedValue && <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Est. Value: <span style={{ color: "#c8aa5a" }}>{extra.estimatedValue}</span></p>}
            {extra.timeframe && <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Timeframe: <span style={{ color: "rgba(255,255,255,0.75)" }}>{extra.timeframe}</span></p>}
            {extra.source === "network" && extra.submittedByName && (
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 10px", borderRadius: 8, marginTop: 4,
                background: "rgba(200,170,90,0.1)", border: "1px solid rgba(200,170,90,0.25)",
              }}>
                <span style={{ fontSize: 12, color: "#c8aa5a", fontWeight: 600 }}>
                  🤝 Network Lead — referred by {extra.submittedByName}
                </span>
              </div>
            )}
            {extra.source === "network" && extra.networkNotes && (
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 2 }}>
                Referral notes: <span style={{ color: "rgba(255,255,255,0.75)" }}>{extra.networkNotes}</span>
              </p>
            )}
          </div>
        )}

        {/* v14.77 — Show only THIS agent's dials today, not the all-time all-agent
            attemptCount. Cards should feel fresh; seeing "18 previous attempts"
            from other agents subconsciously discourages effort. Hidden at 0. */}
        {(lead.myAttemptsToday ?? 0) > 0 && (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 4 }}>
            You've dialed this lead {lead.myAttemptsToday} time{lead.myAttemptsToday !== 1 ? "s" : ""} today
          </p>
        )}

        {/* v14.74 — LANDVOICE INTEL PANEL. Shows MLS pitch context, DOM,
            status, list agent, remarks, mailing-address flag, and per-phone
            owner + DNC badges. Rendered only when the CSV import provided
            these fields (LandVoice Expired / Listing / BatchLeads). */}
        {(extra.mlsNumber || extra.mlsStatus || extra.daysOnMarket != null || extra.listAgent || extra.ownerMailing || extra.remarks) && (() => {
          const propCity = (lead.city || "").trim().toLowerCase();
          const mailCity = (extra.ownerMailing?.city || "").trim().toLowerCase();
          const mailState = (extra.ownerMailing?.state || "").trim().toUpperCase();
          const outOfArea = mailCity && propCity && mailCity !== propCity;
          const outOfState = mailState && mailState !== "FL";
          const investorFlag = outOfState || outOfArea;
          return (
            <div style={{
              marginBottom: 12, padding: "12px 14px",
              background: "rgba(147,197,253,0.06)",
              border: "1px solid rgba(147,197,253,0.22)",
              borderRadius: 8,
            }}>
              <div style={{
                fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase",
                color: "rgba(147,197,253,0.7)", fontWeight: 700, marginBottom: 8,
              }}>Listing Intel</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px" }}>
                {extra.mlsNumber && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
                    MLS <span style={{ color: "rgba(255,255,255,0.85)", fontWeight: 600 }}>#{extra.mlsNumber}</span>
                  </div>
                )}
                {extra.mlsStatus && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
                    Status <span style={{ color: "#fca5a5", fontWeight: 600 }}>{extra.mlsStatus}</span>
                  </div>
                )}
                {extra.daysOnMarket != null && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
                    DOM <span style={{ color: "rgba(255,255,255,0.85)", fontWeight: 600 }}>{extra.daysOnMarket} days</span>
                  </div>
                )}
                {extra.beds != null && extra.baths != null && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
                    <span style={{ color: "rgba(255,255,255,0.85)" }}>{extra.beds}bd / {extra.baths}ba{extra.sqft ? ` · ${extra.sqft.toLocaleString()} sf` : ""}</span>
                  </div>
                )}
                {extra.yearBuilt && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
                    Built <span style={{ color: "rgba(255,255,255,0.85)" }}>{extra.yearBuilt}</span>
                  </div>
                )}
                {extra.listAgent && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", gridColumn: "1 / -1" }}>
                    Prev agent <span style={{ color: "rgba(255,255,255,0.85)" }}>{extra.listAgent}</span>
                    {extra.listOffice && <span style={{ color: "rgba(255,255,255,0.55)" }}> · {extra.listOffice}</span>}
                  </div>
                )}
                {extra.relisted && (
                  <div style={{ fontSize: 11, color: "#fcd34d", gridColumn: "1 / -1" }}>
                    ⚠️ Previously relisted — check for competing listings
                  </div>
                )}
                {extra.ownerIsAgent && (
                  <div style={{ fontSize: 11, color: "#fca5a5", gridColumn: "1 / -1" }}>
                    ⚠️ Owner is a licensed agent — approach as peer
                  </div>
                )}
                {investorFlag && (
                  <div style={{
                    gridColumn: "1 / -1", marginTop: 4,
                    padding: "6px 10px", borderRadius: 6,
                    background: "rgba(196,181,253,0.08)", border: "1px solid rgba(196,181,253,0.3)",
                    fontSize: 11, color: "#c4b5fd", fontWeight: 600,
                  }}>
                    🏠 {outOfState ? `Out-of-state investor (${mailState})` : `Absentee owner — lives in ${extra.ownerMailing.city}`}
                  </div>
                )}
                {extra.ownerOccupied === true && (
                  <div style={{ fontSize: 11, color: "#86efac", gridColumn: "1 / -1" }}>
                    ✓ Owner-occupied
                  </div>
                )}
              </div>
              {extra.remarks && (
                <div style={{
                  marginTop: 10, paddingTop: 10,
                  borderTop: "1px solid rgba(147,197,253,0.15)",
                  fontSize: 12, color: "rgba(255,255,255,0.7)", lineHeight: 1.5,
                  fontStyle: "italic",
                }}>
                  “{extra.remarks.length > 220 ? extra.remarks.slice(0, 220) + "…" : extra.remarks}”
                </div>
              )}
            </div>
          );
        })()}
      </div>

      <GoldDivider />

      {/* v14.20 ── CALL SCRIPT (Tone Rules / Guardrails / Branch Cues moved to Scripts admin) ── */}
      <div style={{ padding: "18px 20px 20px" }}>
        <SectionLabel>Call Script</SectionLabel>
        <pre style={{
          fontSize: 13, color: "rgba(255,255,255,0.78)", whiteSpace: "pre-wrap", lineHeight: 1.7,
          fontFamily: "'Switzer','Inter',sans-serif",
          background: "rgba(200,170,90,0.04)",
          border: "1px solid rgba(200,170,90,0.22)", borderRadius: 10, padding: "16px 16px 14px",
          maxHeight: 260, overflowY: "auto", margin: 0,
        }}>
          {script?.content || "No script saved for this lead type."}
        </pre>
      </div>

      {/* v14.53 ── INTENT SELECTOR (3-way, mutually exclusive) ──
          Drives which script card renders. Sell only → CPMAMA. Sell & Buy → CPMAMA + LPMAMA. Buy only → LPMAMA. */}
      <div style={{ padding: "0 20px 14px" }}>
        <div style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 12, padding: "12px 12px 10px",
        }}>
          <p style={{ margin: "0 0 8px", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>
            Intent · pick one
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            {([
              { key: "sell_only",    label: "Sell only",   bg: "rgba(200,170,90,0.20)",  fg: "#c8aa5a", border: "rgba(200,170,90,0.55)" },
              { key: "sell_and_buy", label: "Sell & Buy",  bg: "rgba(147,197,253,0.22)", fg: "#93c5fd", border: "rgba(59,130,246,0.60)" },
              { key: "buy_only",     label: "Buy only",    bg: "rgba(147,197,253,0.22)", fg: "#93c5fd", border: "rgba(59,130,246,0.60)" },
            ] as const).map(opt => {
              const active = intent === opt.key;
              return (
                <button key={opt.key} onClick={() => setIntent(opt.key)}
                  style={{
                    minHeight: 40,
                    background: active ? opt.bg : "rgba(255,255,255,0.02)",
                    border: `1px solid ${active ? opt.border : "rgba(255,255,255,0.10)"}`,
                    color: active ? opt.fg : "rgba(255,255,255,0.55)",
                    borderRadius: 8, padding: "8px 6px",
                    fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
                    cursor: "pointer", transition: "all 0.15s ease",
                  }}
                >{opt.label}</button>
              );
            })}
          </div>
        </div>
      </div>

      {/* v14.53 ── SELLER CPMAMA (was LPMAMA; L→C for Condition) ── */}
      {showSellerCard && (
      <div style={{ padding: "0 20px 20px" }}>
        <div style={{
          background: "linear-gradient(180deg, rgba(200,170,90,0.06), rgba(200,170,90,0.02))",
          border: "1px solid rgba(200,170,90,0.22)", borderRadius: 12,
          padding: "14px 14px 12px",
        }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
            <SectionLabel style={{ margin: 0 }}>Seller CPMAMA</SectionLabel>
            {SELLER_LPMAMA_FIELDS.some(f => lpmData[f.key]?.trim()) && (
              <span style={{ fontSize: 9, letterSpacing: "0.12em", color: "#c8aa5a", background: "rgba(200,170,90,0.14)", padding: "2px 8px", borderRadius: 99 }}>
                FILLED
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {SELLER_LPMAMA_FIELDS.map(f => (
              <div key={f.key}>
                <label style={{ display: "block", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: f.color, fontWeight: 700, marginBottom: 5, opacity: 0.85 }}>{f.label}</label>
                <input
                  value={lpmData[f.key] ?? ""}
                  onChange={e => setLpmData(d => ({ ...d, [f.key]: e.target.value }))}
                  placeholder={f.hint}
                  style={{
                    width: "100%",
                    background: "rgba(255,255,255,0.05)",
                    border: `1px solid ${lpmData[f.key]?.trim() ? f.color + "66" : "rgba(255,255,255,0.10)"}`,
                    padding: "10px 12px", borderRadius: 8,
                    color: "#fff", fontSize: 13,
                    fontFamily: "'Switzer','Inter',sans-serif",
                    outline: "none", boxSizing: "border-box" as const,
                    transition: "border-color 0.15s",
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      )}

      {/* v14.53 ── Also-Buying pill removed; Intent selector above the seller card now drives visibility. ── */}

      {/* v14.53 ── BUYER LPMAMA (renders when intent !== sell_only) ── */}
      {/* v15.11.17 — Home Specifications on Buy / Sell&Buy cards.
          Shows the property specs Alex wants agents to reference when
          matching or qualifying: beds, baths, sqft, lot, year built,
          list price. Data comes from extraData JSON on the lead row
          (LandVoice / BatchLeads / MLS import). Compact grid, no inputs;
          purely reference. Renders only when at least one spec exists. */}
      {showBuyerCard && (() => {
        const specs: Array<{ label: string; value: string }> = [];
        if (extra.beds != null) specs.push({ label: "Beds", value: String(extra.beds) });
        if (extra.baths != null) specs.push({ label: "Baths", value: String(extra.baths) });
        if (extra.sqft != null) specs.push({ label: "Sqft", value: Number(extra.sqft).toLocaleString() });
        if (extra.lotSizeAcres != null) specs.push({ label: "Lot", value: `${extra.lotSizeAcres} ac` });
        if (extra.yearBuilt) specs.push({ label: "Built", value: String(extra.yearBuilt) });
        if (extra.garage != null) specs.push({ label: "Garage", value: typeof extra.garage === "boolean" ? (extra.garage ? "Yes" : "No") : String(extra.garage) });
        if (extra.pool != null) specs.push({ label: "Pool", value: typeof extra.pool === "boolean" ? (extra.pool ? "Yes" : "No") : String(extra.pool) });
        if (extra.listPrice != null) specs.push({ label: "List $", value: `$${Number(extra.listPrice).toLocaleString()}` });
        else if (lead.list_price != null) specs.push({ label: "List $", value: `$${Number(lead.list_price).toLocaleString()}` });
        if (specs.length === 0) return null;
        return (
          <div style={{ padding: "0 20px 12px" }}>
            <div style={{
              background: "linear-gradient(180deg, rgba(59,130,246,0.08), rgba(59,130,246,0.02))",
              border: "1px solid rgba(59,130,246,0.28)", borderRadius: 12,
              padding: "12px 14px",
            }}>
              <p style={{ margin: "0 0 8px", fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(147,197,253,0.85)", fontWeight: 600 }}>
                Home Specifications
              </p>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
                gap: "6px 12px",
              }}>
                {specs.map(s => (
                  <div key={s.label} style={{ fontSize: 11, color: "rgba(255,255,255,0.55)" }}>
                    {s.label} <span style={{ color: "rgba(255,255,255,0.9)", fontWeight: 600 }}>{s.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {showBuyerCard && (
        <div style={{ padding: "0 20px 18px" }}>
          <div style={{
            background: "linear-gradient(180deg, rgba(59,130,246,0.08), rgba(59,130,246,0.02))",
            border: "1px solid rgba(59,130,246,0.28)", borderRadius: 12,
            padding: "14px 14px 12px",
          }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
              <p style={{ margin: 0, fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(147,197,253,0.85)", fontWeight: 600 }}>Buyer LPMAMA</p>
              {BUYER_LPMAMA_FIELDS.some(f => lpmData[f.key]?.trim()) && (
                <span style={{ fontSize: 9, letterSpacing: "0.12em", color: "#93c5fd", background: "rgba(59,130,246,0.18)", padding: "2px 8px", borderRadius: 99 }}>
                  FILLED
                </span>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {BUYER_LPMAMA_FIELDS.map(f => (
                <div key={f.key}>
                  <label style={{ display: "block", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: f.color, fontWeight: 700, marginBottom: 5, opacity: 0.85 }}>{f.label}</label>
                  <input
                    value={lpmData[f.key] ?? ""}
                    onChange={e => setLpmData(d => ({ ...d, [f.key]: e.target.value }))}
                    placeholder={f.hint}
                    style={{
                      width: "100%",
                      background: "rgba(255,255,255,0.05)",
                      border: `1px solid ${lpmData[f.key]?.trim() ? f.color + "66" : "rgba(255,255,255,0.10)"}`,
                      padding: "10px 12px", borderRadius: 8,
                      color: "#fff", fontSize: 13,
                      fontFamily: "'Switzer','Inter',sans-serif",
                      outline: "none", boxSizing: "border-box" as const,
                      transition: "border-color 0.15s",
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* v14.20 ── CALL NOTES (last before outcomes) ── */}
      <div style={{ padding: "0 20px 18px" }}>
        <SectionLabel>Call Notes</SectionLabel>
        <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything else worth capturing…"
          className="min-h-[90px] text-sm leading-relaxed resize-none"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(200,170,90,0.22)",
            color: "rgba(255,255,255,0.9)",
            fontFamily: "'Switzer','Inter',sans-serif",
            borderRadius: 10, padding: "12px 14px",
          }}
        />
      </div>

      {/* v14.43 ── spacer: 3-row sticky outcomes bar (~200px) + bottom nav (~62px) + safe area */}
      {/* v14.79 — slightly taller to match new grid bottom padding */}
      {/* v15.0 — bumped from 274 → 288 to match the extra 14px of container
          bottom padding on the sticky outcomes bar (10 → 24). Keeps the pipeline
          scroll from clipping under the bar. */}
      <div aria-hidden style={{ height: 288 }} />

      {/* v14.42 ── STICKY OUTCOMES BAR — 3x3, ALL rows above mobile chrome */}
      {/* Fix: prior version rendered a 3rd row that landed under iPhone Safari's */}
      {/* dynamic URL bar / home indicator on some devices. Now uses tighter minHeight, */}
      {/* smaller padding, and reserves the exact 3-row height so Row 3 (Appt Set / KIT / Left VM) */}
      {/* is always visible without scrolling. */}
      <div style={{
        position: "fixed", left: 0, right: 0,
        // v14.43 — lift above the bottom nav (h ≈ 62px + safe-area) so Row 3 (Appt Set / KIT / Left VM)
        // is not covered. Prior version had bottom:0 which put Row 3 UNDER the Dashboard/Refer nav bar.
        bottom: "calc(62px + env(safe-area-inset-bottom, 0px))",
        zIndex: 40,
        background: "linear-gradient(180deg, rgba(10,14,22,0.75) 0%, rgba(10,14,22,0.96) 30%, rgba(10,14,22,0.98) 100%)",
        backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        borderTop: "1px solid rgba(200,170,90,0.22)",
        // v14.79 — match top pad on bottom (was 8px top / 8px bottom, but the FAB
        // pressed-in state still needed a hair more room to clear "Keep in Touch"
        // in the middle column). Now 10px both sides.
        // v15.0 — increased bottom pad from 10px to 24px so Row 3 (Appt Set /
        // KIT / Left VM) has visible breathing room above the Dashboard/Dial/
        // Referrals nav. Top gets a soft gradient fade-in that reads as ~40px
        // of visual room; bottom used to hit the nav bar edge with no gap.
        // Matches Alex's IMG_9286 report: "padding wasn't added under the
        // outcome buttons like we discussed. equal to the padding above."
        padding: "10px 12px 24px",
      }}>
        {/* v15.11.12 — One-tap access to the outcome-meanings legend so agents
            can check any definition mid-call without leaving the dial screen. */}
        <div style={{ maxWidth: 640, margin: "0 auto 6px", display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={() => setLegendOpen(true)}
            style={{
              background: "rgba(200,170,90,0.10)",
              border: "1px solid rgba(200,170,90,0.28)",
              color: "rgba(200,170,90,0.9)",
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
            aria-label="Show outcome meanings"
          >
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 14, height: 14, borderRadius: 999,
              border: "1px solid rgba(200,170,90,0.55)",
              fontSize: 10, fontWeight: 800,
            }}>?</span>
            What each outcome means
          </button>
        </div>
        <div style={{ maxWidth: 640, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "repeat(3, 1fr)", gap: 5 }}>
          {OUTCOMES.map(o => {
            const Icon = o.icon;
            const isHovered = hoveredOutcome === o.key;
            // v14.80 — Tier 3: Appt Set tile gets a 400ms gold shimmer sweep + chime
            // right after it's tapped (see apptShimmerKey / outcomeMutation.onSuccess).
            const isApptTile = o.key === "contacted_appointment";
            const showShimmer = isApptTile && apptShimmerKey > 0;
            return (
              <button key={o.key} className="outcome-btn" onClick={() => handleOutcome(o.key)} disabled={outcomeMutation.isPending}
                onMouseEnter={() => setHoveredOutcome(o.key)} onMouseLeave={() => setHoveredOutcome(null)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
                  padding: "6px 4px", position: "relative", overflow: "hidden",
                  // v14.79 — fuller look: brighter tinted bg + subtle inner sheen so tiles feel
                  // dimensional instead of flat against the dark card. Sheen is a light
                  // top-highlight fading to the base tint (creates a soft "glass" feel).
                  background: isHovered
                    ? `linear-gradient(180deg, rgba(255,255,255,0.08) 0%, ${o.hoverBg} 65%)`
                    : `linear-gradient(180deg, rgba(255,255,255,0.06) 0%, ${o.bg} 65%)`,
                  border: `1px solid ${isHovered ? o.text : o.border}`,
                  borderRadius: 9, cursor: "pointer",
                  transition: "all 0.18s ease", minHeight: 46,
                  boxShadow: isHovered
                    ? `0 2px 8px ${o.border}, inset 0 1px 0 rgba(255,255,255,0.08)`
                    : `inset 0 1px 0 rgba(255,255,255,0.06)`,
                  opacity: outcomeMutation.isPending ? 0.6 : 1,
                }}
              >
                <Icon size={14} style={{ color: o.text }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: o.text, letterSpacing: "0.02em", textAlign: "center", lineHeight: 1.15 }}>{o.label}</span>
                {showShimmer && (
                  <span key={apptShimmerKey} aria-hidden style={{
                    position: "absolute", inset: 0,
                    background: "linear-gradient(100deg, transparent 30%, rgba(255,241,199,0.55) 50%, transparent 70%)",
                    backgroundSize: "250% 100%",
                    animation: "apptShimmer 400ms ease-out",
                    pointerEvents: "none",
                  }} />
                )}
              </button>
            );
          })}
        </div>

        {/* v15.11.18 — Skip escape hatch. Sits below the outcome grid, styled
            as a quiet secondary action so agents don't reach for it as an outcome.
            Used when a lead is glitched, already theirs, or otherwise stuck. */}
        {(() => {
          const q = skipQuota;
          const remaining = q?.remaining ?? 3;
          const cap = q?.cap ?? 3;
          const inCooldown = q?.inCooldown ?? false;
          const outOfSkips = remaining <= 0;
          const disabled = outOfSkips || inCooldown;
          const cooldownMins = q?.cooldownExpiresAt
            ? Math.max(0, Math.ceil((new Date(q.cooldownExpiresAt).getTime() - Date.now()) / 60_000))
            : 0;
          const label = outOfSkips ? `${cap}/${cap} skips used — resets midnight`
            : inCooldown ? `Skip cooldown — ${cooldownMins}m left`
            : `Skip lead (${remaining} left today)`;
          return (
            <div style={{ maxWidth: 640, margin: "10px auto 0", textAlign: "center" }}>
              <button
                onClick={() => { if (!disabled) setPendingSkip(true); }}
                disabled={disabled}
                style={{
                  fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase",
                  padding: "6px 14px", borderRadius: 7,
                  background: "transparent",
                  border: `1px solid ${disabled ? "rgba(255,255,255,0.08)" : "rgba(200,170,90,0.28)"}`,
                  color: disabled ? "rgba(255,255,255,0.28)" : "rgba(200,170,90,0.75)",
                  cursor: disabled ? "default" : "pointer",
                  fontWeight: 600,
                }}
              >
                {label}
              </button>
            </div>
          );
        })()}
      </div>

      {/* Appt / Keep-in-Touch modal */}
      {pendingOutcome && (
        <ApptModal
          lead={lead}
          outcome={pendingOutcome}
          onClose={() => setPendingOutcome(null)}
          onSubmit={handleApptSubmit}
          isPending={outcomeMutation.isPending}
        />
      )}

      {/* v15.11.12 — Outcome meanings legend, opened from the "?" pill above the grid. */}
      {legendOpen && <OutcomeLegendSheet onClose={() => setLegendOpen(false)} />}

      {/* v15.11.13 — Dial confirmation for Mid + Downtime (still-legal hours).
          Illegal-hour dials never reach this sheet — they're hard-blocked upstream. */}
      {pendingDialConfirm && (
        <OutcomeConfirmSheet
          label={`Dial anyway during ${cardHeat.label.toLowerCase().replace(" time","")}?`}
          toneColor={cardHeat.color}
          borderColor={cardHeat.color}
          description={cardHeat.reason + " You're still within Florida's legal 8 AM – 8 PM window — tap Dial to proceed."}
          onClose={() => setPendingDialConfirm(null)}
          onConfirm={() => {
            const num = pendingDialConfirm;
            setPendingDialConfirm(null);
            // Fire the native tel: link programmatically now that agent confirmed.
            if (num) window.location.href = `tel:${num}`;
          }}
          isPending={false}
        />
      )}

      {/* v15.11.12 — Generic confirm sheet for outcomes without their own modal.
          Fires when agent taps No Answer, Wrong #, Not a Working Line, Listed,
          or Owner-No Answer. Cancel returns to the dial view, confirm fires. */}
      {pendingConfirm && (() => {
        const cfg = OUTCOMES.find(o => o.key === pendingConfirm);
        if (!cfg) return null;
        return (
          <OutcomeConfirmSheet
            label={cfg.label}
            toneColor={cfg.text}
            borderColor={cfg.border}
            description={OUTCOME_MEANINGS[pendingConfirm] || "Log this outcome for the current call."}
            onClose={() => setPendingConfirm(null)}
            onConfirm={handleConfirmOutcome}
            isPending={outcomeMutation.isPending}
          />
        );
      })()}

      {/* v15.11.11 — Not Interested two-branch sheet (Nice=180d recycle / Rude=delete) */}
      {pendingNotInterested && (
        <NotInterestedModal
          onClose={() => setPendingNotInterested(false)}
          onNice={handleNotInterestedNice}
          onRude={handleNotInterestedRude}
          isPending={outcomeMutation.isPending}
        />
      )}

      {/* Recycle confirm sheet */}
      {pendingRecycle && (
        <RecycleModal
          onClose={() => setPendingRecycle(false)}
          onSubmit={handleRecycleSubmit}
          isPending={outcomeMutation.isPending}
        />
      )}

      {/* v15.11.18 — Skip confirm sheet */}
      {pendingSkip && (
        <SkipModal
          onClose={() => setPendingSkip(false)}
          onSubmit={() => skipMutation.mutate()}
          isPending={skipMutation.isPending}
          remaining={skipQuota?.remaining ?? 3}
          cap={skipQuota?.cap ?? 3}
          inCooldown={skipQuota?.inCooldown ?? false}
          cooldownExpiresAt={skipQuota?.cooldownExpiresAt ?? null}
        />
      )}
    </div>
  );
}

// ─── Leaderboard Tab ──────────────────────────────────────────────────────────
interface AgentStat {
  agent: { id: number; name: string; email: string; headshotUrl?: string | null };
  appointmentsSet: number;
  totalAttempts: number;
  emailsSent?: number;
  contactRate: number;
  points?: number;                   // v14.24 — unified leaderboard metric
  outcomes: Record<string, number>;
}

// v14.16 — "Who called me?" modal. Agent types last 4 digits, gets back matching leads with owner/address/agent-of-record.
// v14.49 — Exported so AdminDashboard can reuse the same modal.
// v14.50 — Accepts 4–15 digits (for disambiguation) and optional onPickLead for jump-to-lead.
export function CallbackLookupModal({ onClose, onPickLead }: { onClose: () => void; onPickLead?: (leadId: number) => void }) {
  const [digits, setDigits] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const currentAgentId = (user as any)?.id;
  const [claiming, setClaiming] = useState<number | null>(null);

  const cleanDigits = digits.replace(/\D/g, "");
  const shouldFetch = submitted && cleanDigits.length >= 4;
  const { data, isLoading, isError, refetch } = useQuery<any>({
    queryKey: ["/api/leads/callback-lookup", cleanDigits],
    queryFn: () => apiRequest("GET", `/api/leads/callback-lookup?last4=${cleanDigits}`).then(r => r.json()),
    enabled: shouldFetch,
    staleTime: 0,
  });

  const results: any[] = Array.isArray(data?.results) ? data.results : [];

  // v14.68 — First-lookup-wins claim. Sends the lead's original primary phone
  // (from the search result) so the Dial page opens on the number that called back.
  async function claimLead(r: any) {
    if (!currentAgentId) return;
    setClaiming(r.leadId);
    try {
      const resp = await apiRequest("POST", `/api/leads/${r.leadId}/claim-callback`, {
        agentId: currentAgentId,
        phone: r.phone,
      });
      const j = await resp.json();
      if (resp.status === 409) {
        toast({
          title: "Already claimed",
          description: j?.owner?.name ? `${j.owner.name} owns this lead.` : "This lead is owned by another agent.",
          variant: "destructive",
        });
      } else if (j.claimed) {
        toast({ title: "Lead claimed — opening in Dial", description: r.ownerName || r.address || "" });
        qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
        qc.invalidateQueries({ queryKey: ["/api/leads/my-count/3"] });
        qc.invalidateQueries({ queryKey: ["/api/leads/my-pipeline"] });
        if (onPickLead) onPickLead(r.leadId);
        onClose();
      } else if (j.reason === "already_yours") {
        toast({ title: "Already yours", description: "Opening lead card…" });
        if (onPickLead) onPickLead(r.leadId);
        onClose();
      }
      refetch();
    } catch (e: any) {
      toast({ title: "Claim failed", description: e?.message || "Try again in a moment.", variant: "destructive" });
    } finally {
      setClaiming(null);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        zIndex: 100, padding: "60px 16px 16px",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 460,
          background: "#0a0a0a", border: "1px solid rgba(200,170,90,0.25)",
          borderRadius: 14, padding: 20, color: "#fff",
          maxHeight: "calc(100vh - 80px)", overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.35rem", fontWeight: 400, letterSpacing: "0.02em" }}>
            Who called me?
          </h3>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontSize: 20 }}>×</button>
        </div>
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginBottom: 14, lineHeight: 1.5 }}>
          Enter the <b style={{ color: "#c8aa5a" }}>last 4+ digits</b> of the number that just called you. Type more digits to narrow down when multiple leads match.
        </p>

        <form
          onSubmit={e => { e.preventDefault(); if (cleanDigits.length >= 4) setSubmitted(true); }}
          style={{ display: "flex", gap: 8, marginBottom: 16 }}
        >
          <input
            inputMode="numeric"
            maxLength={15}
            value={digits}
            onChange={e => { setDigits(e.target.value.replace(/\D/g, "").slice(0, 15)); setSubmitted(false); }}
            placeholder="1234"
            autoFocus
            style={{
              flex: 1, padding: "12px 14px", fontSize: 16, letterSpacing: "0.24em",
              background: "rgba(255,255,255,0.05)", color: "#fff",
              border: "1px solid rgba(200,170,90,0.25)", borderRadius: 8, textAlign: "center", fontWeight: 600,
            }}
          />
          <button
            type="submit"
            disabled={cleanDigits.length < 4}
            style={{
              padding: "0 18px", fontSize: 13, fontWeight: 700,
              background: cleanDigits.length >= 4 ? "#c8aa5a" : "rgba(200,170,90,0.3)",
              color: "#0a0a0a", border: "none", borderRadius: 8,
              cursor: cleanDigits.length >= 4 ? "pointer" : "not-allowed",
            }}
          >
            Look up
          </button>
        </form>

        {shouldFetch && isLoading && (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", textAlign: "center", padding: 20 }}>Searching…</p>
        )}
        {shouldFetch && isError && (
          <p style={{ fontSize: 12, color: "rgb(252,165,165)", textAlign: "center", padding: 20 }}>Lookup failed. Try again.</p>
        )}
        {shouldFetch && !isLoading && !isError && results.length === 0 && (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", textAlign: "center", padding: 20, lineHeight: 1.5 }}>
            No lead in your depot with a phone containing <b>{cleanDigits}</b>.<br />It's probably a personal call.
          </p>
        )}
        {shouldFetch && results.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {results.map((r: any) => (
              <div
                key={r.leadId}
                style={{
                  padding: 12,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(200,170,90,0.18)",
                  borderRadius: 10,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", marginBottom: 3 }}>
                  {r.ownerName || "Unknown"}
                </div>
                {r.address && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", marginBottom: 5 }}>
                    {r.address}{r.city ? `, ${r.city}` : ""}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "rgba(200,170,90,0.75)", letterSpacing: "0.03em", textTransform: "uppercase", marginBottom: 4 }}>
                  {r.phone}
                </div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.4 }}>
                  {r.assignedAgentName
                    ? <>Assigned to <b style={{ color: "#c8aa5a" }}>{r.assignedAgentName}</b>. </>
                    : <>Currently in the shared pool. </>}
                  {r.lastOutcome && (
                    <>Last touch: <b style={{ color: "rgba(255,255,255,0.75)" }}>{r.lastOutcome}</b>
                    {r.lastOutcomeAt ? ` — ${new Date(r.lastOutcomeAt).toLocaleString()}` : ""}
                    {r.lastOutcomeByAgent ? ` by ${r.lastOutcomeByAgent}` : ""}.</>
                  )}
                </div>
                {/* v14.68 — If the lead is in the shared pool (no owner), the agent
                    can CLAIM it right from the lookup. First lookup wins. */}
                {r.assignedAgentId == null ? (
                  <button
                    onClick={() => claimLead(r)}
                    disabled={claiming === r.leadId}
                    style={{
                      marginTop: 10, width: "100%", padding: "11px",
                      background: claiming === r.leadId
                        ? "rgba(200,170,90,0.35)"
                        : "linear-gradient(135deg,#10b981,#059669)",
                      color: "#fff", border: "none", borderRadius: 8,
                      fontSize: 12, fontWeight: 800, letterSpacing: "0.12em",
                      textTransform: "uppercase", cursor: claiming === r.leadId ? "wait" : "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                    }}
                  >
                    {claiming === r.leadId ? "Claiming…" : <>✓ Claim &amp; Open in Dial</>}
                  </button>
                ) : r.assignedAgentId === currentAgentId ? (
                  onPickLead && (
                    <button
                      onClick={() => { onPickLead(r.leadId); onClose(); }}
                      style={{
                        marginTop: 10, width: "100%", padding: "9px",
                        background: "linear-gradient(135deg,#c8aa5a,#a8893a)",
                        color: "#0a0700", border: "none", borderRadius: 8,
                        fontSize: 12, fontWeight: 700, letterSpacing: "0.1em",
                        textTransform: "uppercase", cursor: "pointer",
                      }}
                    >Open in Dial →</button>
                  )
                ) : (
                  <div style={{
                    marginTop: 10, padding: "9px 10px", borderRadius: 8,
                    background: "rgba(255,255,255,0.04)",
                    fontSize: 11, color: "rgba(255,255,255,0.55)", textAlign: "center", lineHeight: 1.4,
                  }}>
                    Owned by <b style={{ color: "#c8aa5a" }}>{r.assignedAgentName || "another agent"}</b> — reach out to them.
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// v15.3 — Optimal call-time meter. Displays receptivity right now (0-100),
// tier label (PRIME TIME / GOOD / OK / COLD), and a one-line reason drawn from
// the MIT/InsideSales, PhoneBurner, CallHippo, and Cognism studies. See
// client/src/lib/callHeat.ts for the full weight table + citations.
function CallHeatMeter() {
  // Re-compute every 60s so the meter drifts up/down without needing a manual refresh.
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(id);
  }, []);
  const heat = React.useMemo(() => computeCallHeat(), [tick]);

  // v15.11 — The pre-Prime banner + push have moved to the top-level OnAirBanner
  // component (rendered above every page in App.tsx). This inline meter now
  // only shows the current-tier receptivity card.
  const tierBg: Record<string, string> = {
    prime: "linear-gradient(135deg, rgba(239,68,68,0.16) 0%, rgba(239,68,68,0.06) 100%)",
    mid:   "linear-gradient(135deg, rgba(245,158,11,0.14) 0%, rgba(245,158,11,0.05) 100%)",
    down:  "linear-gradient(135deg, rgba(107,114,128,0.10) 0%, rgba(107,114,128,0.03) 100%)",
  };
  const tierBorder: Record<string, string> = {
    prime: "rgba(239,68,68,0.45)",
    mid:   "rgba(245,158,11,0.35)",
    down:  "rgba(255,255,255,0.10)",
  };
  return (
    <>
    <div
      data-testid="call-heat-meter"
      style={{
        margin: "0 20px 16px",
        padding: "12px 14px",
        background: tierBg[heat.tier],
        border: `1px solid ${tierBorder[heat.tier]}`,
        borderRadius: 12,
      }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
            background: heat.color,
            boxShadow: heat.tier === "prime" ? `0 0 8px ${heat.color}` : "none",
            animation: heat.tier === "prime" ? "livePulse 1.6s ease-in-out infinite" : "none",
          }} />
          <span style={{
            fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase",
            color: heat.color, fontWeight: 700,
          }}>
            {heat.label}
          </span>
        </div>
        <span style={{
          fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em",
          fontVariantNumeric: "tabular-nums",
        }}>
          {heat.score}/100 receptivity
        </span>
      </div>
      {/* Meter bar */}
      <div style={{
        position: "relative", height: 6, borderRadius: 3,
        background: "rgba(255,255,255,0.05)", overflow: "hidden", marginBottom: 8,
      }}>
        <div style={{
          width: `${heat.score}%`, height: "100%",
          background: heat.color,
          borderRadius: 3,
          transition: "width 300ms ease",
        }} />
      </div>
      <p style={{
        margin: 0, fontSize: 12, lineHeight: 1.4,
        color: "rgba(255,255,255,0.75)",
        fontFamily: "'Switzer','Inter',sans-serif",
      }}>
        {heat.reason}
      </p>
      {heat.nextPrimeWindow && (
        <p style={{
          margin: "4px 0 0", fontSize: 11,
          color: "rgba(200,170,90,0.65)", fontStyle: "italic",
        }}>
          {heat.nextPrimeWindow}
        </p>
      )}
    </div>
    </>
  );
}

function LeaderboardTab({ mode = "seller" }: { mode?: "seller" | "recruiting" } = {}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [netName, setNetName]   = useState("");
  const [netPhone, setNetPhone] = useState("");
  const [netEmail, setNetEmail] = useState("");
  const [netAddr, setNetAddr]   = useState("");
  const [netNotes, setNetNotes] = useState("");
  const [netSending, setNetSending] = useState(false);

  // v14.16 — Callback Lookup ("Who called me?") state
  const [lookupOpen, setLookupOpen] = useState(false);

  // v12.5 — recruiting depot pulls its own isolated leaderboard (agent_lead_activity),
  // seller depot pulls the seller-side leaderboard (lead_activity). Zero cross-bleed.
  const leaderboardUrl = mode === "recruiting" ? "/api/admin/recruiting/leaderboard" : "/api/agent/leaderboard";
  const { data: statsRaw, isLoading } = useQuery<any[]>({
    queryKey: [leaderboardUrl],
    queryFn: () => apiRequest("GET", leaderboardUrl).then(r => r.json()),
    refetchInterval: 60000,
  });
  // Normalise recruiting rows into the AgentStat shape used by the tab renderer.
  const stats: AgentStat[] = React.useMemo(() => {
    if (!Array.isArray(statsRaw)) return [];
    if (mode !== "recruiting") return statsRaw as AgentStat[];
    return statsRaw.map((r: any) => {
      const total = Number(r.total_dials || 0);
      const contacted = Number(r.hot_prospects || 0) + Number(r.joined || 0) + Number(r.not_interested || 0);
      return {
        agent: { id: r.caller_id, name: r.agent_name || "Unknown", email: "" },
        appointmentsSet: Number(r.joined || 0),
        totalAttempts: total,
        emailsSent: 0,
        contactRate: total > 0 ? Math.round((contacted / total) * 100) : 0,
        outcomes: {
          contacted_appointment: Number(r.joined || 0),
          no_answer: Number(r.no_answer || 0),
          keep_in_touch: Number(r.kit || 0),
        },
      } as AgentStat;
    });
  }, [statsRaw, mode]);

  const handleNetworkLead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!netName.trim() || !netPhone.trim()) {
      toast({ title: "Name and phone are required", variant: "destructive" }); return;
    }
    setNetSending(true);
    try {
      await apiRequest("POST", "/api/leads/network", {
        ownerName: netName.trim(), phone: netPhone.trim(),
        email: netEmail.trim(), address: netAddr.trim(),
        notes: netNotes.trim(), submittedBy: user?.id, submittedByName: user?.name,
      });
      setNetName(""); setNetPhone(""); setNetEmail(""); setNetAddr(""); setNetNotes("");
      qc.invalidateQueries({ queryKey: ["/api/leads/my-count"] });
      toast({ title: "Network lead submitted", description: "Assigned to you. Admins notified by email." });
    } catch {
      toast({ title: "Failed to submit lead", variant: "destructive" });
    } finally {
      setNetSending(false);
    }
  };

  const myStats = stats?.find(s => s.agent.id === user?.id);
  // v15.11.24 — UNIFIED SORT: Points → Dials → Appts. Matches admin leaderboard exactly.
  // Points are what determine #1 (they already weight appts heaviest and layer in tier
  // multipliers); dials break ties on raw effort; appts as final tiebreaker.
  const ranked  = stats ? [...stats].sort((a, b) =>
    ((b.points || 0) - (a.points || 0)) ||
    (b.totalAttempts - a.totalAttempts) ||
    (b.appointmentsSet - a.appointmentsSet)
  ) : [];

  // v15.11.24 — Gap-to-next-rank helper. Points-first, so show "X more points to catch [Name]".
  const myRankIdx = ranked.findIndex(s => s.agent.id === user?.id);
  const rankAbove = myRankIdx > 0 ? ranked[myRankIdx - 1] : null;
  const pointsGap = rankAbove ? Math.max(0, (rankAbove.points || 0) - (myStats?.points || 0)) : 0;
  const apptsGap  = rankAbove && pointsGap === 0 ? Math.max(0, rankAbove.appointmentsSet - (myStats?.appointmentsSet ?? 0)) : 0;

  // v14.80 — Tier 3: rank-up toast + lift sound. Tracks the previous rank in a ref;
  // when the rank NUMBER decreases (i.e. climbing the board), fires a toast naming
  // whoever we just passed, plus a quick ascending "lift" chime.
  const prevRankIdxRef = useRef<number | null>(null);
  useEffect(() => {
    if (myRankIdx < 0 || !ranked.length) return;
    const prev = prevRankIdxRef.current;
    if (prev !== null && myRankIdx < prev) {
      // The agent now sitting one spot below us (index myRankIdx+1) is the one
      // we just overtook, since we moved into their old slot.
      const passedName = ranked[myRankIdx + 1]?.agent?.name ?? "the next spot";
      toast({ title: `↑ You just passed ${passedName}.` });
      playSound("lift");
    }
    prevRankIdxRef.current = myRankIdx;
  }, [myRankIdx, ranked.length]);

  return (
    <div style={{ width: "100%", padding: "0 0 20px" }}>

      {/* v14.16 — "Who called me?" quick-lookup button (visible on Dashboard for fast access from a lead callback) */}
      {mode === "seller" && (
        <div style={{ padding: "0 20px 14px" }}>
          <button
            onClick={() => setLookupOpen(true)}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
              gap: 8, padding: "12px 14px",
              background: "rgba(200,170,90,0.10)",
              border: "1px solid rgba(200,170,90,0.35)",
              borderRadius: 10, color: "#c8aa5a",
              fontSize: 13, fontWeight: 600, letterSpacing: "0.04em",
              cursor: "pointer", transition: "background 0.15s ease",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(200,170,90,0.18)")}
            onMouseLeave={e => (e.currentTarget.style.background = "rgba(200,170,90,0.10)")}
          >
            <PhoneCall size={14} />
            Who called me?
          </button>
        </div>
      )}
      {lookupOpen && <CallbackLookupModal onClose={() => setLookupOpen(false)} />}

      {/* v15.3 — Optimal call-time meter (seller depot only). Hot/Warm/Cool/Cold
          receptivity weighted from MIT/InsideSales, CallHippo, PhoneBurner, Cognism. */}
      {mode === "seller" && <CallHeatMeter />}

      {/* ── Personal stats — v14.24: Appts hero (big), then Points, Dials, Emails ── */}
      {myStats && (
        <>
        {/* v15.8 — KIT above Emails: KIT is a real conversation win, cold Emails
            are fire-and-forget. Order: Appts (hero), Points, Total Calls, KIT, Emails.
            Grid columns bumped to 5 to fit both KIT and Emails without dropping either. */}
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1fr", gap: 8, marginBottom: apptsGap > 0 || pointsGap > 0 ? 10 : 28 }}>
          {[
            { label: "Appts Set",   value: myStats.appointmentsSet,                             hero: true },
            { label: "Points",      value: myStats.points ?? 0,                                   hero: false },
            { label: "Total Calls", value: myStats.totalAttempts,                                 hero: false },
            { label: "KIT",         value: (myStats.outcomes?.keep_in_touch) ?? 0,                hero: false },
            { label: "Emails",      value: myStats.emailsSent ?? 0,                               hero: false },
          ].map(s => (
            <div key={s.label} style={{
              padding: s.hero ? "18px 8px" : "14px 8px", textAlign: "center",
              background: s.hero
                ? "linear-gradient(135deg, rgba(200,170,90,0.22) 0%, rgba(200,170,90,0.08) 100%)"
                : "linear-gradient(135deg, rgba(200,170,90,0.1) 0%, rgba(200,170,90,0.04) 100%)",
              border: `1px solid ${s.hero ? "rgba(200,170,90,0.55)" : "rgba(200,170,90,0.28)"}`,
              borderRadius: 12,
              boxShadow: s.hero ? "0 4px 18px rgba(200,170,90,0.18)" : "0 2px 12px rgba(200,170,90,0.08)",
            }}>
              <p style={{
                fontSize: s.hero ? 36 : 24, fontWeight: 700, color: "#c8aa5a",
                fontFamily: "'Cormorant Garamond','Georgia',serif", lineHeight: 1,
              }}><AnimatedNumber value={s.value} /></p>
              <p style={{
                fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase",
                color: s.hero ? "rgba(200,170,90,0.75)" : "rgba(255,255,255,0.45)",
                marginTop: 8, fontWeight: s.hero ? 700 : 500,
              }}>{s.label}</p>
            </div>
          ))}
        </div>
        {/* v14.24 — Gap-to-next-rank prompt: goal-focused, appts-first */}
        {rankAbove && (apptsGap > 0 || pointsGap > 0) && (
          <div style={{
            marginBottom: 22,
            padding: "10px 14px",
            background: "rgba(200,170,90,0.06)",
            border: "1px dashed rgba(200,170,90,0.3)",
            borderRadius: 10,
            fontSize: 12, color: "rgba(200,170,90,0.8)", textAlign: "center",
            fontFamily: "'Switzer','Inter',sans-serif",
          }}>
            {pointsGap > 0
              ? <><strong style={{ color: "#c8aa5a", fontSize: 13 }}>{pointsGap}</strong> more point{pointsGap === 1 ? "" : "s"} to catch <strong>{rankAbove.agent.name}</strong></>
              : <>Tied on points — <strong style={{ color: "#c8aa5a", fontSize: 13 }}>{apptsGap}</strong> more appt{apptsGap === 1 ? "" : "s"} to pass <strong>{rankAbove.agent.name}</strong></>}
          </div>
        )}
        </>
      )}

      {/* ── Leaderboard ── */}
      <div style={{ marginBottom: 32 }}>
        <p style={{
          fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase",
          color: "rgba(200,170,90,0.6)", marginBottom: 14, fontWeight: 600,
        }}>
          Team Leaderboard
        </p>
        {isLoading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[1,2,3].map(i => <div key={i} style={{ height: 58, borderRadius: 10, background: "rgba(255,255,255,0.04)" }} />)}
          </div>
        ) : ranked.length === 0 ? (
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", textAlign: "center", padding: "24px 0" }}>No data yet</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ranked.map((s, i) => {
              const isMe = s.agent.id === user?.id;
              // v15.11.25 — Trophy graphic for top 3, only when they actually earned points.
              const hasPoints = (s.points || 0) > 0;
              const trophyRank: 1 | 2 | 3 | null = (hasPoints && i === 0) ? 1
                          : (hasPoints && i === 1) ? 2
                          : (hasPoints && i === 2) ? 3
                          : null;
              const medalColor = trophyRank === 1 ? "#c8aa5a"
                             : trophyRank === 2 ? "#c0c7cf"
                             : trophyRank === 3 ? "#c48454"
                             : null;
              return (
                <div key={s.agent.id} style={{
                  display: "flex", alignItems: "center", gap: 14,
                  padding: "14px 16px",
                  background: isMe
                    ? "linear-gradient(135deg, rgba(200,170,90,0.1) 0%, rgba(200,170,90,0.04) 100%)"
                    : "rgba(255,255,255,0.03)",
                  border: `1px solid ${isMe ? "rgba(200,170,90,0.35)" : "rgba(255,255,255,0.08)"}`,
                  borderRadius: 10,
                  boxShadow: isMe ? "0 2px 12px rgba(200,170,90,0.08)" : "none",
                }}>
                  <span style={{ minWidth: 28, textAlign: "center", display: "flex", justifyContent: "center" }}>
                    {trophyRank !== null ? (
                      <RankTrophy rank={trophyRank} size={24} />
                    ) : (
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>#{i+1}</span>
                    )}
                  </span>
                  {/* v13.9 — headshot or initials */}
                  {/* v14.80 — Tier 1: #1 rank gets a breathing gold ring (first-place-glow) */}
                  {(() => {
                    const initials = s.agent.name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
                    const commonStyle = {
                      width: 32, height: 32, borderRadius: "50%",
                      border: `1.5px solid ${medalColor ?? "rgba(255,255,255,0.12)"}`,
                      flexShrink: 0,
                    } as const;
                    const firstPlaceClass = i === 0 ? "first-place-glow" : undefined;
                    if (s.agent.headshotUrl) {
                      return (
                        <img
                          className={firstPlaceClass}
                          src={s.agent.headshotUrl}
                          alt={s.agent.name}
                          style={{ ...commonStyle, objectFit: "cover" }}
                          onError={(e) => {
                            const el = e.currentTarget;
                            el.style.display = "none";
                            const fallback = document.createElement("div");
                            Object.assign(fallback.style, {
                              ...commonStyle,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              background: "rgba(200,170,90,0.08)",
                              color: "#c8aa5a", fontSize: "11px", fontWeight: "700",
                              fontFamily: "'Cormorant Garamond','Georgia',serif",
                            });
                            fallback.textContent = initials;
                            el.parentNode?.insertBefore(fallback, el);
                          }}
                        />
                      );
                    }
                    return (
                      <div className={firstPlaceClass} style={{
                        ...commonStyle,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: "rgba(200,170,90,0.08)",
                        color: "#c8aa5a", fontSize: 11, fontWeight: 700,
                        fontFamily: "'Cormorant Garamond','Georgia',serif",
                      }}>{initials}</div>
                    );
                  })()}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                      fontSize: 14, fontWeight: isMe ? 700 : 500,
                      color: isMe ? "#c8aa5a" : "#fff",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {s.agent.name}{isMe ? " (you)" : ""}
                    </p>
                  </div>
                  {/* v14.55 — Alex: "points should be the main indicator of first place... points
                       represent what has been achieved. From left to right: points, appts, dials, email."
                       PTS is now the hero (largest, gold pill), then APPTS, DIALS, EMAILS. Same order
                       matches the admin leaderboard for consistency. */}
                  <div style={{ display: "flex", gap: 12, flexShrink: 0, alignItems: "center" }}>
                    <div style={{ textAlign: "right", minWidth: 44 }}>
                      <p style={{ fontSize: 22, fontWeight: 700, color: "#c8aa5a", lineHeight: 1, fontFamily: "'Cormorant Garamond','Georgia',serif", background: "rgba(200,170,90,0.12)", borderRadius: 8, padding: "2px 8px", display: "inline-block" }}>{s.points ?? 0}</p>
                      <p style={{ fontSize: 9, color: "rgba(200,170,90,0.7)", letterSpacing: "0.14em", marginTop: 4, fontWeight: 700 }}>PTS</p>
                    </div>
                    <div style={{ textAlign: "right", minWidth: 34 }}>
                      <p style={{ fontSize: 17, fontWeight: 700, color: "#c8aa5a", lineHeight: 1, fontFamily: "'Cormorant Garamond','Georgia',serif" }}>{s.appointmentsSet}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 4 }}>APPTS</p>
                    </div>
                    <div style={{ textAlign: "right", minWidth: 30 }}>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "rgba(255,255,255,0.7)", lineHeight: 1 }}>{s.totalAttempts}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 4 }}>DIALS</p>
                    </div>
                    {/* v15.8 — KIT above Emails: KIT is a real conversation win vs. cold email fire-and-forget */}
                    <div style={{ textAlign: "right", minWidth: 30 }}>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "rgba(249,168,212,0.85)", lineHeight: 1 }}>{(s.outcomes?.keep_in_touch) ?? 0}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 4 }}>KIT</p>
                    </div>
                    <div style={{ textAlign: "right", minWidth: 30 }}>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "rgba(147,197,253,0.85)", lineHeight: 1 }}>{s.emailsSent ?? 0}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 4 }}>EMAILS</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Network-lead card removed from Dashboard tab in v14.50 — lives under Referrals now */}
      {false && mode === "seller" && (
      <div style={{
        padding: "22px 20px",
        background: "linear-gradient(135deg, rgba(200,170,90,0.08) 0%, rgba(200,170,90,0.03) 100%)",
        border: "1px solid rgba(200,170,90,0.28)", borderRadius: 14,
        boxShadow: "0 4px 24px rgba(200,170,90,0.06)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%",
            background: "rgba(200,170,90,0.15)", border: "1px solid rgba(200,170,90,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Users size={14} style={{ color: "#c8aa5a" }} />
          </div>
          <div>
            <p style={{ fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "#c8aa5a", fontWeight: 700 }}>
              Submit a Client Lead
            </p>
            <p style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(200,170,90,0.45)", fontWeight: 500, marginTop: 2 }}>
              Real Estate Seller / Buyer — Not Agent Recruitment
            </p>
          </div>
        </div>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 18, lineHeight: 1.55 }}>
          Know someone thinking about selling? Drop their info here and we'll assist all the way to closing!
        </p>
        <form onSubmit={handleNetworkLead} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelStyle}>Name *</label>
              <input value={netName} onChange={e => setNetName(e.target.value)} placeholder="John Smith" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Phone *</label>
              <input value={netPhone} onChange={e => setNetPhone(e.target.value)} placeholder="(904) 555-0100" type="tel" style={inputStyle} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Email</label>
            <input value={netEmail} onChange={e => setNetEmail(e.target.value)} placeholder="john@email.com" type="email" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Property Address</label>
            <input value={netAddr} onChange={e => setNetAddr(e.target.value)} placeholder="123 Oak St, Fernandina Beach, FL" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Notes</label>
            <textarea value={netNotes} onChange={e => setNetNotes(e.target.value)} placeholder="Any context about their situation…" rows={2}
              style={{ ...inputStyle, resize: "none", lineHeight: 1.5 }} />
          </div>
          <button type="submit" disabled={netSending} style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "14px 20px", marginTop: 4,
            background: netSending ? "rgba(200,170,90,0.3)" : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
            border: "none", borderRadius: 8, cursor: netSending ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
            color: "#080808", boxShadow: netSending ? "none" : "0 4px 16px rgba(200,170,90,0.3)",
          }}>
            <Send size={14} /> {netSending ? "Submitting…" : "Submit Lead"}
          </button>
        </form>
      </div>
      )}
    </div>
  );
}


// ─── My Leads Tab (removed v14.38) ─────────────────────────────────────────
// KIT is a FUB commitment — long-term nurture lives in Follow Up Boss
// workflows, not Lead Depot. Callback outcome was retired in v14.14.
// Nav shrank from 5 tabs to 4 (Dashboard / Dial / Refer / Profile).
// v14.68 — RESTORED (no 60-day filter). See MyLeadsTab component just below.

interface PipelineLead {
  id: number;
  owner_name?: string | null;
  ownerName?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  email?: string | null;
  status?: string | null;
  lead_type?: string | null;
  follow_up_timing?: string | null;
  last_outcome?: string | null;
  last_activity_at?: string | null;
  // v14.80 — Agent Pipeline redesign: from lpmamab_snapshot on /api/leads/my-pipeline
  appt_date?: string | null;
  appt_time?: string | null;
  intention?: string | null;
  stage?: string | null;
}

function PipelineCard({ lead, kind, onOpen }: { lead: PipelineLead; kind: "appt" | "kit" | "network"; onOpen?: (leadId: number) => void }) {
  const accent = kind === "appt" ? "#10b981" : kind === "kit" ? "#c8aa5a" : "#8b7cff";
  const kindLabel = kind === "appt" ? "APPT SET" : kind === "kit" ? "KEEP IN TOUCH" : "MY NETWORK LEAD";
  const name = lead.owner_name || lead.ownerName || "Unknown";
  const location = [lead.address, lead.city, lead.state].filter(Boolean).join(", ") || "No address on file";
  const when = lead.last_activity_at
    ? new Date(lead.last_activity_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
  // v14.80 — Agent Pipeline redesign: surface appt date/time (appts) and
  // intention + follow-up trigger (KIT) pulled from the activity snapshot.
  const apptWhen = [lead.appt_date, lead.appt_time].filter(Boolean).join(" at ");
  return (
    <div
      onClick={() => lead.id && onOpen?.(lead.id)}
      style={{
        padding: "14px 16px",
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(200,170,90,0.14)",
        borderLeft: `3px solid ${accent}`,
        borderRadius: 10,
        display: "flex", flexDirection: "column", gap: 4,
        cursor: onOpen ? "pointer" : "default",
      }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", letterSpacing: "0.01em" }}>{name}</div>
        <div style={{
          fontSize: 9, fontWeight: 700, letterSpacing: "0.12em",
          color: accent, padding: "3px 8px",
          background: `${accent}18`, borderRadius: 999,
        }}>{kindLabel}</div>
      </div>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.5 }}>{location}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 4 }}>
        {lead.phone && (
          <div style={{ fontSize: 11, color: "rgba(200,170,90,0.85)", letterSpacing: "0.03em" }}>{lead.phone}</div>
        )}
        {when && (
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.02em" }}>Last touch · {when}</div>
        )}
      </div>
      {kind === "appt" && apptWhen && (
        <div style={{ fontSize: 10, color: "rgba(16,185,129,0.9)", marginTop: 4 }}>
          Appointment: <b style={{ color: "#10b981" }}>{apptWhen}</b>
        </div>
      )}
      {kind === "kit" && (lead.intention || lead.follow_up_timing) && (
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>
          {lead.intention && <>Intention: <b style={{ color: "rgba(255,255,255,0.75)" }}>{lead.intention}</b>{lead.follow_up_timing && " · "}</>}
          {lead.follow_up_timing && <>Follow up: <b style={{ color: "rgba(255,255,255,0.75)" }}>{lead.follow_up_timing}</b></>}
        </div>
      )}
    </div>
  );
}

function MyLeadsTab({ onOpenLead }: { onOpenLead?: (leadId: number) => void }) {
  const { user } = useAuth();
  const agentId = (user as any)?.id;
  const { data, isLoading, isError } = useQuery<any>({
    queryKey: ["/api/leads/my-pipeline", agentId],
    queryFn: () => apiRequest("GET", `/api/leads/my-pipeline?agentId=${agentId}`).then(r => r.json()),
    enabled: !!agentId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  // v14.80 — Agent Pipeline redesign: tiles now filter the list below instead of
  // just displaying counts. "all" (default) shows every owned pipeline lead.
  const [pipelineFilter, setPipelineFilter] = useState<"all" | "appts" | "kit" | "network">("all");
  const counts = data?.counts || { appts: 0, kit: 0, network: 0, total: 0 };
  const appts: PipelineLead[] = data?.appts || [];
  const kit: PipelineLead[]   = data?.kit || [];
  const network: PipelineLead[] = data?.network || [];

  const TILES = [
    { key: "all" as const,     label: "ALL",     count: counts.total,   color: "#e8e8e8", bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.18)" },
    { key: "appts" as const,   label: "APPTS",   count: counts.appts,   color: "#10b981", bg: "rgba(16,185,129,0.08)",  border: "rgba(16,185,129,0.25)" },
    { key: "kit" as const,     label: "KIT",      count: counts.kit,     color: "#c8aa5a", bg: "rgba(200,170,90,0.08)", border: "rgba(200,170,90,0.25)" },
    { key: "network" as const, label: "NETWORK", count: counts.network, color: "#8b7cff", bg: "rgba(139,124,255,0.08)", border: "rgba(139,124,255,0.25)" },
  ];

  const showAppts = pipelineFilter === "all" || pipelineFilter === "appts";
  const showKit = pipelineFilter === "all" || pipelineFilter === "kit";
  const showNetwork = pipelineFilter === "all" || pipelineFilter === "network";
  const visibleTotal = (showAppts ? appts.length : 0) + (showKit ? kit.length : 0) + (showNetwork ? network.length : 0);
  const filterLabel = pipelineFilter === "appts" ? "appointment" : pipelineFilter === "kit" ? "keep-in-touch" : pipelineFilter === "network" ? "network" : "pipeline";

  return (
    <div style={{ padding: "22px 18px 120px", maxWidth: 640, margin: "0 auto", color: "#fff" }}>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "1.9rem", fontWeight: 400, letterSpacing: "0.01em", marginBottom: 4,
        }}>My Pipeline</h1>
        {/* v14.80 — confidence copy: this is 100% owned/qualified leads, never the raw pool */}
        <p style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif", fontStyle: "italic",
          fontSize: 13, color: "rgba(200,170,90,0.75)", letterSpacing: "0.01em",
        }}>
          MY PIPELINE — every deal I've moved forward. Nothing expires.
        </p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 22 }}>
        {TILES.map(t => {
          const active = pipelineFilter === t.key;
          return (
            <button
              key={t.key}
              data-testid={`tile-pipeline-${t.key}`}
              onClick={() => setPipelineFilter(cur => cur === t.key ? "all" : t.key)}
              style={{
                padding: "14px 8px", background: t.bg,
                border: `1.5px solid ${active ? t.color : t.border}`,
                borderRadius: 10, textAlign: "center", cursor: "pointer",
                boxShadow: active ? `0 0 0 3px ${t.color}22` : "none",
                transition: "all 0.15s ease",
              }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: t.color, lineHeight: 1 }}><AnimatedNumber value={t.count} /></div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: t.color, marginTop: 6, opacity: 0.9 }}>{t.label}</div>
            </button>
          );
        })}
      </div>
      {isLoading && (<div style={{ padding: 40, textAlign: "center", color: "rgba(255,255,255,0.5)", fontSize: 13 }}>Loading your pipeline…</div>)}
      {isError && (<div style={{ padding: 40, textAlign: "center", color: "rgb(252,165,165)", fontSize: 13 }}>Failed to load pipeline. Pull down to refresh.</div>)}
      {!isLoading && !isError && counts.total === 0 && (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.6, border: "1px dashed rgba(255,170,90,0.2)", borderRadius: 12 }}>
          Your pipeline is just getting started. Every appointment and keep-in-touch you set will live here forever.
        </div>
      )}
      {!isLoading && !isError && counts.total > 0 && visibleTotal === 0 && (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.6, border: "1px dashed rgba(255,170,90,0.2)", borderRadius: 12 }}>
          No {filterLabel} leads yet — go make some.
        </div>
      )}
      {showAppts && appts.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Calendar size={14} color="#10b981" />
            <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", color: "#10b981", textTransform: "uppercase" }}>Appointments · {appts.length}</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {appts.map(l => <PipelineCard key={l.id} lead={l} kind="appt" onOpen={onOpenLead} />)}
          </div>
        </section>
      )}
      {showKit && kit.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Heart size={14} color="#c8aa5a" />
            <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", color: "#c8aa5a", textTransform: "uppercase" }}>Keep In Touch · {kit.length}</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {kit.map(l => <PipelineCard key={l.id} lead={l} kind="kit" onOpen={onOpenLead} />)}
          </div>
        </section>
      )}
      {showNetwork && network.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <UserPlus size={14} color="#8b7cff" />
            <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", color: "#8b7cff", textTransform: "uppercase" }}>My Network Leads · {network.length}</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {network.map(l => <PipelineCard key={l.id} lead={l} kind="network" onOpen={onOpenLead} />)}
          </div>
        </section>
      )}
    </div>
  );
}


// ─── Referrals Hub (v14.50) ─────────────────────────────────────────────────
// Consolidates Client Referral (network lead → auto-assigned to referring agent,
// jumps to Work-the-Lead card immediately) and Agent Referral (recruiting).
function ReferralsHub() {
  const [sub, setSub] = useState<"client" | "agent">("client");
  return (
    <div style={{ width: "100%", padding: "0 0 20px" }}>
      <div style={{
        display: "flex", gap: 6, padding: 4, marginBottom: 16,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(200,170,90,0.15)",
        borderRadius: 12,
      }}>
        {([
          { id: "client", label: "Client Referral" },
          { id: "agent",  label: "Agent Referral" },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            style={{
              flex: 1, padding: "11px 8px", borderRadius: 8, border: "none",
              cursor: "pointer",
              background: sub === t.id ? "linear-gradient(135deg,#c8aa5a,#a8893a)" : "transparent",
              color: sub === t.id ? "#0a0700" : "rgba(255,255,255,0.55)",
              fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
            }}>
            {t.label}
          </button>
        ))}
      </div>
      {sub === "client" ? <ClientReferralForm /> : <ReferralTab />}
    </div>
  );
}

// ─── Client Referral Form (v14.50) ────────────────────────────────────────
function ClientReferralForm() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [netName, setNetName]   = useState("");
  const [netPhone, setNetPhone] = useState("");
  const [netEmail, setNetEmail] = useState("");
  const [netAddr, setNetAddr]   = useState("");
  const [netNotes, setNetNotes] = useState("");
  const [netSending, setNetSending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!netName.trim() || !netPhone.trim()) {
      toast({ title: "Name and phone required", variant: "destructive" }); return;
    }
    setNetSending(true);
    try {
      const r = await apiRequest("POST", "/api/leads/network", {
        ownerName: netName.trim(), phone: netPhone.trim(),
        email: netEmail.trim(), address: netAddr.trim(),
        notes: netNotes.trim(),
        submittedBy: user?.id, submittedByName: user?.name,
      });
      const data = await r.json();
      if (r.ok && data.leadId) {
        toast({ title: "Client referral submitted", description: "Opening Work-the-Lead card…" });
        setNetName(""); setNetPhone(""); setNetEmail(""); setNetAddr(""); setNetNotes("");
        try { sessionStorage.setItem("pending_lead_jump", String(data.leadId)); } catch {}
        window.dispatchEvent(new Event("pending_lead_jump_changed"));
        qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
      } else {
        toast({ title: "Failed to submit", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to submit", variant: "destructive" });
    } finally {
      setNetSending(false);
    }
  };

  return (
    <div style={{
      padding: "22px 20px",
      background: "linear-gradient(135deg, rgba(200,170,90,0.08) 0%, rgba(200,170,90,0.03) 100%)",
      border: "1px solid rgba(200,170,90,0.28)", borderRadius: 14,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{
          width: 32, height: 32, borderRadius: "50%",
          background: "rgba(200,170,90,0.15)", border: "1px solid rgba(200,170,90,0.3)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Users size={14} style={{ color: "#c8aa5a" }} />
        </div>
        <div>
          <p style={{ fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "#c8aa5a", fontWeight: 700, margin: 0 }}>
            Submit a Client Lead
          </p>
          <p style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(200,170,90,0.45)", fontWeight: 500, marginTop: 2 }}>
            You'll be dropped straight into their Work the Lead card
          </p>
        </div>
      </div>
      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 18, lineHeight: 1.55 }}>
        Know someone thinking about selling or buying? Drop their info here — the lead is auto-assigned to you and opens instantly.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <label style={labelStyle}>Name *</label>
            <input value={netName} onChange={e => setNetName(e.target.value)} placeholder="John Smith" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Phone *</label>
            <input value={netPhone} onChange={e => setNetPhone(e.target.value)} placeholder="(904) 555-0100" type="tel" style={inputStyle} />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Email</label>
          <input value={netEmail} onChange={e => setNetEmail(e.target.value)} placeholder="john@email.com" type="email" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Property Address</label>
          <input value={netAddr} onChange={e => setNetAddr(e.target.value)} placeholder="123 Oak St, Fernandina Beach, FL" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Notes</label>
          <textarea value={netNotes} onChange={e => setNetNotes(e.target.value)} placeholder="Any context about their situation…" rows={2}
            style={{ ...inputStyle, resize: "none", lineHeight: 1.5 }} />
        </div>
        <button type="submit" disabled={netSending} style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          padding: "14px 20px", marginTop: 4,
          background: netSending ? "rgba(200,170,90,0.3)" : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
          border: "none", borderRadius: 8, cursor: netSending ? "not-allowed" : "pointer",
          fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
          color: "#080808",
        }}>
          <Send size={14} /> {netSending ? "Submitting…" : "Submit & Open Lead"}
        </button>
      </form>
    </div>
  );
}

// ─── Referral Tab (agent recruiting) ─────────────────────────────────────
function ReferralTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [name, setName]           = useState("");
  const [phone, setPhone]         = useState("");
  const [email, setEmail]         = useState("");
  const [brokerage, setBrokerage] = useState("");
  const [notes, setNotes]         = useState("");
  const [sending, setSending]     = useState(false);
  const [sent, setSent]           = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) {
      toast({ title: "Name and phone required", variant: "destructive" }); return;
    }
    setSending(true);
    try {
      await apiRequest("POST", "/api/referrals", {
        name: name.trim(), phone: phone.trim(), email: email.trim(),
        brokerage: brokerage.trim(), notes: notes.trim(),
        referredBy: user?.id, referredByName: user?.name,
      });
      setSent(true);
      setName(""); setPhone(""); setEmail(""); setBrokerage(""); setNotes("");
      toast({ title: "Referral submitted!", description: "Admins have been notified." });
    } catch {
      toast({ title: "Failed to submit referral", variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ width: "100%", padding: "0 0 20px" }}>
      <div style={{
        padding: "24px 20px",
        background: "linear-gradient(135deg, rgba(200,170,90,0.06) 0%, rgba(200,170,90,0.02) 100%)",
        border: "1px solid rgba(200,170,90,0.25)",
        borderRadius: 14,
        boxShadow: "0 4px 24px rgba(200,170,90,0.05)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{
            width: 36, height: 36, borderRadius: "50%",
            background: "rgba(200,170,90,0.12)", border: "1px solid rgba(200,170,90,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <UserPlus size={16} style={{ color: "#c8aa5a" }} />
          </div>
          <h3 style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            fontSize: 22, fontWeight: 400, color: "#fff",
          }}>
            Refer an Agent
          </h3>
        </div>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 22, lineHeight: 1.6 }}>
          Know someone who would be a great fit for Brothers Group — or who wants to start receiving leads? Send us their info and we'll connect with them directly.
        </p>

        {sent && (
          <div style={{
            padding: "14px 16px", marginBottom: 20,
            background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)",
            borderRadius: 8,
          }}>
            <p style={{ fontSize: 13, color: "rgb(134,239,172)" }}>Referral sent — we'll be in touch with them soon. Thank you!</p>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelStyle}>Full Name *</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Phone *</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(904) 555-0100" type="tel" style={inputStyle} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@email.com" type="email" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Current Brokerage (if licensed)</label>
            <input value={brokerage} onChange={e => setBrokerage(e.target.value)} placeholder="e.g. Keller Williams, eXp, unlicensed" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything helpful to know about this person…" rows={3}
              style={{ ...inputStyle, resize: "none", lineHeight: 1.5 }} />
          </div>
          <button type="submit" disabled={sending} style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "14px 20px", marginTop: 4,
            background: sending ? "rgba(200,170,90,0.3)" : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
            border: "none", borderRadius: 8, cursor: sending ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase",
            color: "#080808", boxShadow: sending ? "none" : "0 4px 16px rgba(200,170,90,0.3)",
          }}>
            <Send size={14} /> {sending ? "Sending…" : "Send Referral"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 10, letterSpacing: "0.18em",
  textTransform: "uppercase", color: "rgba(200,170,90,0.55)", marginBottom: 6, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(200,170,90,0.2)",
  padding: "11px 14px", borderRadius: 8,
  fontFamily: "'Switzer','Inter',sans-serif", fontSize: 14,
  color: "#fff", outline: "none", boxSizing: "border-box",
};

// ─── Nav tabs ─────────────────────────────────────────────────────────────────
// v14.38 — "my-leads" tab removed. KIT lives in FUB.
type Tab = "leads" | "leaderboard" | "pipeline" | "refer" | "profile";
// v14.68 — Pipeline tab restored between Dial and Referrals. Nav order matters:
// the middle slot (Dial) gets the prominent, elevated styling in the bottom nav.
const NAV: { id: Tab; label: string; icon: typeof Phone }[] = [
  { id: "leaderboard", label: "Dashboard", icon: Trophy },
  { id: "pipeline",    label: "Pipeline", icon: Layers },
  { id: "leads",       label: "Dial",      icon: Phone },
  { id: "refer",       label: "Referrals", icon: UserPlus },
  { id: "profile",     label: "Profile",   icon: UserCircle2 },
];

// ─── Main AgentView ───────────────────────────────────────────────────────────
export default function AgentView({ onBackToAdmin, initialTab, mode = "seller" }: { onBackToAdmin?: () => void; initialTab?: Tab; mode?: "seller" | "recruiting" } = {}) {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab ?? "leaderboard");
  const { connected: wsConnected } = useRealtimeUpdates();
  const qc = useQueryClient();
  const { toast } = useToast(); // v15.11.17 — used by CLOSED_STATUSES redirect notice

  // v15.3 — REAL dialing-now indicator. Replaces v14.9 vibe count that showed
  // "6 dialing now" 24/7 based on active_agents_count + random bump.
  // Source of truth: /api/agents/live-count returns COUNT(DISTINCT agent_id) with
  // a lead_activity insert in the last 10 minutes. Zero means zero — no fudging.
  const { data: liveCountData } = useQuery<{ dialingNow: number; windowMinutes: number; lastActivityAt: string | null }>({
    queryKey: ["/api/agents/live-count"],
    queryFn: () => apiRequest("GET", "/api/agents/live-count").then(r => r.json()),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const dialingNowCount = liveCountData?.dialingNow ?? 0;
  const lastActivityAt = liveCountData?.lastActivityAt || null;
  // v14.50 — pull-to-refresh: swipe down from the very top to refetch every query.
  // v14.52 — destructure indicator so the pull gesture has visible feedback (gold chip at top)
  const { indicator: ptrIndicator } = usePullToRefresh(() => qc.invalidateQueries());

  // ── Prospecting mode ─────────────────────────────────────────────
  // v12.5 — mode drives which depot this AgentView renders. Recruiting is
  // admin-only (guarded in App.tsx). prospectingMode is kept as an internal
  // flag so all existing recruiting-branch code needs zero rewrite.
  const prospectingMode = mode === "recruiting";
  const isAdmin = user?.role === "admin";

  // v14.0 — territories removed. Home County (Nassau/Duval/St Johns) is the only
  // location construct. Agents pick it once at first login and can change it in Profile.

  const { data: nextAgentLead, isLoading: agentLeadLoading } = useQuery<any | null>({
    queryKey: ["/api/agent-leads/my-next"],
    queryFn: () => apiRequest("GET", "/api/agent-leads/my-next").then(async r => {
      if (r.status === 204) return null;
      return r.json();
    }),
    enabled: prospectingMode,
    refetchInterval: prospectingMode ? 30000 : false,
  });

  const { data: agentLeadCount } = useQuery<{ count: number }>({
    queryKey: ["/api/agent-leads/count"],
    queryFn: () => apiRequest("GET", "/api/agent-leads/count").then(r => r.json()),
    enabled: prospectingMode,
    refetchInterval: 15000,
  });

  const [recruitCallNotes, setRecruitCallNotes] = React.useState("");
  const [recruitCallbackDate, setRecruitCallbackDate] = React.useState("");
  const [recruitPendingOutcome, setRecruitPendingOutcome] = React.useState<string | null>(null);
  const [joinedTeamConfirm, setJoinedTeamConfirm] = React.useState(false);

  const agentLeadMutation = useMutation({
    mutationFn: (data: { outcome: string; notes?: string; callbackDate?: string }) =>
      apiRequest("POST", `/api/agent-leads/${nextAgentLead?.id}/outcome`, { ...data, callerId: user?.id }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agent-leads/my-next"] });
      qc.invalidateQueries({ queryKey: ["/api/agent-leads/count"] });
      setRecruitCallNotes("");
      setRecruitCallbackDate("");
      setRecruitPendingOutcome(null);
      setJoinedTeamConfirm(false);
    },
  });

  const submitRecruitOutcome = (outcome: string) => {
    if (outcome === "callback_requested" && !recruitCallbackDate) {
      setRecruitPendingOutcome("callback_requested");
      return;
    }
    agentLeadMutation.mutate({ outcome, notes: recruitCallNotes || undefined, callbackDate: recruitCallbackDate || undefined });
  };

  const { data: nextLead, isLoading: leadLoading } = useQuery<Lead | null>({
    queryKey: ["/api/leads/my-next"],
    queryFn: () =>
      apiRequest("GET", `/api/leads/my-next?agentId=${user?.id}`).then(async r => {
        if (r.status === 204) return null;
        return r.json();
      }),
    enabled: !!user?.id,
  });

  // v14.50 — "Who called me?" jump-to-lead. If sessionStorage has a pending lead
  // id (set from LoginPage lookup, global top-bar lookup, or client-referral
  // submission), fetch that lead by id and open its Work-the-Lead card on the
  // Dial tab, overriding the pool pull.
  const [pendingLeadId, setPendingLeadId] = useState<number | null>(() => {
    try {
      const raw = sessionStorage.getItem("pending_lead_jump");
      return raw ? parseInt(raw, 10) : null;
    } catch { return null; }
  });
  useEffect(() => {
    // React to same-tab writes to sessionStorage via a custom event.
    const handler = () => {
      try {
        const raw = sessionStorage.getItem("pending_lead_jump");
        setPendingLeadId(raw ? parseInt(raw, 10) : null);
      } catch { setPendingLeadId(null); }
    };
    window.addEventListener("pending_lead_jump_changed", handler);
    return () => window.removeEventListener("pending_lead_jump_changed", handler);
  }, []);
  const { data: overrideLead } = useQuery<Lead | null>({
    queryKey: ["/api/leads/by-id", pendingLeadId],
    queryFn: () =>
      apiRequest("GET", `/api/leads/${pendingLeadId}`).then(async r => {
        if (!r.ok) return null;
        return r.json();
      }),
    enabled: !!pendingLeadId && !!user?.id,
  });
  useEffect(() => {
    if (pendingLeadId && overrideLead?.id) {
      setTab("leads");
    }
  }, [pendingLeadId, overrideLead?.id]);
  const clearPendingLead = () => {
    try { sessionStorage.removeItem("pending_lead_jump"); } catch {}
    setPendingLeadId(null);
  };

  // v15.11.17 — CLOSED_STATUSES: a lead in any of these is NOT dial-eligible.
  // If the pending-lead-jump flow lands on one of these (e.g. an agent tapped
  // a stale referral link or search result pointing at a lead they already
  // KIT'd two days ago), we must NOT show it as a dial card. Doing so is how
  // won/parked leads leak back into the shared-pool feeling and get double-
  // called. Clear the pending, then fall back to the real pool pull.
  const CLOSED_STATUSES = new Set([
    "keep_in_touch",
    "contacted_appointment",
    "contacted_not_interested",
    "listed",
    "retired",
    "wrong_number",
    "recycled",
  ]);
  useEffect(() => {
    if (overrideLead?.id && overrideLead.status && CLOSED_STATUSES.has(overrideLead.status)) {
      // Silently drop the pending jump. The user is redirected back to normal
      // dial flow (nextLead from the pool). A one-shot toast tells them where
      // the lead actually lives now so they don't think we ate it.
      const label = overrideLead.status === "keep_in_touch" ? "Keep in Touch"
                  : overrideLead.status === "contacted_appointment" ? "Appointment Set"
                  : overrideLead.status === "listed" ? "Listed"
                  : overrideLead.status === "recycled" ? "Recycled"
                  : "Closed";
      toast({
        title: `Already “${label}”`,
        description: `${overrideLead.ownerName || "This lead"} isn't dial-eligible — it's in your Pipeline tab.`,
      });
      clearPendingLead();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideLead?.id, overrideLead?.status]);

  const displayedLead: Lead | null | undefined =
    (overrideLead && !CLOSED_STATUSES.has(overrideLead.status || ""))
      ? overrideLead
      : nextLead;

  const { data: myQueueData } = useQuery<{ count: number }>({
    queryKey: [`/api/leads/my-count/${user?.id}`],
    queryFn: () => apiRequest("GET", `/api/leads/my-count/${user?.id}`).then(r => r.json()),
    enabled: !!user?.id,
    refetchInterval: 15000,
  });

  const queueCount = myQueueData?.count ?? 0;
  const hasLeads   = queueCount > 0;

  // v14.80 — Tier 4: idle nudge. Tracks lastInteraction via click/scroll/keypress.
  // If 90s idle AND leads are queued AND we're NOT already on the Dial tab,
  // give the FAB a bigger-amplitude nudge for 2.5s to draw the eye back in.
  const lastInteractionRef = useRef(Date.now());
  const [fabNudge, setFabNudge] = useState(false);
  useEffect(() => {
    const bump = () => { lastInteractionRef.current = Date.now(); };
    window.addEventListener("click", bump);
    window.addEventListener("scroll", bump, true);
    window.addEventListener("keypress", bump);
    const interval = setInterval(() => {
      const idleMs = Date.now() - lastInteractionRef.current;
      if (idleMs >= 90_000 && hasLeads && tab !== "leads") {
        setFabNudge(true);
        setTimeout(() => setFabNudge(false), 2500);
        lastInteractionRef.current = Date.now(); // avoid re-nudging every 5s while idle
      }
    }, 5000);
    return () => {
      window.removeEventListener("click", bump);
      window.removeEventListener("scroll", bump, true);
      window.removeEventListener("keypress", bump);
      clearInterval(interval);
    };
  }, [hasLeads, tab]);

  // Scroll main back to top whenever a new lead loads
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (displayedLead?.id) {
      mainRef.current?.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [displayedLead?.id]);

  // v14.50 — Global "Who called me?" modal state (top-bar button, works on every tab)
  const [globalLookupOpen, setGlobalLookupOpen] = useState(false);

  return (
    <div className="ld-bg-wrap" style={{ minHeight: "100dvh", background: "#080808", display: "flex", flexDirection: "column" }}>
      {/* v14.52 — Pull-to-refresh visible indicator (gold chip floats above header) */}
      {ptrIndicator}
      {/* Luxury ambient glows */}
      <div className="ld-glow" />
      <div className="ld-glow-corner" />

      {/* ── Header ── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 20,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 18px",
        background: "linear-gradient(180deg, rgba(14,12,8,0.99) 0%, rgba(8,8,8,0.97) 100%)",
        backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(200,170,90,0.2)",
        boxShadow: "0 2px 20px rgba(0,0,0,0.5)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {onBackToAdmin && (
            <button onClick={onBackToAdmin} style={{
              display: "flex", alignItems: "center", gap: 4,
              fontSize: 11, color: "rgba(200,170,90,0.6)",
              background: "none", border: "none", cursor: "pointer",
              letterSpacing: "0.06em", marginRight: 2,
            }}>
              <ChevronLeft size={13} /> Admin
            </button>
          )}
          {/* v14.54 — removed the dead LogoIcon (home glyph). Alex called out header clutter
              in IMG_9238: he only wants ‹ Admin, Who called?, and Sign out. Title + username stay. */}
          <div>
            <p style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: 15, fontWeight: 500, letterSpacing: "0.2em",
              color: "#fff", textTransform: "uppercase", lineHeight: 1,
            }}>{mode === "recruiting" ? "Recruiting Depot" : "Lead Depot"}</p>
            <p style={{ fontSize: 11, color: "rgba(200,170,90,0.7)", letterSpacing: "0.08em", marginTop: 2 }}>{user?.name}</p>
          </div>
          {/* v14.52 — Recruiting cross-link removed from header (overextended the right edge on iPhone).
              Admins reach the recruiting side via the in-app Recruiting Depot tab. The ← Seller reverse
              link on the recruiting side is preserved because there's no equivalent tab there. */}
          {isAdmin && mode === "recruiting" && (
            <a
              href="#/"
              style={{
                marginLeft: 6, fontSize: 10, color: "rgba(79,184,163,0.85)",
                textDecoration: "none", letterSpacing: "0.1em", textTransform: "uppercase",
                background: "rgba(79,184,163,0.08)",
                border: "1px solid rgba(79,184,163,0.25)",
                borderRadius: 6, padding: "4px 8px", fontWeight: 700,
              }}
            >
              ← Seller
            </a>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* v15.3 — REAL dialing-now pill. Green + pulse when ≥ 1 agent has
              logged a call outcome in the last 10 min; gray + static when quiet.
              Tap-hold title shows "last activity Xm ago" so Alex can sanity-check. */}
          {mode === "seller" && (() => {
            // v15.8 — hide the pill entirely when the team is quiet. The green
            // ws-heartbeat dot to the right already signals "connection live";
            // showing a second "Quiet — be the first" pill next to it created a
            // visual contradiction (green heartbeat + "quiet" copy on the same
            // row). Only render when the team is actively dialing, so it reads
            // as pure positive social proof.
            const isLive = dialingNowCount > 0;
            if (!isLive) return null;
            const title = `${dialingNowCount} agent${dialingNowCount === 1 ? "" : "s"} logged a call in the last 10 min`;
            return (
              <div title={title} style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "5px 9px", borderRadius: 20,
                background: "rgba(34,197,94,0.08)",
                border: "1px solid rgba(34,197,94,0.25)",
                fontSize: 10,
                color: "rgba(134,239,172,0.9)",
                fontWeight: 600, letterSpacing: "0.03em", whiteSpace: "nowrap",
              }} data-testid="pill-dialing-now">
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "#4ade80",
                  boxShadow: "0 0 6px rgba(74,222,128,0.8)",
                  animation: "livePulse 1.8s ease-in-out infinite",
                }} />
                {`${dialingNowCount} dialing now`}
              </div>
            );
          })()}
          <span
            title={wsConnected ? "Live" : "Reconnecting\u2026"}
            data-testid="ws-heartbeat-dot"
            style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
              background: wsConnected ? "#4ade80" : "#ef4444",
              boxShadow: wsConnected ? "0 0 6px rgba(74,222,128,0.7)" : "0 0 6px rgba(239,68,68,0.7)",
              animation: wsConnected ? "wsHeartbeat 1.2s ease-in-out infinite" : "none",
            }}
          />
          {/* v14.50 — Global "Who called me?" button, visible on every tab */}
          {mode === "seller" && (
            <button
              onClick={() => setGlobalLookupOpen(true)}
              title="Who called me?"
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 10px", borderRadius: 8,
                background: "linear-gradient(135deg, rgba(200,170,90,0.16), rgba(200,170,90,0.06))",
                border: "1px solid rgba(200,170,90,0.35)",
                color: "#c8aa5a", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
                textTransform: "uppercase", cursor: "pointer",
              }}
            >
              <Phone size={12} /> Who called?
            </button>
          )}
          {/* v14.54 — removed the tutorial "?" help pill. It sat between Who called? and Sign out
              and was pushing the header past the right edge. Tutorial is still reachable from
              the profile screen if needed. */}
          <button onClick={logout} style={{
            display: "flex", alignItems: "center", gap: 5,
            fontSize: 11, color: "rgba(255,255,255,0.4)",
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 6, padding: "6px 10px",
            cursor: "pointer",
          }}>
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </header>

      {/* Prospecting Mode Banner */}
      {prospectingMode && (
        <div style={{
          background: "linear-gradient(135deg, rgba(79,184,163,0.08) 0%, rgba(8,8,8,1) 80%)",
          borderBottom: "1px solid rgba(79,184,163,0.2)",
          padding: "8px 18px",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: "#4fb8a3",
            boxShadow: "0 0 8px rgba(79,184,163,0.8)",
            animation: "pulse 2s ease infinite",
          }} />
          <span style={{ fontSize: 11, color: "#4fb8a3", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            Agent Recruiting Mode
          </span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginLeft: 4 }}>
            {agentLeadCount?.count ?? 0} leads in queue
          </span>
        </div>
      )}

      {/* ── Leads notification banner ── */}
      {!prospectingMode && hasLeads && tab !== "leads" && (
        <button onClick={() => setTab("leads")} style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
          padding: "13px 20px",
          background: "linear-gradient(135deg, rgba(200,170,90,0.2) 0%, rgba(200,170,90,0.1) 100%)",
          border: "none", borderBottom: "1px solid rgba(200,170,90,0.3)",
          cursor: "pointer",
        }}>
          <div style={{
            width: 9, height: 9, borderRadius: "50%", background: "#c8aa5a",
            boxShadow: "0 0 10px rgba(200,170,90,0.9)",
            animation: "pulse 2s infinite",
          }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: "#c8aa5a", letterSpacing: "0.1em" }}>
            Leads Ready — Tap to Work Your Queue
          </span>
          <ChevronLeft size={13} style={{ color: "rgba(200,170,90,0.7)", transform: "rotate(180deg)" }} />
        </button>
      )}

      {/* ── Main ── */}
      <main ref={mainRef} style={{ flex: 1, overflowY: "auto", padding: "16px 12px 90px" }}>
        {tab === "leaderboard" && <LeaderboardTab mode={mode} />}

        {tab === "leads" && (
          <div>
            {prospectingMode ? (
              // ── AGENT RECRUITING CALL CARD ──────────────────────────────────────────
              <div style={{ padding: "0 0 24px" }}>
                {agentLeadLoading ? (
                  <Skeleton className="h-[480px] w-full rounded-2xl" style={{ background: "rgba(79,184,163,0.05)" }} />
                ) : nextAgentLead ? (
                  <div style={{
                    background: "linear-gradient(135deg, rgba(79,184,163,0.04) 0%, #080808 60%)",
                    border: "1px solid rgba(79,184,163,0.25)",
                    borderRadius: 16, margin: "0 4px", padding: 20,
                  }}>
                    {/* Name & status */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                      <div>
                        <p style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 22, fontWeight: 500, color: "#fff", lineHeight: 1.1 }}>
                          {nextAgentLead.first_name} {nextAgentLead.last_name}
                        </p>
                        <p style={{ fontSize: 12, color: "rgba(79,184,163,0.8)", marginTop: 4, letterSpacing: "0.06em" }}>
                          {nextAgentLead.license_status || "License unknown"} · {nextAgentLead.current_brokerage || "Brokerage unknown"}
                        </p>
                        {nextAgentLead.territory && (
                          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>📍 {nextAgentLead.territory}</p>
                        )}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                          color: "#4fb8a3", border: "1px solid rgba(79,184,163,0.3)",
                          borderRadius: 10, padding: "3px 10px", background: "rgba(79,184,163,0.08)",
                        }}>{nextAgentLead.status || "new"}</span>
                        {/* v14.77 — Removed all-time dial counter from my-next preview.
                            Every next lead should look fresh at preview time; agent
                            gets their own today-counter once they pull the card. */}
                      </div>
                    </div>

                    {/* Phone */}
                    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                      {nextAgentLead.phone && (
                        <a href={`tel:${nextAgentLead.phone}`} style={{
                          display: "flex", alignItems: "center", gap: 6,
                          background: "rgba(79,184,163,0.12)", border: "1px solid rgba(79,184,163,0.3)",
                          borderRadius: 10, padding: "10px 16px", color: "#4fb8a3", fontSize: 15, fontWeight: 700,
                          textDecoration: "none", flex: 1, justifyContent: "center", letterSpacing: "0.04em",
                        }}>
                          📞 {nextAgentLead.phone}
                        </a>
                      )}
                    </div>

                    {/* L.A.T.T.E. Script */}
                    <div style={{
                      background: "rgba(0,0,0,0.4)", border: "1px solid rgba(79,184,163,0.12)",
                      borderRadius: 12, padding: 16, marginBottom: 16,
                    }}>
                      <p style={{ fontSize: 10, fontWeight: 700, color: "#4fb8a3", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 12 }}>
                        L.A.T.T.E. Script
                      </p>
                      {[
                        { letter: "L", label: "License", prompt: "Confirm license status, state, and how long they've held it." },
                        { letter: "A", label: "Activity", prompt: "How many transactions last 12 months? What's their GCI range?" },
                        { letter: "T", label: "Trigger", prompt: "What made them fill out the form? Split, leads, culture, support?" },
                        { letter: "T", label: "Timeline", prompt: "Right now or 'keep me in mind'? This determines Hot Prospect vs KIT." },
                        { letter: "E", label: "Engage", prompt: "Invite them: '20 min with Alex — Zoom or in person — to walk through the split and territory map.'" },
                      ].map(({ letter, label, prompt }) => (
                        <div key={label} style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
                          <span style={{
                            width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            background: "rgba(79,184,163,0.15)", border: "1px solid rgba(79,184,163,0.35)",
                            fontSize: 12, fontWeight: 800, color: "#4fb8a3",
                            fontFamily: "'Cormorant Garamond','Georgia',serif",
                          }}>{letter}</span>
                          <div>
                            <p style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.8)", marginBottom: 2 }}>{label}</p>
                            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", lineHeight: 1.5 }}>{prompt}</p>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Their notes */}
                    {(nextAgentLead.applicant_notes || nextAgentLead.reason_for_leaving) && (
                      <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 14, marginBottom: 16, border: "1px solid rgba(255,255,255,0.06)" }}>
                        <p style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>Their Notes</p>
                        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.6 }}>{nextAgentLead.reason_for_leaving || nextAgentLead.applicant_notes}</p>
                      </div>
                    )}

                    {/* Call Notes */}
                    <div style={{ marginBottom: 16 }}>
                      <p style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>Call Notes</p>
                      <textarea
                        value={recruitCallNotes}
                        onChange={e => setRecruitCallNotes(e.target.value)}
                        placeholder="What did they say? License situation, timeline, objections..."
                        rows={3}
                        style={{
                          width: "100%", background: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10,
                          padding: "10px 12px", color: "#fff", fontSize: 13, lineHeight: 1.6,
                          resize: "vertical", outline: "none", boxSizing: "border-box",
                        }}
                      />
                    </div>

                    {/* Callback date — shown when pending outcome is callback */}
                    {recruitPendingOutcome === "callback_requested" && (
                      <div style={{ marginBottom: 16, background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.3)", borderRadius: 10, padding: 14 }}>
                        <p style={{ fontSize: 10, fontWeight: 700, color: "rgba(167,139,250,0.9)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Set Callback Date</p>
                        <input
                          type="date"
                          value={recruitCallbackDate}
                          onChange={e => setRecruitCallbackDate(e.target.value)}
                          min={new Date().toISOString().slice(0, 10)}
                          style={{
                            width: "100%", background: "rgba(255,255,255,0.06)",
                            border: "1px solid rgba(167,139,250,0.4)", borderRadius: 8,
                            padding: "10px 12px", color: "#fff", fontSize: 14,
                            outline: "none", boxSizing: "border-box",
                          }}
                        />
                        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                          <button
                            onClick={() => submitRecruitOutcome("callback_requested")}
                            disabled={!recruitCallbackDate || agentLeadMutation.isPending}
                            style={{
                              flex: 1, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 700,
                              background: recruitCallbackDate ? "rgba(167,139,250,0.3)" : "rgba(255,255,255,0.05)",
                              border: "1px solid rgba(167,139,250,0.4)", color: "#a78bfa",
                              cursor: recruitCallbackDate ? "pointer" : "not-allowed",
                            }}
                          >Confirm Callback</button>
                          <button
                            onClick={() => setRecruitPendingOutcome(null)}
                            style={{ padding: "10px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.4)", cursor: "pointer" }}
                          >Cancel</button>
                        </div>
                      </div>
                    )}

                    {/* Outcome buttons — 3x3 grid + Joined full width */}
                    {recruitPendingOutcome !== "callback_requested" && (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                          {[
                            { outcome: "dial_no_answer",    label: "No Answer",    color: "rgba(255,255,255,0.12)", text: "rgba(255,255,255,0.55)" },
                            { outcome: "keep_in_touch",     label: "Keep in Touch", color: "rgba(200,170,90,0.12)", text: "#c8aa5a" },
                            { outcome: "hot_prospect",      label: "🔥 Hot",        color: "rgba(249,115,22,0.15)", text: "#f97316" },
                            { outcome: "appointment",       label: "📅 Appt",       color: "rgba(79,184,163,0.2)",  text: "#4fb8a3" },
                            { outcome: "callback_requested",label: "📞 Callback",   color: "rgba(167,139,250,0.15)", text: "#a78bfa" },
                            { outcome: "not_now",           label: "❄ Not Now",    color: "rgba(255,255,255,0.06)", text: "rgba(255,255,255,0.4)" },
                            { outcome: "just_signed",       label: "📝 Just Signed",color: "rgba(255,255,255,0.06)", text: "rgba(255,255,255,0.4)" },
                            { outcome: "not_interested",    label: "Not Interest.", color: "rgba(239,68,68,0.08)",  text: "rgba(239,68,68,0.6)" },
                            { outcome: "do_not_contact",    label: "⛔ DNC",        color: "rgba(239,68,68,0.06)",  text: "rgba(239,68,68,0.4)" },
                          ].map(({ outcome, label, color, text }) => (
                            <button
                              key={outcome}
                              onClick={() => submitRecruitOutcome(outcome)}
                              disabled={agentLeadMutation.isPending}
                              style={{
                                background: color, border: `1px solid ${text}30`,
                                borderRadius: 10, padding: "11px 6px",
                                fontSize: 11, fontWeight: 600, color: text,
                                cursor: "pointer", transition: "all 0.2s", lineHeight: 1.3,
                                opacity: agentLeadMutation.isPending ? 0.5 : 1,
                              }}
                            >{label}</button>
                          ))}
                        </div>
                        {/* Joined Watson Brothers — confirm step */}
                        {!joinedTeamConfirm ? (
                          <button
                            onClick={() => setJoinedTeamConfirm(true)}
                            disabled={agentLeadMutation.isPending}
                            style={{
                              width: "100%",
                              background: "linear-gradient(135deg, rgba(34,197,94,0.3), rgba(34,197,94,0.15))",
                              border: "1px solid rgba(34,197,94,0.5)",
                              borderRadius: 12, padding: "14px 8px",
                              fontSize: 14, fontWeight: 700, color: "#22c55e",
                              cursor: "pointer", letterSpacing: "0.06em",
                              opacity: agentLeadMutation.isPending ? 0.5 : 1,
                            }}
                          >✓ Joined Watson Brothers</button>
                        ) : (
                          <div style={{
                            background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.4)",
                            borderRadius: 12, padding: "16px 14px",
                          }}>
                            <p style={{ fontSize: 13, color: "#22c55e", fontWeight: 700, marginBottom: 6, textAlign: "center" }}>
                              Confirm: Mark as Joined?
                            </p>
                            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 12, textAlign: "center", lineHeight: 1.5 }}>
                              This will award 50 pts and auto-create a Lead Depot account for this agent.
                              They will receive a setup email to complete onboarding.
                            </p>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button
                                onClick={() => setJoinedTeamConfirm(false)}
                                style={{
                                  flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                                  borderRadius: 8, padding: "10px 8px", fontSize: 12, fontWeight: 600,
                                  color: "rgba(255,255,255,0.5)", cursor: "pointer",
                                }}
                              >Cancel</button>
                              <button
                                onClick={() => { setJoinedTeamConfirm(false); submitRecruitOutcome("joined_team"); }}
                                disabled={agentLeadMutation.isPending}
                                style={{
                                  flex: 2, background: "linear-gradient(135deg, rgba(34,197,94,0.35), rgba(34,197,94,0.2))",
                                  border: "1px solid rgba(34,197,94,0.6)",
                                  borderRadius: 8, padding: "10px 8px", fontSize: 12, fontWeight: 700,
                                  color: "#22c55e", cursor: "pointer",
                                  opacity: agentLeadMutation.isPending ? 0.5 : 1,
                                }}
                              >✓ Yes, Confirm Joined</button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div style={{ textAlign: "center", padding: "60px 20px" }}>
                    <p style={{ fontSize: 32, marginBottom: 12 }}>🎯</p>
                    <p style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 20, color: "rgba(255,255,255,0.7)", marginBottom: 8 }}>
                      No agent leads in queue
                    </p>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>
                      Submit the recruiting form at join.watsonbrothersgroup.com to add prospects
                    </p>
                  </div>
                )}
              </div>
            ) : (
              // ── EXISTING SELLER LEAD CARD ───────────────────────────────────────────
              <>
                {leadLoading ? (
                  <div>
                    <Skeleton className="h-[480px] w-full rounded-2xl" style={{ background: "rgba(200,170,90,0.05)" }} />
                  </div>
                ) : !displayedLead ? (
                  <div style={{ textAlign: "center", paddingTop: 60 }}>
                    <div style={{
                      width: 72, height: 72,
                      border: "1px solid rgba(200,170,90,0.3)", borderRadius: "50%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      margin: "0 auto 24px",
                      background: "rgba(200,170,90,0.06)",
                      boxShadow: "0 0 30px rgba(200,170,90,0.1)",
                    }}>
                      <CheckCircle2 size={30} style={{ color: "#c8aa5a" }} />
                    </div>
                    <h2 style={{
                      fontFamily: "'Cormorant Garamond','Georgia',serif",
                      fontSize: "2rem", fontWeight: 300, color: "#fff", marginBottom: 12,
                    }}>Pool Ready</h2>
                    <p style={{ fontSize: 14, color: "rgba(255,255,255,0.45)", lineHeight: 1.65 }}>
                      Tap Load Next Lead to grab the next lead from the shared pool.
                    </p>
                    {onBackToAdmin && (
                      <button onClick={onBackToAdmin} style={{
                        marginTop: 24,
                        padding: "10px 24px",
                        background: "rgba(200,170,90,0.12)",
                        border: "1px solid rgba(200,170,90,0.35)",
                        borderRadius: 8,
                        color: "#c8aa5a",
                        fontSize: 13,
                        fontWeight: 600,
                        letterSpacing: "0.06em",
                        cursor: "pointer",
                      }}>← Back to Admin Dashboard</button>
                    )}
                  </div>
                ) : (
                  <>
                    {overrideLead && (
                      <div style={{
                        margin: "0 4px 10px",
                        padding: "10px 12px",
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        background: "rgba(200,170,90,0.08)",
                        border: "1px solid rgba(200,170,90,0.3)",
                        borderRadius: 10,
                      }}>
                        <p style={{ fontSize: 11, color: "#c8aa5a", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", margin: 0 }}>
                          Callback lookup — opened by "Who called me?"
                        </p>
                        <button onClick={clearPendingLead} style={{
                          fontSize: 11, color: "rgba(255,255,255,0.6)",
                          background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)",
                          borderRadius: 8, padding: "4px 10px", cursor: "pointer",
                        }}>Back to pool</button>
                      </div>
                    )}
                    {/* v14.80 — Tier 2: slide-in when a new lead loads. key={displayedLead.id}
                       forces a remount (and therefore the animation) every time the lead changes. */}
                    <div key={displayedLead.id} style={{ animation: "cardSlideIn 260ms cubic-bezier(0.4,0,0.2,1)" }}>
                      <LeadCard lead={displayedLead} />
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {tab === "pipeline" && (
          <MyLeadsTab
            onOpenLead={(leadId) => {
              try { sessionStorage.setItem("pending_lead_jump", String(leadId)); } catch {}
              setPendingLeadId(leadId);
              setTab("leads");
            }}
          />
        )}

        {tab === "refer" && <ReferralsHub />}

        {/* v14.50 — Global Who called me? modal (rendered from AgentView, works on every tab) */}
        {globalLookupOpen && (
          <CallbackLookupModal
            onClose={() => setGlobalLookupOpen(false)}
            onPickLead={(leadId: number) => {
              try { sessionStorage.setItem("pending_lead_jump", String(leadId)); } catch {}
              setPendingLeadId(leadId);
              setGlobalLookupOpen(false);
              setTab("leads");
            }}
          />
        )}
        {tab === "profile" && <ProfilePage onBack={() => setTab("leaderboard")} />}
      </main>

      {/* ── Bottom nav ── */}
      {/* v15.8 — data-ld-nav="bottom" so modals (RecycleModal etc.) can hide
          the nav via body.ld-modal-open (see <style> block below). Fixes iOS
          Safari backdrop-filter stacking-context bug where nav punched through
          modals despite lower zIndex. */}
      <nav data-ld-nav="bottom" style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 30,
        display: "flex",
        background: "linear-gradient(180deg, rgba(10,10,10,0.98) 0%, rgba(6,6,6,0.99) 100%)",
        backdropFilter: "blur(24px)",
        borderTop: "1px solid rgba(200,170,90,0.18)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        boxShadow: "0 -4px 24px rgba(0,0,0,0.5)",
      }}>
        {NAV.filter(n => mode === "seller" ? true : (n.id === "leaderboard" || n.id === "leads" || n.id === "profile")).map(n => {
          const Icon = n.icon;
          const active = tab === n.id;
          const showBadge = n.id === "leads" && hasLeads;
          // v14.68 — Dial gets prominent, elevated treatment (raised, gold gradient).
          const isDial = n.id === "leads";
          return (
            <button key={n.id} onClick={() => setTab(n.id)} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              gap: isDial ? 3 : 5,
              padding: isDial ? "6px 8px 14px" : "12px 8px 14px",
              background: (!isDial && active) ? "rgba(200,170,90,0.07)" : "transparent",
              borderTop: (!isDial && active) ? "2px solid #c8aa5a" : "2px solid transparent",
              border: "none", cursor: "pointer",
              position: "relative", transition: "all 0.2s ease",
            }}>
              {/* Elevated pill under the Dial icon */}
              {/* v14.79 — "GO MODE": when the Dial tab is currently active, the FAB
                 recedes because the real dial button is already the hero of the page.
                 Shrinks 52→38px, drops from -18px lift to -4px lift, softer gradient,
                 inset shadow so it reads as "pressed in", and a slow 2.4s ring pulse.
                 On other tabs, it stays big & raised as the CTA to enter dialing. */}
              {isDial ? (
                <div className={!active ? `fab-breathe${fabNudge ? " fab-nudge" : ""}` : undefined} style={{
                  position: "relative",
                  width: active ? 38 : 52, height: active ? 38 : 52,
                  marginTop: active ? -4 : -18,
                  borderRadius: "50%",
                  // v14.80 — Tier 4: non-active FAB gets a slow gold gradient breathe
                  // (fab-breathe class in style block below); active/pulsing state is
                  // untouched (goModePulse already owns that state).
                  background: active
                    ? "linear-gradient(135deg, #8a6f2a 0%, #6a5320 100%)"
                    : undefined,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: active
                    ? "inset 0 2px 6px rgba(0,0,0,0.55), 0 0 0 2px rgba(6,6,6,0.98), 0 0 0 3px rgba(200,170,90,0.35)"
                    : "0 4px 16px rgba(200,170,90,0.35), 0 0 0 3px rgba(6,6,6,0.98)",
                  transition: "all 0.28s cubic-bezier(0.4, 0, 0.2, 1)",
                  animation: active ? "goModePulse 2.4s ease-in-out infinite" : undefined,
                }}>
                  <Icon size={active ? 18 : 26} style={{ color: active ? "#c8aa5a" : "#0a0700", transition: "all 0.28s" }} />
                  {showBadge && (
                    /* v14.68 — Red dot only (no count). Signals "there is activity" without dread. */
                    <span style={{
                      position: "absolute", top: active ? -1 : -2, right: active ? -1 : -2,
                      width: active ? 8 : 12, height: active ? 8 : 12, borderRadius: "50%",
                      background: "#ef4444",
                      boxShadow: "0 0 8px rgba(239,68,68,0.85), 0 0 0 2px rgba(6,6,6,0.98)",
                    }} />
                  )}
                </div>
              ) : (
                <Icon size={22} style={{ color: active ? "#c8aa5a" : "rgba(255,255,255,0.35)", transition: "color 0.15s" }} />
              )}
              <span style={{
                fontSize: 10, letterSpacing: "0.08em",
                color: isDial
                  ? "#c8aa5a"
                  : (active ? "#c8aa5a" : "rgba(255,255,255,0.35)"),
                fontWeight: isDial ? 700 : (active ? 700 : 400),
                transition: "color 0.15s",
              }}>
                {n.label}
              </span>
            </button>
          );
        })}
      </nav>

      <style>{`
        /* v15.8 — hide the bottom nav while any full-screen modal is open. iOS
           Safari's backdrop-filter creates its own stacking context on the nav
           that ignores parent zIndex ordering; the safe universal fix is to
           remove the nav from paint entirely while a modal owns the screen. */
        body.ld-modal-open nav[data-ld-nav="bottom"] { display: none !important; }
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.85)} }
        /* v14.79 — "GO MODE" pulse: soft outer glow that breathes 2.4s. Signals
           the FAB is "live and in the pocket" without shouting for attention. */
        @keyframes goModePulse {
          0%,100% { box-shadow: inset 0 2px 6px rgba(0,0,0,0.55), 0 0 0 2px rgba(6,6,6,0.98), 0 0 0 3px rgba(200,170,90,0.35), 0 0 0 4px rgba(200,170,90,0.0); }
          50%     { box-shadow: inset 0 2px 6px rgba(0,0,0,0.55), 0 0 0 2px rgba(6,6,6,0.98), 0 0 0 4px rgba(200,170,90,0.55), 0 0 12px 4px rgba(200,170,90,0.18); }
        }
        input::placeholder, textarea::placeholder { color: rgba(255,255,255,0.25); }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.6) sepia(1) saturate(2) hue-rotate(5deg); }

        /* ─── v14.80 — Aliveness pack (Tier 1–4) ─────────────────────────────── */

        /* Tier 1 — ambient */
        @keyframes livePulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
        @keyframes wsHeartbeat {
          0%,100% { transform: scale(1); opacity:1 }
          30% { transform: scale(1.4); opacity:0.9 }
          60% { transform: scale(1); opacity: 0.7 }
        }
        @keyframes firstPlaceGlow {
          0%,100% { box-shadow: 0 0 0 0 rgba(200,170,90,0.5); }
          50%     { box-shadow: 0 0 0 8px rgba(200,170,90,0); }
        }
        .first-place-glow { animation: firstPlaceGlow 2.4s ease-in-out infinite; }

        /* Tier 2 — reactive */
        .outcome-btn:active { transform: scale(0.94); transition: transform 80ms; }
        @keyframes cardSlideIn { from { opacity:0; transform: translateY(16px) } to { opacity:1; transform: translateY(0) } }

        /* Tier 3 — celebrations */
        @keyframes apptShimmer { from { background-position: 150% 0; } to { background-position: -100% 0; } }

        /* Tier 4 — background */
        @keyframes fabBreathe {
          0%,100% { background: linear-gradient(135deg, #c8aa5a 0%, #8a6f2a 100%); }
          50%     { background: linear-gradient(135deg, #d9bf74 0%, #a8893a 100%); }
        }
        .fab-breathe { animation: fabBreathe 4s ease-in-out infinite; }
        /* Idle nudge: bigger-amplitude override, active for 2.5s then removed by JS */
        @keyframes fabNudgePulse {
          0%,100% { transform: scale(1); }
          50%     { transform: scale(1.14); }
        }
        .fab-nudge { animation: fabNudgePulse 0.6s ease-in-out 3 !important; }
      `}</style>

      {/* Tutorial modal */}
    </div>
  );
}
