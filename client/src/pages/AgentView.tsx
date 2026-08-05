import React, { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import coachingTips from "../data/coaching-tips.json";
import { pickLeadGenQuote, type MotivationalQuote } from "@/lib/leadgen-quotes";
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
  Home, Voicemail, Layers, Calendar, FileText,
  Camera, DoorOpen, Zap, X, ArrowLeft, Plus,
  Share2, Instagram, Target, Shield, Package,
} from "lucide-react";
import ProfilePage from "./ProfilePage";
import TeamMap from "./TeamMap";
import ConfettiCelebration from "../components/ld/ConfettiCelebration";
import GrandCelebration from "../components/ld/GrandCelebration";
import { RankTrophy } from "../components/ld/RankTrophy";
import { StreakBadge, ChampionFrame, useCurrentChampion } from "../components/ld/StreakBadge";
import PermissionGate, { shouldPromptPermissions } from "../components/ld/PermissionGate";
import { BookOpenHouseSheet } from "../components/ld/BookOpenHouseSheet";
import { playSound } from "@/lib/sounds";
import { hapticApptSet, hapticKit } from "@/lib/haptics";
import AnimatedNumber from "../components/AnimatedNumber";
import { computeCallHeat } from "@/lib/callHeat";
import { startPrimeNotifier, requestPrimeNotificationPermission } from "@/lib/primeNotifier";
import type { Lead as LeadRow } from "@shared/schema";
import { enqueueAndSendTap, subscribeQueueDepth } from "@/lib/tapQueue";  // v16.7

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

// v17.2 — Renter LPMA (Location, Price, Motivation, Appointment). No Agent /
// no Mortgage — renters don't sign buyer agency agreements and don't need
// lender pre-approval. Stored in extraData.renterLpma (JSON) to avoid a schema
// migration.
const RENTER_LPMA_FIELDS = [
  { key: "rLocation",   label: "R-L — Location",   color: "#4ade80", hint: "Where do they want to rent? Area / commute / school?" },
  { key: "rPrice",      label: "R-P — Price",      color: "#4ade80", hint: "Monthly rent budget? Any concessions expected?" },
  { key: "rMotivation", label: "R-M — Motivation", color: "#4ade80", hint: "Why renting? New to town, saving to buy, in-between?" },
  { key: "rAppointment",label: "R-A — Appointment",color: "#4ade80", hint: "When can they walk properties? Best day / time?" },
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
  left_voicemail:       "You confirmed the owner picks up on this line but couldn't get a real conversation. Lead recycles to the FRONT of the pool with all other lines struck. +6 pts.",
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
    kitNotes?: string;
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
  // v15.11.48 — KIT-only notes textarea. When the outcome is Keep in Touch
  // we drop the whole LPMAMAB-esque stage/intention/subject-confirm block —
  // the point of KIT is just to grab email + timing + a quick note. Anything
  // more is friction the agent will skip.
  const [kitNotes, setKitNotes] = React.useState<string>("");

  const toggleIntention = (key: string) => {
    setIntentions(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  // v15.11.48 — KIT branch: address is always the lead.address (no confirm step),
  // stage/intention aren't collected. Appt branch is unchanged.
  const confirmedAddress = isKit
    ? (lead.address || "")
    : (addressConfirmed ? (lead.address || "") : altAddress);
  // v15.11.49 — KIT no longer requires an email. Bronson reported being unable
  // to save a KIT because he took a real call, agreed to follow up in 6 months,
  // but the owner didn't hand over email. The gate on `apptEmail.trim()` silently
  // disabled the Log button and looked broken. If email is absent, the server
  // now skips the warm intro email and just logs the KIT + files it in Pipeline.
  const canSubmit = isKit
    ? Boolean(followUpTiming)
    : Boolean(
        apptEmail.trim() &&
        (addressConfirmed || altAddress.trim()) &&
        (!isAppt || (apptDate && apptTime)) &&
        stage && intentions.length > 0
      );

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
        {/* v15.11.48 — visible close X. Backdrop click already closes the modal
            but agents don't discover that. Absolute-positioned so it doesn't
            push layout, tap target sized for phones (44px). */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute", top: 12, right: 12,
            width: 40, height: 40, borderRadius: 20,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.14)",
            color: "rgba(255,255,255,0.75)",
            fontSize: 22, lineHeight: 1, fontWeight: 300,
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 0,
          }}
        >×</button>
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
            {/* v15.11.49 — Email is REQUIRED for Appt Set but OPTIONAL for KIT.
                A KIT can be logged without email; server skips the warm intro send. */}
            <label style={labelStyle}>
              Owner Email{isKit && <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400, letterSpacing: 0, textTransform: "none" }}> (optional)</span>}
            </label>
            <input type="email" value={apptEmail} onChange={e => setApptEmail(e.target.value)}
              placeholder="owner@email.com" style={inputStyle} />
          </div>
          {/* Subject Property confirm block — hidden for KIT (KIT keeps the lead's
              address as-is; the point is a fast email-and-timing capture). */}
          {!isKit && (
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
          )}
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
                We'll file this lead in your pipeline and route the follow-up to FUB.
              </p>
            </div>
          )}
          {/* v15.11.48 — KIT notes field. Replaces LPMAMAB stage/intention capture.
              Optional — an empty note still submits. */}
          {isKit && (
            <div>
              <label style={labelStyle}>Notes <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>(optional)</span></label>
              <textarea
                value={kitNotes}
                onChange={e => setKitNotes(e.target.value)}
                placeholder="What did they share? Timeline, situation, best time to reach out…"
                rows={3}
                style={{ ...inputStyle, fontFamily: "'Switzer','Inter',sans-serif", lineHeight: 1.5, resize: "vertical", minHeight: 84 }}
              />
            </div>
          )}
          {/* Stage / Intention / Source blocks — appointment-only. */}
          {!isKit && (<>
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
          </>)}
        </div>
        <button
          onClick={() => onSubmit({
            apptEmail, confirmedAddress, apptDate, apptTime,
            // For KIT we don't collect stage/intention; pass server-safe defaults.
            stage: isKit ? "Hot Prospect" : stage,
            intention: isKit ? "" : intentions.map(k => INTENTIONS.find(i => i.key === k)?.label || k).join(" + "),
            followUpTiming: isKit ? followUpTiming : undefined,
            kitNotes: isKit ? kitNotes : undefined,
          })}
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
// v15.11.43 — SkipModal now requires a REASON dropdown. Options match the
// server enum in POST /api/leads/:id/skip. "Other" reveals a small free-text
// field where the agent must type why (min 3 chars). We surface bucket
// state (available/cap + next regen countdown) plus rolling-24h count so agents
// see when they're about to hit escalating cooldowns.
const SKIP_REASON_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "wrong_phone",     label: "Wrong phone" },
  { key: "no_county_match", label: "No county match" },
  { key: "duplicate",       label: "Duplicate" },
  { key: "bad_data",        label: "Bad data" },
  { key: "never_expired",   label: "Never expired" },
  { key: "never_listed",    label: "Never listed" },
  { key: "other",           label: "Other (type it)" },
];

function SkipModal({
  onClose, onSubmit, isPending, available, cap, nextRegenAt, regenMin, rolling24h,
}: {
  onClose: () => void;
  onSubmit: (reason: string, reasonNote: string) => void;
  isPending: boolean;
  available: number;
  cap: number;
  nextRegenAt: string | null;
  regenMin: number;
  rolling24h: number;
}) {
  React.useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);
  const [reason, setReason] = React.useState<string>("");
  const [reasonNote, setReasonNote] = React.useState<string>("");

  // Live-tick countdown for the next regen.
  const [nowMs, setNowMs] = React.useState<number>(Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const regenSecondsLeft = nextRegenAt
    ? Math.max(0, Math.ceil((new Date(nextRegenAt).getTime() - nowMs) / 1000))
    : 0;
  const regenMinsLeft = Math.ceil(regenSecondsLeft / 60);

  const noSkips = available <= 0;
  const otherNeedsText = reason === "other" && reasonNote.trim().length < 3;
  const disabled = noSkips || !reason || otherNeedsText || isPending;

  const primaryLabel = isPending ? "Skipping…"
    : noSkips ? `Bucket empty — next skip in ${regenMinsLeft}m`
    : !reason ? "Pick a reason"
    : otherNeedsText ? "Type the reason"
    : "Skip Lead";

  // Escalation warning — tell the agent when they're one skip away from a slower regen.
  let escalationWarning: string | null = null;
  if (rolling24h >= 20) escalationWarning = "You're on 60-min regen right now (20+ skips in the last 24h).";
  else if (rolling24h >= 18) escalationWarning = `${20 - rolling24h} more skip${20 - rolling24h === 1 ? "" : "s"} in 24h and regen drops to 60 min.`;
  else if (rolling24h >= 10) escalationWarning = "You're on 30-min regen right now (10+ skips in the last 24h).";
  else if (rolling24h >= 8) escalationWarning = `${10 - rolling24h} more skip${10 - rolling24h === 1 ? "" : "s"} in 24h and regen drops to 30 min.`;

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
        padding: "28px 22px 44px",
        maxHeight: "88vh", overflowY: "auto",
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 22px" }} />
        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 26, fontWeight: 400, color: "#fff", margin: "0 0 8px" }}>
          Skip Lead
        </h2>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
          Skip only when something's wrong — a glitched card, wrong data, or a lead you can't advance. The lead goes back to the pool and won't come back to you for 24 hours.
        </p>

        {/* Bucket state */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "10px 12px", borderRadius: 8, background: "rgba(200,170,90,0.06)",
          border: "1px solid rgba(200,170,90,0.15)", marginBottom: 6,
        }}>
          <span style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(200,170,90,0.75)" }}>Skips available</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#e5c98a" }}>{available} / {cap}</span>
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.42)", marginBottom: 16, textAlign: "right" }}>
          {nextRegenAt
            ? `+1 skip in ${regenMinsLeft}m (${regenMin}-min regen)`
            : `Bucket full — max ${cap} skips`}
        </div>

        {escalationWarning && (
          <div style={{
            padding: "9px 12px", borderRadius: 8,
            background: "rgba(220,120,60,0.08)", border: "1px solid rgba(220,120,60,0.28)",
            fontSize: 11.5, color: "rgba(255,190,150,0.85)", marginBottom: 14, lineHeight: 1.4,
          }}>
            {escalationWarning}
          </div>
        )}

        {/* Reason — required */}
        <label style={{ display: "block", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>
          Reason
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: reason === "other" ? 12 : 22 }}>
          {SKIP_REASON_OPTIONS.map(opt => {
            const active = reason === opt.key;
            return (
              <button
                key={opt.key}
                onClick={() => setReason(opt.key)}
                style={{
                  padding: "10px 10px", borderRadius: 8,
                  background: active ? "rgba(200,170,90,0.14)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${active ? "rgba(200,170,90,0.55)" : "rgba(255,255,255,0.08)"}`,
                  color: active ? "#e5c98a" : "rgba(255,255,255,0.75)",
                  fontSize: 12, fontWeight: 600, letterSpacing: "0.01em", cursor: "pointer", textAlign: "left",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {reason === "other" && (
          <div style={{ marginBottom: 22 }}>
            <label style={{ display: "block", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>
              What's the reason?
            </label>
            <input
              type="text"
              value={reasonNote}
              onChange={e => setReasonNote(e.target.value.slice(0, 200))}
              placeholder="e.g. Wrong owner name, address doesn't exist…"
              maxLength={200}
              autoFocus
              style={{
                width: "100%", padding: "12px 12px", borderRadius: 8,
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(200,170,90,0.35)",
                color: "#fff", fontSize: 13, outline: "none",
              }}
            />
            <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.38)", marginTop: 4, textAlign: "right" }}>
              {reasonNote.length}/200
            </div>
          </div>
        )}

        <button
          onClick={() => onSubmit(reason, reasonNote)}
          disabled={disabled}
          style={{
            width: "100%", padding: "16px", borderRadius: 12, border: "none",
            background: !disabled ? "linear-gradient(135deg,#c8aa5a,#a8893a)" : "rgba(255,255,255,0.06)",
            color: !disabled ? "#0a0700" : "rgba(255,255,255,0.3)",
            fontSize: 15, fontWeight: 700, cursor: !disabled ? "pointer" : "default",
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

// v15.11.38 — Coach's Corner. Rotates through client/src/data/coaching-tips.json,
// the SAME JSON the login screen reads. Alex authors tips there — add / edit /
// reorder without touching this file. Cards auto-rotate every 12s; tap dots to
// jump. Operations tips (Appts=60/120, KIT-needs-email, home-address routing,
// Prime doubles, network referral) live in the 'operations' category of the
// JSON so they're editable too.
//
// Special-case: if an agent has NO homeAddress/homeCounty set, the home-base
// operations tip is promoted to the front of the deck so they see it first. Once
// they've set a home base, the deck plays in normal random-shuffle order.
function AdviceCarousel() {
  const { user } = useAuth();
  const homeCounty  = ((user as any)?.homeCounty  || "").toString().trim();
  const homeAddress = ((user as any)?.homeAddress || "").toString().trim();
  const hasHomeBase = homeCounty.length > 0 || homeAddress.length > 0;

  const cards = useMemo(() => {
    const all = (coachingTips.tips || []) as Array<{
      id: number; category: string; type: string; text: string; author: string | null;
    }>;
    if (all.length === 0) return [] as typeof all;

    // Shuffle once per mount so the deck feels fresh each dial session.
    const shuffled = [...all].sort(() => Math.random() - 0.5);

    // If home-base isn't set, hoist the home-address tip to slot 0.
    if (!hasHomeBase) {
      const homeIdx = shuffled.findIndex(t => /home address/i.test(t.text) && t.category === "operations");
      if (homeIdx > 0) {
        const [homeTip] = shuffled.splice(homeIdx, 1);
        shuffled.unshift(homeTip);
      }
    }
    return shuffled;
  }, [hasHomeBase]);

  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (cards.length <= 1) return;
    const t = setInterval(() => setIdx(i => (i + 1) % cards.length), 12_000);
    return () => clearInterval(t);
  }, [cards.length]);

  if (cards.length === 0) return null;
  const card = cards[idx % cards.length];
  const cats = coachingTips.categories as Record<string, { label: string; color: string }>;
  const category = cats[card.category] || { label: card.category.toUpperCase(), color: "#c8aa5a" };
  const isQuote = card.type === "quote";

  // Derive translucent bg + border from the category's accent color so every
  // category tints its card automatically — no per-tip styling to maintain.
  const hex = category.color.replace("#", "");
  const r = parseInt(hex.substring(0,2), 16);
  const g = parseInt(hex.substring(2,4), 16);
  const b = parseInt(hex.substring(4,6), 16);
  const bg = `rgba(${r},${g},${b},0.06)`;
  const border = `rgba(${r},${g},${b},0.35)`;

  return (
    <div
      key={card.id}
      style={{
        margin: "16px 4px 0",
        padding: "14px 16px 16px",
        borderRadius: 14,
        background: bg,
        border: `1px solid ${border}`,
        position: "relative",
        animation: "cardSlideIn 320ms cubic-bezier(0.4,0,0.2,1)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            width: 6, height: 6, borderRadius: 999, background: category.color,
            boxShadow: `0 0 10px ${category.color}88`,
          }} />
          <span style={{
            fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase",
            color: category.color, fontWeight: 700,
          }}>{category.label} · Coach’s Corner</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, maxWidth: 120, overflow: "hidden" }}>
          {cards.slice(0, 8).map((_, i) => {
            const modIdx = idx % cards.length;
            const isActive = i === Math.min(modIdx, 7);
            return (
              <button
                key={i}
                onClick={() => setIdx(i)}
                aria-label={`Advice ${i + 1} of ${Math.min(cards.length, 8)}`}
                style={{
                  width: isActive ? 14 : 5,
                  height: 5, borderRadius: 999,
                  background: isActive ? category.color : "rgba(255,255,255,0.18)",
                  border: "none", padding: 0, cursor: "pointer",
                  transition: "width 200ms ease, background 200ms ease",
                }}
              />
            );
          })}
        </div>
      </div>
      {isQuote ? (
        <>
          <h4 style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            fontStyle: "italic", fontSize: 20, lineHeight: 1.3, fontWeight: 500,
            color: "#fff", margin: "4px 0 6px",
          }}>“{card.text}”</h4>
          {card.author && (
            <p style={{
              fontSize: 12, color: "rgba(255,255,255,0.55)", margin: 0, fontStyle: "italic",
            }}>— {card.author}</p>
          )}
        </>
      ) : (
        <p style={{
          fontSize: 14, lineHeight: 1.5,
          color: "rgba(255,255,255,0.82)", margin: 0,
        }}>{card.text}</p>
      )}
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
  // v15.11.29 — iOS keyboard detach fix. When any text/number/textarea input
  // on the page is focused (buyer-target inputs, KIT modal, network form, etc.),
  // the iOS software keyboard resizes the visualViewport but position:fixed
  // stays anchored to the layout viewport — causing the sticky outcomes bar to
  // appear to "detach" from the bottom and float mid-screen over the content.
  // Hiding the bar while an input is focused is the cleanest fix: agents can
  // still see what they're typing, the bar re-anchors correctly the moment
  // they blur the input, and outcomes aren't reachable mid-typing anyway.
  const [inputFocused, setInputFocused] = useState(false);
  useEffect(() => {
    const isTextInput = (el: EventTarget | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "TEXTAREA") return true;
      if (tag === "INPUT") {
        const t = (el as HTMLInputElement).type;
        return t === "text" || t === "number" || t === "email" || t === "tel" || t === "search" || t === "password" || t === "url" || t === "date" || t === "time" || t === "datetime-local";
      }
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    };
    const onFocusIn  = (e: FocusEvent) => { if (isTextInput(e.target)) setInputFocused(true); };
    const onFocusOut = () => { setInputFocused(false); };
    window.addEventListener("focusin",  onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("focusin",  onFocusIn);
      window.removeEventListener("focusout", onFocusOut);
    };
  }, []);
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
  // v15.11.48 — KIT gets its own grander, gold-only, shimmering celebration.
  const [showGrandCelebration, setShowGrandCelebration] = useState(false);
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
    // v17.2 — Renter LPMA (JSON-in-extraData; no SQL columns)
    rLocation:    (() => { try { return JSON.parse((lead as any).extraData || "{}").renterLpma?.rLocation    ?? ""; } catch { return ""; } })(),
    rPrice:       (() => { try { return JSON.parse((lead as any).extraData || "{}").renterLpma?.rPrice       ?? ""; } catch { return ""; } })(),
    rMotivation:  (() => { try { return JSON.parse((lead as any).extraData || "{}").renterLpma?.rMotivation  ?? ""; } catch { return ""; } })(),
    rAppointment: (() => { try { return JSON.parse((lead as any).extraData || "{}").renterLpma?.rAppointment ?? ""; } catch { return ""; } })(),
  });

  // v15.11.27 — Buyer Target (future home the buyer wants to acquire).
  // Distinct from lead.extraData (which describes their CURRENT home). All buyers
  // (buy_only + sell_and_buy) fill this in during discovery: how many beds/baths,
  // budget, must-haves for the home they want to purchase.
  const initialBuyerTarget = (() => {
    try { return JSON.parse((lead as any).buyerTarget || "{}"); } catch { return {}; }
  })();
  const [buyerTarget, setBuyerTarget] = useState<Record<string, string>>({
    beds:      initialBuyerTarget.beds      ?? "",
    baths:     initialBuyerTarget.baths     ?? "",
    sqft:      initialBuyerTarget.sqft      ?? "",
    budget:    initialBuyerTarget.budget    ?? "",
    garage:    initialBuyerTarget.garage    ?? "",
    pool:      initialBuyerTarget.pool      ?? "",
    areas:     initialBuyerTarget.areas     ?? "",
    mustHaves: initialBuyerTarget.mustHaves ?? "",
  });
  // v14.53 / v17.2 — Intent selector: mutually-exclusive choice powering the
  // Work-the-Lead script tabs.
  //   sell_only        → Seller CPMAMA only
  //   sell_and_buy     → Seller CPMAMA + Buyer LPMAMA
  //   buy_only         → Buyer LPMAMA only
  //   rent_only        → Renter LPMA only (v17.2 — new)
  //   sell_and_rent    → Seller CPMAMA + Renter LPMA (v17.2 — new)
  // Priority: extraData.warmLeadIntent (v17.2 unified) > lead.intent > alsoBuying flag > default.
  type Intent = "sell_only" | "sell_and_buy" | "buy_only" | "rent_only" | "sell_and_rent";
  const extra = (() => { try { return JSON.parse(lead.extraData || "{}"); } catch { return {}; } })();
  const warmLeadIntentRaw = String(extra?.warmLeadIntent || "");
  const warmToLegacy: Record<string, Intent | null> = {
    buyer: "buy_only", seller: "sell_only", renter: "rent_only",
    seller_and_buyer: "sell_and_buy", seller_and_renter: "sell_and_rent",
    future_buyer: "buy_only", future_seller: "sell_only", future_renter: "rent_only",
    future_seller_and_buyer: "sell_and_buy", future_seller_and_renter: "sell_and_rent",
  };
  const initialIntent: Intent = warmToLegacy[warmLeadIntentRaw] || ((lead as any).intent as Intent) ||
    ((lead as any).alsoBuying ? "sell_and_buy" : "sell_only");
  const [intent, setIntent] = useState<Intent>(initialIntent);
  const alsoBuying = intent === "sell_and_buy"; // preserved derived flag for downstream code / FUB
  const showSellerCard = intent === "sell_only" || intent === "sell_and_buy" || intent === "sell_and_rent";
  const showBuyerCard = intent === "buy_only" || intent === "sell_and_buy";
  const showRenterCard = intent === "rent_only" || intent === "sell_and_rent";

  const { data: script } = useQuery<{ content: string }>({
    queryKey: ["/api/scripts", lead.leadType],
    queryFn: () => apiRequest("GET", `/api/scripts/${lead.leadType}`).then(r => r.json()),
    staleTime: 60000,
  });

  // v15.11.42 — Live autofill for the script placeholders. The raw template stays
  // locked in the DB (Alex-authored, read-only). Below we render a display-only
  // overlay where [First Name], [Agent First Name], [Street number and name only],
  // and "Agent Name" get replaced with the current lead + logged-in agent values.
  // Switching leads or logging in as a different agent re-renders live — no save,
  // no DB write, no template drift.
  const scriptFilled = React.useMemo(() => {
    if (!script?.content) return "";
    // v15.11.45 — Derive seller first name from lead.ownerName. LandVoice + BatchLeads
    // both give us the full name in owner_name; there is no separate firstName column.
    // We title-case ALL-CAPS input ("PAZ FIGURACION" → "Paz") so the script reads natural.
    const titleCase = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "";
    const rawOwner = (lead.ownerName || "").trim();
    // Strip common CSV noise prefixes ("TEST-APPT ", "AUDIT ", etc).
    const ownerClean = rawOwner.replace(/^(TEST-\S+|AUDIT|TEST)\s+/i, "").trim();
    const leadFirst  = titleCase(ownerClean.split(/\s+/)[0] || "");
    const agentFullName = (user?.name || "").trim();
    const agentFirst = agentFullName.split(/\s+/)[0] || "";
    // Extract "123 Oak" style street number + street name from the address. Drops
    // apt/unit tokens, comma-separated city/state/zip, and any trailing directional suffixes.
    const streetOnly = (() => {
      const raw = (lead.address || "").trim();
      if (!raw) return "";
      // Everything before the first comma is the street line.
      const streetLine = raw.split(",")[0].trim();
      // Strip apt/unit/suite/# suffixes.
      return streetLine
        .replace(/\s+(apt|apartment|unit|suite|ste|#)\.?\s*\S+.*/i, "")
        .trim();
    })();
    // v15.11.45 — City. First try lead.city column (canonical). If empty (older
    // seed rows), fall back to the 2nd comma-segment of the address.
    const cityFromAddress = (() => {
      const parts = (lead.address || "").split(",").map((s: string) => s.trim());
      return parts.length >= 2 ? parts[1] : "";
    })();
    const city = ((lead.city || "").trim() || cityFromAddress || "").trim();
    return script.content
      // Order matters: replace "Agent First Name" BEFORE "First Name" to avoid
      // the general placeholder eating the agent one.
      .replace(/\[Agent First Name\]/g, agentFirst || "[Agent First Name]")
      .replace(/\[Agent Name\]/g,       agentFullName || "[Agent Name]")
      .replace(/\bAgent Name\b(?= from The Brothers Group)/g, agentFullName || "Agent Name")
      .replace(/\[First Name\]/g,       leadFirst || "[First Name]")
      .replace(/\[Street number and name only\]/g, streetOnly || "[Street number and name only]")
      .replace(/\[City\]/g,             city || "[City]");
  }, [script?.content, lead.ownerName, lead.address, lead.city, user?.name]);

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
    left_voicemail:           { label: "Owner Confirmed — Recycled", color: "rgb(147,197,253)" },
  };

  // v15.11.43 — Skip mutation. POST /api/leads/:id/skip now requires a REASON
  // (see SkipModal). Bucket-based quota: 3 tokens, +1 every 15 min, escalating
  // to 30 min / 60 min at 10 / 20 skips in rolling 24h. Owner Confirmed leads
  // are hard-blocked (server returns 423).
  const skipMutation = useMutation({
    mutationFn: (vars: { reason: string; reasonNote: string }) =>
      apiRequest("POST", `/api/leads/${lead.id}/skip`, {
        agentId: user?.id,
        reason: vars.reason,
        reasonNote: vars.reasonNote,
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
      if (code === "BUCKET_EMPTY") {
        const mins = err.body.nextRegenAt
          ? Math.max(1, Math.ceil((new Date(err.body.nextRegenAt).getTime() - Date.now()) / 60_000))
          : err.body.regenMin;
        toast({ title: "No skips available", description: `Bucket regenerates 1 skip every ${err.body.regenMin} min. Next skip in ~${mins}m.`, variant: "destructive" });
      } else if (code === "OWNER_CONFIRMED_LOCKED") {
        toast({ title: "Owner Confirmed — skip blocked", description: "Skip is disabled on Owner Confirmed leads. Use Recycle if you can't advance.", variant: "destructive" });
      } else if (code === "REASON_REQUIRED") {
        toast({ title: "Pick a skip reason", variant: "destructive" });
      } else if (code === "OTHER_NOTE_REQUIRED") {
        toast({ title: "Type a reason for 'Other'", variant: "destructive" });
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
        // v15.11.28 — Same override-clear as outcomeMutation. Recycle closes
        // the lead; if it came from Who-Called-Me, clear the pin so the pool loads.
        try { sessionStorage.removeItem("pending_lead_jump"); } catch {}
        window.dispatchEvent(new Event("pending_lead_jump_changed"));
      }, 900);
    },
    onError: () => toast({ title: "Error recycling lead", variant: "destructive" }),
  });

  const outcomeMutation = useMutation({
    mutationFn: (data: { outcome: string; notes?: string; callbackDate?: string; apptEmail?: string; confirmedAddress?: string; apptDate?: string; apptTime?: string; stage?: string; intention?: string; dialedPhone?: string; followUpTiming?: string }) => {
      // v14.20 — include alsoBuying + Buyer LPMAMA inside lpmamab payload so
      // server /outcome handler + pushOutcomeToFub both get the buyer context.
      // v16.7 — Route through offline tap queue. Every tap gets a UUID + is
      // persisted before send. If offline or the server hiccups, it retries in
      // the background until the server returns a receipt. Server-side dedup by
      // clientTapId prevents double-counting on retry.
      return enqueueAndSendTap(`/api/leads/${lead.id}/outcome`, {
        ...data,
        agentId: user?.id,
        lpmamab: { ...lpmData, alsoBuying, intent, buyerTarget: JSON.stringify(buyerTarget) },
      });
    },
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
      // v15.11.48 — KIT now fires the grand gold-shimmer celebration + its own
      // fanfare (see GrandCelebration.tsx). Same intent as the appointment
      // confetti, but grander — gold-only palette, sparkle layer, radial
      // shimmer sweep, longer duration.
      if (variables.outcome === "keep_in_touch") {
        setShowGrandCelebration(true);
        setApptShimmerKey(k => k + 1); // reuse the tile-side shimmer effect too
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
        // v15.11.41 — Owner - No Answer: current line stays no_answer_today, ALL
        // other lines strike immediately (we know they're not the owner).
        if (variables.outcome === "left_voicemail" && dialed) {
          projectedStates[dialed] = "no_answer_today";
          for (const p of allPhones) if (p !== dialed) projectedStates[p] = "struck";
        }
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
          // v15.11.41 — Owner - No Answer now recycles the lead to the front of
          // the pool with all non-owner lines struck. No voicemail language.
          toast({
            title: "Owner confirmed — recycled to front of pool",
            description: `Line ${currentLineNum} is now the only viable number. +6 points.`,
            duration: 3500,
          });
        }
      }

      setTimeout(() => {
        setOutcomeFlash(null);
        qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
        qc.invalidateQueries({ queryKey: [`/api/leads/my-count/${user?.id}`] });
        qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
        // v15.11.28 — If this outcome closed the lead (Not Interested nice/rude, Recycle,
        // KIT, Appt, Listed, Wrong #), and the current lead came from a Who-Called-Me /
        // search-selected pendingLeadId override, clear the override so the Dial screen
        // advances to the next pool lead. Without this, /api/leads/by-id keeps returning
        // the (now-closed) lead until refetch; the pool pull is masked. Reported by
        // Bronson: tapped Not Interested → Nice on Marcos, screen didn't advance.
        // v15.11.47 — Added "left_voicemail" (Owner - No Answer). It also unassigns the
        // lead and recycles it to the pool (or deletes it on exhaustion), so it was
        // missing from this set for no good reason — caused the exact same "screen
        // doesn't advance, looks like nothing changed" symptom Alex reported.
        const CLOSING_OUTCOMES = new Set([
          "contacted_not_interested", "nice_not_interested",
          "contacted_appointment", "keep_in_touch",
          "recycled", "listed", "wrong_number", "disconnected", "left_voicemail",
        ]);
        if (CLOSING_OUTCOMES.has(variables.outcome as string)) {
          try { sessionStorage.removeItem("pending_lead_jump"); } catch {}
          window.dispatchEvent(new Event("pending_lead_jump_changed"));
        }
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

  const handleApptSubmit = (data: { apptEmail: string; confirmedAddress: string; apptDate: string; apptTime: string; stage: string; intention: string; followUpTiming?: string; kitNotes?: string }) => {
    if (!pendingOutcome) return;
    // v15.11.48 — For KIT, prefer the modal's own notes textarea over any
    // notes typed in the LPMAMAB scratchpad. For Appt, keep the existing
    // scratchpad notes flow.
    const isKit = pendingOutcome === "keep_in_touch";
    const { kitNotes, ...rest } = data;
    outcomeMutation.mutate({
      outcome: pendingOutcome,
      notes: isKit ? (kitNotes || "") : notes,
      ...rest,
    });
    setPendingOutcome(null);
  };

  const zillow = lead.address ? `https://www.zillow.com/homes/${encodeURIComponent(lead.address)}_rb/` : null;

  // v15.11.45 — Florida county Property Appraiser search URLs. Second link on the
  // Zillow row gives agents a one-tap peek at the official tax record (ownership,
  // legal description, assessed value, sales history). Each county appraiser has
  // their own site; we pick by lead.county. Query is passed as the parcel address
  // where the appraiser supports it, otherwise falls back to their generic search.
  const countyAppraiser = (() => {
    const c = String(lead.county || "").trim().toLowerCase();
    const addr = encodeURIComponent(String(lead.address || "").split(",")[0].trim());
    if (!c || !addr) return null;
    const map: Record<string, { url: string; label: string }> = {
      // v15.11.48 — all counties now route through our server-side /api/pa-lookup
      // redirect endpoint. The server tries a real deep-link to the specific
      // property page (Duval via ArcGIS parcel lookup → Detail.aspx?RE=...,
      // Nassau via search.ncpafl.com → /parcel/<id>) and falls back to
      // pre-filled search pages elsewhere. Keeps a single UX entry point.
      "duval":      { url: `/api/pa-lookup?county=duval&address=${addr}`,     label: "Duval PA" },
      "nassau":     { url: `/api/pa-lookup?county=nassau&address=${addr}`,    label: "Nassau PA" },
      "st. johns":  { url: `/api/pa-lookup?county=st.%20johns&address=${addr}`,label: "St. Johns PA" },
      "st johns":   { url: `/api/pa-lookup?county=st%20johns&address=${addr}`, label: "St. Johns PA" },
      "st_johns":   { url: `/api/pa-lookup?county=st_johns&address=${addr}`,   label: "St. Johns PA" },
      "clay":       { url: `/api/pa-lookup?county=clay&address=${addr}`,      label: "Clay PA" },
      "putnam":     { url: `/api/pa-lookup?county=putnam&address=${addr}`,    label: "Putnam PA" },
      "flagler":    { url: `/api/pa-lookup?county=flagler&address=${addr}`,   label: "Flagler PA" },
      "baker":      { url: `/api/pa-lookup?county=baker&address=${addr}`,     label: "Baker PA" },
      "camden":     { url: `/api/pa-lookup?county=camden&address=${addr}`,    label: "Camden PA" },
      "charlton":   { url: `/api/pa-lookup?county=charlton&address=${addr}`,  label: "Charlton PA" },
      "glynn":      { url: `/api/pa-lookup?county=glynn&address=${addr}`,     label: "Glynn PA" },
    };
    return map[c] || null;
  })();

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
      {/* ── Grand gold-shimmer celebration (Keep in Touch) v15.11.48 ── */}
      {showGrandCelebration && <GrandCelebration onDone={() => setShowGrandCelebration(false)} />}

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
            // v17.2 — prefer warmLeadIntent from extraData over legacy lead.intent.
            const warmDerived = warmToLegacy[warmLeadIntentRaw];
            const derived = warmDerived || rawIntent || ((lead as any).alsoBuying ? "sell_and_buy" : null);
            if (!derived) return null;
            const styles: Record<string, { bg: string; fg: string; border: string; label: string; title: string }> = {
              sell_only:     { bg: "rgba(200,170,90,0.18)", fg: "#c8aa5a", border: "rgba(200,170,90,0.55)", label: "SELL",       title: "Seller intent — CPMAMA script" },
              buy_only:      { bg: "rgba(147,197,253,0.18)", fg: "#93c5fd", border: "rgba(59,130,246,0.55)", label: "BUY",       title: "Buyer intent — Buyer LPMAMA script" },
              rent_only:     { bg: "rgba(74,222,128,0.18)",  fg: "#4ade80", border: "rgba(34,197,94,0.55)",  label: "RENT",      title: "Renter intent — LPMA script" },
              sell_and_buy:  { bg: "linear-gradient(90deg, rgba(200,170,90,0.22) 0%, rgba(147,197,253,0.22) 100%)", fg: "#f0f0f0", border: "rgba(200,170,90,0.5)", label: "SELL & BUY",  title: "Multi-transaction — CPMAMA + Buyer LPMAMA" },
              sell_and_rent: { bg: "linear-gradient(90deg, rgba(200,170,90,0.22) 0%, rgba(74,222,128,0.22) 100%)",  fg: "#f0f0f0", border: "rgba(200,170,90,0.5)", label: "SELL & RENT", title: "Multi-transaction — CPMAMA + Renter LPMA" },
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


        {/* v15.11.45 — Split into Zillow (left, market view) + County Property
            Appraiser (right, official tax record). County resolved from lead.county,
            falls back to Zillow-only when county is unknown. */}
        {zillow && (
          <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
            <a href={zillow} target="_blank" rel="noopener noreferrer" style={{
              flex: 1, minWidth: 0,
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "13px 12px",
              background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.3)",
              borderRadius: 8, textDecoration: "none",
              fontSize: 13, color: "rgba(147,197,253,0.9)", minHeight: 48,
            }}>
              <TrendingUp size={13} /> Zillow
            </a>
            {countyAppraiser && (
              <a href={countyAppraiser.url} target="_blank" rel="noopener noreferrer" style={{
                flex: 1, minWidth: 0,
                display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                padding: "13px 12px",
                background: "rgba(147,197,253,0.06)", border: "1px solid rgba(147,197,253,0.28)",
                borderRadius: 8, textDecoration: "none",
                fontSize: 13, color: "rgba(147,197,253,0.9)", minHeight: 48,
              }}>
                <FileText size={13} /> {countyAppraiser.label}
              </a>
            )}
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

        {/* v20.7.0 — ADAPTIVE INTEL PANEL. Every lead card now surfaces four
            sub-rows in priority order: Owner Intel, Financial Intel, Property
            / MLS Intel, and the Source Provenance strip. Empty fields HIDE
            silently (no "N/A" placeholders). This replaces the v14.74 static
            LANDVOICE INTEL PANEL. See references/BUGLIST.md v20.7.0 entry. */}
        {(() => {
          // ----- Data extraction (defensive; any field may be missing) -----
          const relatedCount = Number((lead as any).relatedPropertyCount || 0);
          const propCity = (lead.city || "").trim().toLowerCase();
          const mailCity = (extra.ownerMailing?.city || "").trim().toLowerCase();
          const mailState = (extra.ownerMailing?.state || "").trim().toUpperCase();
          const outOfArea = mailCity && propCity && mailCity !== propCity;
          const outOfState = mailState && mailState !== "FL";
          const investorFlag = outOfState || outOfArea;

          // Owner-name shape hints (LLC / TRUST / ESTATE)
          const rawOwner = String(lead.ownerName || "").trim();
          const upperOwner = rawOwner.toUpperCase();
          const isLLC = /\b(LLC|INC|CORP|HOLDINGS|PROPERTIES|GROUP|LP|LLLP|PA|PLLC)\b/.test(upperOwner);
          const isTrust = /\b(TRUST|TRUSTEE|ESTATE)\b/.test(upperOwner);

          // Financial calculations
          const listPrice = Number(lead.listPrice || 0);
          const assessed = Number(lead.assessedValue || 0);
          const lastSale = Number(lead.lastSalePrice || 0);
          const equityDollars = listPrice > 0 && lastSale > 0 ? listPrice - lastSale : null;
          const equityPct = equityDollars != null && listPrice > 0
            ? Math.round((equityDollars / listPrice) * 100)
            : null;

          // Source provenance
          const sourceRaw = String((lead as any).source || "").toLowerCase();
          const sourceLabel =
            sourceRaw.includes("landvoice_expired") ? { text: "LANDVOICE · EXPIRED", color: "#fcd34d" } :
            sourceRaw.includes("landvoice_listing") ? { text: "LANDVOICE · LISTING", color: "#fcd34d" } :
            sourceRaw.includes("landvoice")         ? { text: "LANDVOICE", color: "#fcd34d" } :
            sourceRaw.includes("batchleads")        ? { text: "BATCHLEADS", color: "#93c5fd" } :
            sourceRaw.includes("fub")               ? { text: "FOLLOW UP BOSS", color: "#86efac" } :
            sourceRaw.includes("network")           ? { text: "NETWORK REFERRAL", color: "#c4b5fd" } :
            sourceRaw.includes("open_house")        ? { text: "OPEN HOUSE", color: "#f0abfc" } :
            sourceRaw.includes("door_knock")        ? { text: "DOOR KNOCK", color: "#f0abfc" } :
            sourceRaw.includes("direct_mail")       ? { text: "DIRECT MAIL", color: "#f0abfc" } :
            sourceRaw.includes("csv_upload")        ? { text: "MANUAL UPLOAD", color: "rgba(255,255,255,0.55)" } :
            null;
          const mergeReview = extra.mergeReview;

          // Excel-serial-safe date formatter (belt for a suspenders already
          // installed in the parser — legacy rows may still carry raw serials).
          const fmtDate = (v: any): string => {
            if (v == null || v === "") return "";
            const s = String(v).trim();
            const asNum = Number(s);
            if (Number.isFinite(asNum) && asNum > 25569 && asNum < 60000) {
              const ms = Math.round((asNum - 25569) * 86400 * 1000);
              const d = new Date(ms);
              if (!isNaN(d.getTime())) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            }
            const d = new Date(s);
            if (!isNaN(d.getTime())) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            return s;
          };
          const fmtMoney = (n: number) => "$" + Math.round(n).toLocaleString();

          // ----- Row-presence gates -----
          const hasOwner = relatedCount > 0 || isLLC || isTrust || investorFlag || (extra.ownerMailing && (extra.ownerMailing.street || extra.ownerMailing.city)) || extra.ownerOccupied === true || extra.ownerIsAgent;
          const hasFinancial = listPrice > 0 || assessed > 0 || lastSale > 0 || equityPct != null;
          const hasProperty = extra.mlsNumber || extra.mlsStatus || extra.daysOnMarket != null || extra.listAgent || extra.beds != null || extra.yearBuilt || extra.remarks || extra.statusDate;
          const hasSource = sourceLabel || mergeReview;

          if (!hasOwner && !hasFinancial && !hasProperty && !hasSource) return null;

          // ----- Row builders -----
          const RowLabel = ({ children }: { children: React.ReactNode }) => (
            <div style={{
              fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase",
              color: "rgba(147,197,253,0.7)", fontWeight: 700, marginBottom: 6,
            }}>{children}</div>
          );
          const cellStyle: React.CSSProperties = { fontSize: 12, color: "rgba(255,255,255,0.55)" };
          const valStyle: React.CSSProperties = { color: "rgba(255,255,255,0.85)", fontWeight: 600 };

          return (
            <div style={{
              marginBottom: 12, padding: "12px 14px",
              background: "rgba(147,197,253,0.06)",
              border: "1px solid rgba(147,197,253,0.22)",
              borderRadius: 8,
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              {/* ── OWNER INTEL ── */}
              {hasOwner && (
                <div>
                  <RowLabel>Owner Intel</RowLabel>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {relatedCount > 0 && (
                      <div style={{
                        padding: "6px 10px", borderRadius: 6,
                        background: "rgba(252,211,77,0.12)", border: "1px solid rgba(252,211,77,0.4)",
                        fontSize: 12, color: "#fcd34d", fontWeight: 700, letterSpacing: "0.02em",
                      }}>
                        🏘 Owner of {relatedCount + 1} propert{relatedCount + 1 === 1 ? "y" : "ies"} in the database
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px" }}>
                      {isLLC && (
                        <div style={{ ...cellStyle }}>
                          Entity <span style={{ color: "#c4b5fd", fontWeight: 600 }}>LLC / business</span>
                        </div>
                      )}
                      {isTrust && (
                        <div style={{ ...cellStyle }}>
                          Entity <span style={{ color: "#c4b5fd", fontWeight: 600 }}>Trust / estate</span>
                        </div>
                      )}
                      {extra.ownerOccupied === true && (
                        <div style={{ fontSize: 11, color: "#86efac", fontWeight: 600 }}>✓ Owner-occupied</div>
                      )}
                      {extra.ownerIsAgent && (
                        <div style={{ fontSize: 11, color: "#fca5a5", fontWeight: 600, gridColumn: "1 / -1" }}>⚠️ Owner is a licensed agent</div>
                      )}
                    </div>
                    {extra.ownerMailing && (extra.ownerMailing.street || extra.ownerMailing.city) && (
                      <div style={{ ...cellStyle, marginTop: 2 }}>
                        Mailing <span style={valStyle}>{[extra.ownerMailing.street, extra.ownerMailing.city, extra.ownerMailing.state, extra.ownerMailing.zip].filter(Boolean).join(", ")}</span>
                      </div>
                    )}
                    {investorFlag && (
                      <div style={{
                        padding: "6px 10px", borderRadius: 6,
                        background: "rgba(196,181,253,0.08)", border: "1px solid rgba(196,181,253,0.3)",
                        fontSize: 11, color: "#c4b5fd", fontWeight: 600,
                      }}>
                        🏠 {outOfState ? `Out-of-state investor (${mailState})` : `Owner lives in ${extra.ownerMailing?.city}`}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── FINANCIAL INTEL ── */}
              {hasFinancial && (
                <div>
                  <RowLabel>Financial Intel</RowLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px" }}>
                    {listPrice > 0 && (
                      <div style={cellStyle}>List <span style={{ color: "#fcd34d", fontWeight: 600 }}>{fmtMoney(listPrice)}</span></div>
                    )}
                    {assessed > 0 && (
                      <div style={cellStyle}>AVM <span style={valStyle}>{fmtMoney(assessed)}</span></div>
                    )}
                    {lastSale > 0 && (
                      <div style={cellStyle}>Last sale <span style={valStyle}>{fmtMoney(lastSale)}</span></div>
                    )}
                    {equityPct != null && (
                      <div style={cellStyle}>
                        Equity <span style={{ color: equityPct >= 50 ? "#86efac" : equityPct >= 20 ? "#fcd34d" : "#fca5a5", fontWeight: 700 }}>
                          {equityPct >= 0 ? "+" : ""}{equityPct}%
                        </span>
                      </div>
                    )}
                    {extra.yearPurchased && (
                      <div style={cellStyle}>Purchased <span style={valStyle}>{extra.yearPurchased}</span></div>
                    )}
                  </div>
                </div>
              )}

              {/* ── PROPERTY / MLS INTEL ── */}
              {hasProperty && (
                <div>
                  <RowLabel>Property / MLS</RowLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px" }}>
                    {extra.mlsNumber && (
                      <div style={cellStyle}>MLS <span style={valStyle}>#{extra.mlsNumber}</span></div>
                    )}
                    {extra.mlsStatus && (
                      <div style={cellStyle}>Status <span style={{ color: "#fca5a5", fontWeight: 600 }}>{extra.mlsStatus}</span></div>
                    )}
                    {extra.statusDate && (
                      <div style={cellStyle}>
                        {String(extra.mlsStatus || "").toLowerCase().includes("withdraw") ? "Removed" :
                         String(extra.mlsStatus || "").toLowerCase().includes("cancel") ? "Cancelled" : "Expired"}{" "}
                        <span style={{ color: "#fca5a5", fontWeight: 600 }}>{fmtDate(extra.statusDate)}</span>
                      </div>
                    )}
                    {extra.daysOnMarket != null && (
                      <div style={cellStyle}>DOM <span style={valStyle}>{extra.daysOnMarket} days</span></div>
                    )}
                    {extra.beds != null && extra.baths != null && (
                      <div style={cellStyle}>
                        <span style={valStyle}>{extra.beds}bd / {extra.baths}ba{extra.sqft ? ` · ${extra.sqft.toLocaleString()} sf` : ""}</span>
                      </div>
                    )}
                    {extra.yearBuilt && (
                      <div style={cellStyle}>Built <span style={valStyle}>{extra.yearBuilt}</span></div>
                    )}
                    {extra.listAgent && (
                      <div style={{ ...cellStyle, gridColumn: "1 / -1" }}>
                        Prev agent <span style={valStyle}>{extra.listAgent}</span>
                        {extra.listOffice && <span style={{ color: "rgba(255,255,255,0.55)" }}> · {extra.listOffice}</span>}
                      </div>
                    )}
                    {extra.relisted && (
                      <div style={{ fontSize: 11, color: "#fcd34d", gridColumn: "1 / -1", fontWeight: 600 }}>⚠️ Previously relisted — check for competing listings</div>
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
              )}

              {/* ── SOURCE PROVENANCE STRIP ── */}
              {hasSource && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                  paddingTop: 8, borderTop: "1px solid rgba(147,197,253,0.15)",
                }}>
                  {sourceLabel && (
                    <span style={{
                      padding: "3px 8px", borderRadius: 4,
                      fontSize: 9, letterSpacing: "0.16em", fontWeight: 700,
                      background: "rgba(147,197,253,0.08)",
                      border: `1px solid ${sourceLabel.color}44`,
                      color: sourceLabel.color,
                    }}>{sourceLabel.text}</span>
                  )}
                  {mergeReview && !mergeReview.resolved && (
                    <span style={{
                      padding: "3px 8px", borderRadius: 4,
                      fontSize: 9, letterSpacing: "0.16em", fontWeight: 700,
                      background: "rgba(252,165,165,0.10)",
                      border: "1px solid rgba(252,165,165,0.4)",
                      color: "#fca5a5",
                    }}>⚠ MERGE REVIEW</span>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* v19.5 — Zillow Intel (public scrape, 24h cache). Renders inline if scrape succeeds.
            Silently omitted when Zillow blocks or the address doesn't resolve. */}
        {lead.address && <ZillowIntelPanel address={lead.address} city={lead.city} state={lead.state} zip={lead.zip} />}
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
          {scriptFilled || "No script saved for this lead type."}
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
              { key: "sell_only",     label: "Sell",           bg: "rgba(200,170,90,0.20)",  fg: "#c8aa5a", border: "rgba(200,170,90,0.55)" },
              { key: "buy_only",      label: "Buy",            bg: "rgba(147,197,253,0.22)", fg: "#93c5fd", border: "rgba(59,130,246,0.60)" },
              { key: "rent_only",     label: "Rent",           bg: "rgba(74,222,128,0.22)",  fg: "#4ade80", border: "rgba(34,197,94,0.60)" },
              { key: "sell_and_buy",  label: "Sell + Buy",     bg: "linear-gradient(90deg, rgba(200,170,90,0.22) 0%, rgba(147,197,253,0.22) 100%)", fg: "#f0f0f0", border: "rgba(200,170,90,0.50)" },
              { key: "sell_and_rent", label: "Sell + Rent",    bg: "linear-gradient(90deg, rgba(200,170,90,0.22) 0%, rgba(74,222,128,0.22) 100%)",  fg: "#f0f0f0", border: "rgba(200,170,90,0.50)" },
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
      {/* v15.11.27 — Buyer Target: editable specs for the FUTURE home the buyer
          wants to acquire. Renders on Buy-only and Sell+Buy cards. Distinct from
          the seller's current home data (extraData). Agent fills these in during
          discovery. Persisted as JSON in lead.buyerTarget. */}
      {showBuyerCard && (() => {
        const btFields: Array<{ key: string; label: string; hint: string; short?: boolean }> = [
          { key: "beds",      label: "Target Beds",   hint: "3",              short: true },
          { key: "baths",     label: "Target Baths",  hint: "2",              short: true },
          { key: "sqft",      label: "Target Sqft",   hint: "1,800–2,400",     short: true },
          { key: "budget",    label: "Budget",        hint: "$450k–$525k",     short: true },
          { key: "garage",    label: "Garage",        hint: "2-car",           short: true },
          { key: "pool",      label: "Pool",          hint: "Yes / No / N/A",  short: true },
          { key: "areas",     label: "Preferred Areas", hint: "Nocatee, Ponte Vedra" },
          { key: "mustHaves", label: "Must-Haves",    hint: "1-story, fenced yard, top schools" },
        ];
        const filledCount = btFields.filter(f => (buyerTarget[f.key] ?? "").trim()).length;
        return (
          <div style={{ padding: "0 20px 12px" }}>
            <div style={{
              background: "linear-gradient(180deg, rgba(59,130,246,0.08), rgba(59,130,246,0.02))",
              border: "1px solid rgba(59,130,246,0.28)", borderRadius: 12,
              padding: "12px 14px",
            }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
                <p style={{ margin: 0, fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(147,197,253,0.85)", fontWeight: 600 }}>
                  Buyer Target · Future Home
                </p>
                {filledCount > 0 && (
                  <span style={{ fontSize: 9, letterSpacing: "0.12em", color: "#93c5fd", background: "rgba(59,130,246,0.18)", padding: "2px 8px", borderRadius: 99 }}>
                    {filledCount}/{btFields.length}
                  </span>
                )}
              </div>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: "8px 10px",
              }}>
                {btFields.map(f => (
                  <div key={f.key} style={{ gridColumn: f.short ? "auto" : "1 / -1" }}>
                    <label style={{ display: "block", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(147,197,253,0.75)", fontWeight: 700, marginBottom: 4, opacity: 0.85 }}>
                      {f.label}
                    </label>
                    <input
                      value={buyerTarget[f.key] ?? ""}
                      onChange={e => setBuyerTarget(d => ({ ...d, [f.key]: e.target.value }))}
                      placeholder={f.hint}
                      style={{
                        width: "100%",
                        background: "rgba(255,255,255,0.05)",
                        border: `1px solid ${(buyerTarget[f.key] ?? "").trim() ? "rgba(147,197,253,0.4)" : "rgba(255,255,255,0.10)"}`,
                        padding: "8px 10px", borderRadius: 8,
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

      {/* v17.2 ── Renter LPMA card ── */}
      {showRenterCard && (
        <div style={{ padding: "0 20px 18px" }}>
          <div style={{
            background: "linear-gradient(180deg, rgba(34,197,94,0.08), rgba(34,197,94,0.02))",
            border: "1px solid rgba(34,197,94,0.28)", borderRadius: 12,
            padding: "14px 14px 12px",
          }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
              <p style={{ margin: 0, fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(74,222,128,0.85)", fontWeight: 600 }}>Renter LPMA</p>
              {RENTER_LPMA_FIELDS.some(f => lpmData[f.key]?.trim()) && (
                <span style={{ fontSize: 9, letterSpacing: "0.12em", color: "#4ade80", background: "rgba(34,197,94,0.18)", padding: "2px 8px", borderRadius: 99 }}>
                  FILLED
                </span>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {RENTER_LPMA_FIELDS.map(f => (
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
      {/* v15.11.29 — Hide entirely when an input is focused (iOS keyboard open).
         Fixes the "detach from bottom / floats mid-screen" bug Alex hit while
         typing into a buyer-target field mid-dial. Reappears the moment the
         input blurs. */}
      <div style={{
        position: "fixed", left: 0, right: 0,
        // v14.43 — lift above the bottom nav (h ≈ 62px + safe-area) so Row 3 (Appt Set / KIT / Left VM)
        // is not covered. Prior version had bottom:0 which put Row 3 UNDER the Dashboard/Refer nav bar.
        bottom: "calc(62px + env(safe-area-inset-bottom, 0px))",
        zIndex: 40,
        // v15.11.29 — keyboard-open detach fix
        display: inputFocused ? "none" : undefined,
        visibility: inputFocused ? "hidden" : undefined,
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
        {/* v17.2 — Per-leg outcome filter.
            Warm leads (Network / OH / Door-Knock / Direct-Mail) skip all cold-
            dialer outcomes: no No-Answer, no Wrong-#, no Recycle, no Not-
            Interested, no Left-VM, no Listed, no Disconnected. You already
            talked to them face-to-face or by referral — the only decisions are
            "appt set" or "keep in touch".
            Same rule applies when the ACTIVE INTENT TAB is renter: renters don't
            hit voicemail via the LPMA script (that's a warm interaction).
            Cold leads (Expired dialer) keep the full 9-outcome grid. */}
        {(() => {
          const warmSources = new Set(["network", "open_house", "door_knock", "direct_mail"]);
          const isWarmLead = warmSources.has(lead.leadType);
          const isRenterTab = intent === "rent_only";
          const useWarmGrid = isWarmLead || isRenterTab;
          const visibleOutcomes = useWarmGrid
            ? OUTCOMES.filter(o => o.key === "contacted_appointment" || o.key === "keep_in_touch")
            : OUTCOMES;
          const gridCols = useWarmGrid ? "1fr 1fr" : "1fr 1fr 1fr";
          const gridRows = useWarmGrid ? "1fr" : "repeat(3, 1fr)";
          return (
        <div style={{ maxWidth: 640, margin: "0 auto", display: "grid", gridTemplateColumns: gridCols, gridTemplateRows: gridRows, gap: 5 }}>
          {visibleOutcomes.map(o => {
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
          );
        })()}

        {/* v15.11.43 — Skip escape hatch. Token bucket: 3 skips, +1 every 15 min
            (escalating to 30/60 min at 10/20 skips in rolling 24h). Blocked on
            Owner Confirmed leads (server enforces; UI also grays the button). */}
        {(() => {
          const q: any = skipQuota;
          const available = q?.available ?? q?.remaining ?? 3;
          const cap = q?.cap ?? 3;
          const ownerConfirmed = !!(lead as any).ownerConfirmedAt;
          const outOfSkips = available <= 0;
          const disabled = outOfSkips || ownerConfirmed;
          const regenMins = q?.nextRegenAt
            ? Math.max(1, Math.ceil((new Date(q.nextRegenAt).getTime() - Date.now()) / 60_000))
            : 0;
          const label = ownerConfirmed ? "Skip disabled — Owner Confirmed"
            : outOfSkips ? `Skip empty — next in ${regenMins}m`
            : `Skip lead (${available}/${cap} available)`;
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

      {/* v15.11.43 — Skip confirm sheet with reason dropdown */}
      {pendingSkip && (
        <SkipModal
          onClose={() => setPendingSkip(false)}
          onSubmit={(reason, reasonNote) => skipMutation.mutate({ reason, reasonNote })}
          isPending={skipMutation.isPending}
          available={(skipQuota as any)?.available ?? skipQuota?.remaining ?? 3}
          cap={skipQuota?.cap ?? 3}
          nextRegenAt={(skipQuota as any)?.nextRegenAt ?? null}
          regenMin={(skipQuota as any)?.regenMin ?? 15}
          rolling24h={(skipQuota as any)?.rolling24h ?? 0}
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
export function CallbackLookupModal({ onClose, onPickLead }: { onClose: () => void; onPickLead?: (leadId: number, destTab?: string) => void }) {
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
                  onPickLead && (() => {
                    // v15.11.32 — If the lead is already closed (KIT / Appt /
                    // Not Interested / Listed / Recycled / Wrong#), sending it
                    // to Dial just triggers the CLOSED_STATUSES drop and shows
                    // "Already ‘Keep in Touch’…" toast. Bronson's Medeiros case:
                    // he logged KIT, then couldn't re-open the card via Who-
                    // called-me. Route closed leads to Pipeline instead, where
                    // the card lives.
                    const CLOSED = new Set(["keep_in_touch","contacted_appointment","contacted_not_interested","listed","retired","wrong_number","recycled"]);
                    const isClosed = r.status && CLOSED.has(r.status);
                    const label = isClosed ? "Open in Pipeline →" : "Open in Dial →";
                    return (
                      <button
                        onClick={() => { onPickLead(r.leadId, isClosed ? "pipeline" : "leads"); onClose(); }}
                        style={{
                          marginTop: 10, width: "100%", padding: "9px",
                          background: "linear-gradient(135deg,#c8aa5a,#a8893a)",
                          color: "#0a0700", border: "none", borderRadius: 8,
                          fontSize: 12, fontWeight: 700, letterSpacing: "0.1em",
                          textTransform: "uppercase", cursor: "pointer",
                        }}
                      >{label}</button>
                    );
                  })()
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

// v15.11.29 — End-of-Month Bonus card. Hero card at the top of Dial screen.
// Announces the current cash bonus, ticks a live countdown to the deadline,
// shows who's currently #1 on the leaderboard (auto-pulled). Money-green
// foil + gold shimmer. Auto-hides after the deadline unless we ship a
// "winner" replacement card. Deadline + amount + copy live in one config
// block below so Alex can change them without hunting through JSX.
//
// v15.11.50 — Replaced flat $500 by the TeamPotCard component (tiered pot
// that grows with team Appt Sets). BONUS_CONFIG is retained only for the
// countdown deadline resolver + monthLabel fallback; the money-shimmer keyframes
// are reused by TeamPotCard so we keep the CSS in one place.
const BONUS_CONFIG = {
  amount: 500,
  // Jul 31, 2026 23:59:59 ET → Aug 1, 2026 03:59:59 UTC (EDT = UTC−4)
  deadlineIso: "2026-08-01T03:59:59Z",
  monthLabel: "July",
  headline: "Winner takes all.",
  subhead: "Top of the leaderboard on July 31 · 11:59 PM walks away with $500 cash.",
  cta: "Dial. Rank. Win. →",
};

// Compute end-of-current-month deadline in ET (matches server's team-pot
// month bounds — keep in sync). Returns an ISO string for last-ms of month.
function endOfMonthEtIso(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric" });
  const parts = fmt.formatToParts(now);
  const year = parseInt(parts.find(p => p.type === "year")!.value, 10);
  const monthNum = parseInt(parts.find(p => p.type === "month")!.value, 10);
  const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
  const nextYear = monthNum === 12 ? year + 1 : year;
  const isDst = (m: number) => m >= 3 && m <= 11;
  const offsetHours = isDst(nextMonth) ? 4 : 5;
  const nextUtcMs = Date.UTC(nextYear, nextMonth - 1, 1, offsetHours, 0, 0, 0) - 1;
  return new Date(nextUtcMs).toISOString();
}

export function BonusCard() {
  // v20.4.2 — Champion's Bonus RETIRED. This card now surfaces the SINGLE
  // challenge the agent is closest to completing, with a live progress bar.
  // If no accepted challenge with progress exists, the card hides entirely.
  const { data: feed } = useQuery<any>({
    queryKey: ["/api/challenges"],
    queryFn: () => apiRequest("GET", "/api/challenges").then(r => r.json()),
    refetchInterval: 30000,
  });

  // Flatten daily+weekly, filter to accepted+not-yet-completed+has-threshold,
  // then pick the one closest to completion (highest progress percentage).
  const closest = React.useMemo(() => {
    const all: any[] = [
      ...((feed?.daily as any[]) || []),
      ...((feed?.weekly as any[]) || []),
    ];
    const eligible = all.filter(c => {
      const done = c.completion && (c.completion.status === "complete" || c.completion.status === "approved");
      const pending = c.completion?.status === "pending";
      if (done || pending) return false;
      if (!c.accepted) return false;
      if (!c.threshold || c.threshold <= 0) return false;
      return true;
    });
    if (!eligible.length) return null;
    eligible.sort((a, b) => {
      const pctA = Math.min(1, (a.progress || 0) / a.threshold);
      const pctB = Math.min(1, (b.progress || 0) / b.threshold);
      return pctB - pctA;
    });
    return eligible[0];
  }, [feed]);

  if (!closest) return null;

  const pct = Math.min(100, Math.round(((closest.progress || 0) / closest.threshold) * 100));
  const remaining = Math.max(0, closest.threshold - (closest.progress || 0));
  const cadenceLabel = closest.cadence === "weekly" ? "WEEKLY CHALLENGE" : "DAILY CHALLENGE";
  const tierAccent =
    closest.tier === 3 ? { ring: "rgba(220,120,90,0.65)", tint: "#e77b6a", tag: "GOLD" }
    : closest.tier === 2 ? { ring: "rgba(200,170,90,0.65)", tint: "#c8aa5a", tag: "SILVER" }
    : { ring: "rgba(160,180,200,0.55)", tint: "#a8bccc", tag: "BRONZE" };

  return (
    <>
      <style>{`
        @keyframes bonusShimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes bonusDotPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        @keyframes bonusMoneyGlow {
          0%,100% { filter: drop-shadow(0 0 12px rgba(250,204,21,0.35)) drop-shadow(0 0 32px rgba(250,204,21,0.18)); }
          50%     { filter: drop-shadow(0 0 22px rgba(250,204,21,0.70)) drop-shadow(0 0 56px rgba(250,204,21,0.38)); }
        }
        @keyframes bonusFloat1 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(24px,-16px); } }
        @keyframes bonusFloat2 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-20px,18px); } }
        @keyframes progressPulse { 0%,100% { opacity: 0.85; } 50% { opacity: 1; } }
        .bonus-money-shimmer {
          background-image: linear-gradient(105deg, #fef9c3 0%, #facc15 30%, #fef08a 45%, #fbbf24 50%, #fef08a 55%, #facc15 70%, #a16207 100%);
          background-size: 200% 100%;
          -webkit-background-clip: text; background-clip: text; color: transparent;
          animation: bonusShimmer 3.5s linear infinite, bonusMoneyGlow 2.8s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .bonus-money-shimmer { animation: none; }
          .bonus-blob-1, .bonus-blob-2, .bonus-live-dot { animation: none; }
        }
      `}</style>
      <div
        style={{
          position: "relative",
          margin: "14px 16px 18px",
          borderRadius: 20,
          padding: "20px 20px 18px",
          overflow: "hidden",
          background:
            "radial-gradient(circle at 20% 0%, rgba(74,222,128,0.14), transparent 55%)," +
            "radial-gradient(circle at 85% 100%, rgba(200,170,90,0.18), transparent 55%)," +
            "linear-gradient(155deg, #0f2818 0%, #0a1a10 55%, #0a0908 100%)",
          border: "1px solid rgba(200,170,90,0.45)",
          boxShadow:
            "0 0 0 1px rgba(200,170,90,0.14) inset," +
            "0 20px 60px -20px rgba(74,222,128,0.28)," +
            "0 8px 24px -8px rgba(0,0,0,0.9)",
          color: "#fff",
          cursor: "pointer",
        }}
        onClick={() => { try { (window as any).location.hash = "challenges"; } catch {} }}
        role="button"
        tabIndex={0}
      >
        {/* Ambient blobs */}
        <div className="bonus-blob-1" style={{
          position: "absolute", top: -60, left: -40, width: 220, height: 220,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(74,222,128,0.35), transparent 65%)",
          filter: "blur(30px)", animation: "bonusFloat1 8s ease-in-out infinite",
          pointerEvents: "none", zIndex: 0,
        }} />
        <div className="bonus-blob-2" style={{
          position: "absolute", bottom: -70, right: -50, width: 240, height: 240,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(250,204,21,0.28), transparent 65%)",
          filter: "blur(34px)", animation: "bonusFloat2 9s ease-in-out infinite",
          pointerEvents: "none", zIndex: 0,
        }} />
        {/* Engraved gold lines */}
        <div style={{ position: "absolute", left: 20, right: 20, bottom: 8, height: 1,
          background: "linear-gradient(90deg, transparent, rgba(200,170,90,0.55), transparent)",
          pointerEvents: "none", zIndex: 0,
        }} />
        <div style={{ position: "absolute", left: 20, right: 20, top: 8, height: 1,
          background: "linear-gradient(90deg, transparent, rgba(200,170,90,0.55), transparent)",
          pointerEvents: "none", zIndex: 0,
        }} />

        {/* Header row: LIVE dot + cadence label + tier tag */}
        <div style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, letterSpacing: "0.24em", color: "#4ade80", fontWeight: 700, textTransform: "uppercase" }}>
            <span className="bonus-live-dot" style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: "#4ade80", boxShadow: "0 0 10px #4ade80",
              animation: "bonusDotPulse 1.6s ease-in-out infinite",
            }} />
            {cadenceLabel}
          </div>
          <div style={{
            fontSize: 9, letterSpacing: "0.16em", fontWeight: 700, color: tierAccent.tint,
            padding: "3px 8px", borderRadius: 6,
            border: `1px solid ${tierAccent.ring}`,
            background: "rgba(0,0,0,0.32)",
          }}>{tierAccent.tag} · +{closest.points} PTS</div>
        </div>

        {/* Hero % complete */}
        <div style={{ position: "relative", zIndex: 1, textAlign: "center", margin: "6px 0 4px" }}>
          <span
            className="bonus-money-shimmer"
            style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontWeight: 600, fontSize: 92, letterSpacing: "0.01em",
              lineHeight: 1, display: "inline-block",
            }}
          >{pct}%</span>
        </div>

        {/* Challenge name + detail — v20.4.9 readability pass: larger title,
            higher-contrast detail, tighter line-height. Old 12px @ 0.65 opacity
            was unreadable in bright light against the gold gradient card bg. */}
        <div style={{ position: "relative", zIndex: 1, textAlign: "center", fontFamily: "'Cormorant Garamond', Georgia, serif", fontWeight: 600, fontSize: 24, letterSpacing: "0.01em", margin: "4px 0 6px", color: "#fff" }}>
          {closest.label}
        </div>
        <p style={{ position: "relative", zIndex: 1, textAlign: "center", fontSize: 13.5, color: "rgba(255,255,255,0.88)", margin: "0 0 14px", lineHeight: 1.45, fontWeight: 500, textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}>
          {closest.detail}
        </p>

        {/* Progress bar row */}
        <div style={{
          position: "relative", zIndex: 1,
          background: "rgba(0,0,0,0.38)",
          border: "1px solid rgba(200,170,90,0.3)",
          padding: "12px 14px",
          borderRadius: 12,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <span style={{ fontSize: 9, letterSpacing: "0.20em", color: "rgba(200,170,90,0.8)", textTransform: "uppercase", fontWeight: 700 }}>
              Progress
            </span>
            <span style={{
              fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
              fontSize: 13, color: "#fff", fontWeight: 700, letterSpacing: "0.02em",
            }}>
              {closest.progress || 0} / {closest.threshold}
            </span>
          </div>
          <div style={{ height: 8, borderRadius: 6, background: "rgba(255,255,255,0.06)", overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.4) inset" }}>
            <div style={{
              height: "100%", width: `${pct}%`,
              background: `linear-gradient(90deg, ${tierAccent.tint}, #fde047)`,
              boxShadow: `0 0 12px ${tierAccent.tint}88`,
              transition: "width 500ms cubic-bezier(0.16,1,0.3,1)",
              animation: pct < 100 ? "progressPulse 2.2s ease-in-out infinite" : undefined,
            }}/>
          </div>
        </div>

        {/* CTA */}
        <div style={{ position: "relative", zIndex: 1, textAlign: "center", marginTop: 12, fontSize: 10, letterSpacing: "0.26em", color: "rgba(200,170,90,0.85)", textTransform: "uppercase", fontWeight: 700 }}>
          {remaining > 0 ? `${remaining} to go — finish it →` : "Ready to claim →"}
        </div>
      </div>
    </>
  );
}


// v15.11.50 — TeamPotCard. Replaces the flat July $500 BonusCard with a
// tiered team pot that grows as the group books more Appt Sets across the
// month. Only "contacted_appointment" outcomes fuel the pot (per Alex's
// spec — no dials, no KITs). Server aggregates in /api/team-pot and
// broadcasts a `team_pot_stretch_toggled` event whenever admin flips the
// secret $1000 stretch tier. Card auto-refreshes every 15s and on every
// WebSocket update. Visual DNA = July hero card: deep emerald + midnight
// gradient, drifting green/gold blobs, engraved gold hairlines, Cormorant
// Garamond shimmer for the dollar amount, monospace countdown, live green
// dot. What's new: a tier ladder progress bar (rungs with dollar amounts),
// dual 1st/2nd standings row, "on the line" payout dollar chips (70/30 split),
// and a one-shot gold-confetti burst the moment a new tier unlocks.
export function TeamPotCard() {
  const qc = useQueryClient();
  const { data: pot } = useQuery<any>({
    queryKey: ["/api/team-pot"],
    queryFn: () => apiRequest("GET", "/api/team-pot").then(r => r.json()),
    refetchInterval: 45000, // v19.5 — money pool changes slowly (WS covers real wins)
    staleTime: 5000,
  });

  // Live countdown clock — refreshes every second.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const deadlineMs = React.useMemo(() => new Date(endOfMonthEtIso()).getTime(), []);
  const ms = Math.max(0, deadlineMs - now);
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const expired = ms === 0;
  const countdown = days > 0
    ? `${days}d ${String(hours).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m`
    : `${String(hours).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;

  // Tier-unlock celebration — fire a one-shot gold burst the moment the
  // returned currentTier.tier increases. Remembered in localStorage so a
  // page refresh doesn't retrigger.
  const [celebrating, setCelebrating] = React.useState<null | number>(null);
  React.useEffect(() => {
    if (!pot?.currentTier?.tier) return;
    const key = `ld.teampot.lastTier.${pot.monthLabel || "current"}`;
    const prev = Number(localStorage.getItem(key) || "0");
    if (pot.currentTier.tier > prev) {
      setCelebrating(pot.currentTier.tier);
      localStorage.setItem(key, String(pot.currentTier.tier));
      setTimeout(() => setCelebrating(null), 4200);
    }
  }, [pot?.currentTier?.tier, pot?.monthLabel]);

  // Refetch on WebSocket bumps.
  React.useEffect(() => {
    const wanted = new Set(["team_pot_stretch_toggled", "leaderboard_reset", "activity_event", "leads_updated"]);
    const listener = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data);
        if (wanted.has(msg?.type)) qc.invalidateQueries({ queryKey: ["/api/team-pot"] });
      } catch {}
    };
    try { (window as any).__ldWs?.addEventListener?.("message", listener); } catch {}
    return () => { try { (window as any).__ldWs?.removeEventListener?.("message", listener); } catch {} };
  }, [qc]);

  // v20.4.4 — Reigning Champion hook MUST be called before any early-return
  // to keep hook order stable across renders (React error #310).
  const champ = useCurrentChampion();

  if (expired) return null;
  if (!pot) return null; // wait for first fetch — no flash of empty ladder

  const monthLabel: string = pot.monthLabel || "This Month";
  const teamAppts: number = pot.teamAppts || 0;
  const currentPot: number = pot.currentPot || 0;
  const apptsToNext: number = pot.apptsToNext || 0;
  const nextTierPot: number | null = pot.nextTier?.pot ?? null;
  const nextTierMystery: boolean = !!pot.nextTierMystery;

  // Ladder rungs. Tier 1 is the pre-committed $250 floor at 0 appts — the
  // pot opens the month already funded. Real unlocks are at 10/20/30 team
  // appts. Champion's Bonus arms at the $1000 tier.
  // v16.7 — rescale: floor $250 (0 appts), 10 → $500, 20 → $750, 30 → $1000.
  const rungs: Array<{ tier: number; appts: number; pot: number; label: string; mystery?: boolean }> = [
    { tier: 1, appts: 0,  pot: 250,  label: "$250" },
    { tier: 2, appts: 10, pot: 500,  label: "$500" },
    { tier: 3, appts: 20, pot: 750,  label: "$750" },
    { tier: 4, appts: 30, pot: 1000, label: "$1000" },
  ];
  const maxAppts = rungs[rungs.length - 1].appts;
  const progressPct = Math.min(100, (teamAppts / maxAppts) * 100);
  const first = pot.standings?.first;
  const second = pot.standings?.second;
  const firstInitials = first?.name ? first.name.split(" ").map((s: string) => s[0]).slice(0, 2).join("").toUpperCase() : "—";
  const secondInitials = second?.name ? second.name.split(" ").map((s: string) => s[0]).slice(0, 2).join("").toUpperCase() : "—";

  return (
    <>
      <style>{`
        @keyframes tpConfetti {
          0%   { transform: translate(0,0) rotate(0deg); opacity: 1; }
          100% { transform: translate(var(--dx,0), var(--dy,-140px)) rotate(var(--rot,180deg)); opacity: 0; }
        }
        @keyframes tpProgressShimmer {
          0%   { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes tpMysteryPulse {
          0%, 100% { opacity: 0.75; }
          50%      { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          [style*="tpMysteryPulse"] { animation: none !important; }
        }
        .tp-progress-fill {
          background-image: linear-gradient(
            90deg,
            #86efac 0%, #4ade80 25%, #facc15 60%, #fbbf24 85%, #a16207 100%
          );
          background-size: 200% 100%;
          animation: tpProgressShimmer 6s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .tp-progress-fill { animation: none; }
        }
      `}</style>
      <div
        style={{
          position: "relative",
          margin: "14px 16px 18px",
          borderRadius: 20,
          padding: "20px 20px 18px",
          overflow: "hidden",
          background:
            "radial-gradient(circle at 20% 0%, rgba(74,222,128,0.14), transparent 55%)," +
            "radial-gradient(circle at 85% 100%, rgba(200,170,90,0.18), transparent 55%)," +
            "linear-gradient(155deg, #0f2818 0%, #0a1a10 55%, #0a0908 100%)",
          border: "1px solid rgba(200,170,90,0.45)",
          boxShadow:
            "0 0 0 1px rgba(200,170,90,0.14) inset," +
            "0 20px 60px -20px rgba(74,222,128,0.28)," +
            "0 8px 24px -8px rgba(0,0,0,0.9)",
          color: "#fff",
        }}
        onClick={() => { try { (window as any).location.hash = "leaderboard"; } catch {} }}
        role="button"
        tabIndex={0}
      >
        {/* Ambient drifting blobs */}
        <div className="bonus-blob-1" style={{
          position: "absolute", top: -60, left: -40, width: 220, height: 220,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(74,222,128,0.35), transparent 65%)",
          filter: "blur(30px)",
          animation: "bonusFloat1 8s ease-in-out infinite",
          pointerEvents: "none", zIndex: 0,
        }} />
        <div className="bonus-blob-2" style={{
          position: "absolute", bottom: -70, right: -50, width: 240, height: 240,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(250,204,21,0.28), transparent 65%)",
          filter: "blur(34px)",
          animation: "bonusFloat2 9s ease-in-out infinite",
          pointerEvents: "none", zIndex: 0,
        }} />
        {/* Diagonal shine sweep */}
        <div style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(115deg, transparent 40%, rgba(255,255,255,0.05) 50%, transparent 60%)",
          pointerEvents: "none", zIndex: 0,
        }} />
        {/* Top engraved gold hairline */}
        <div style={{
          position: "absolute", left: 20, right: 20, top: 8, height: 1,
          background: "linear-gradient(90deg, transparent, rgba(200,170,90,0.55), transparent)",
          pointerEvents: "none", zIndex: 0,
        }} />

        {/* Tier-unlock confetti burst */}
        {celebrating && (
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 3 }} aria-hidden>
            {Array.from({ length: 24 }).map((_, i) => {
              const angle = (i / 24) * Math.PI * 2;
              const dist = 90 + Math.random() * 40;
              const dx = Math.cos(angle) * dist;
              const dy = Math.sin(angle) * dist - 20;
              const rot = 180 + Math.random() * 540;
              const size = 4 + Math.random() * 4;
              const colors = ["#facc15", "#fbbf24", "#fef08a", "#c8aa5a", "#4ade80"];
              const color = colors[i % colors.length];
              return (
                <span key={i} style={{
                  position: "absolute", left: "50%", top: "42%",
                  width: size, height: size, borderRadius: 2,
                  background: color,
                  boxShadow: `0 0 6px ${color}`,
                  transform: "translate(-50%,-50%)",
                  animation: "tpConfetti 3.6s cubic-bezier(0.2,0.7,0.3,1) forwards",
                  ["--dx" as any]: `${dx}px`,
                  ["--dy" as any]: `${dy}px`,
                  ["--rot" as any]: `${rot}deg`,
                }} />
              );
            })}
          </div>
        )}

        {/* Kicker + timer */}
        <div style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, letterSpacing: "0.24em", color: "#4ade80", fontWeight: 700, textTransform: "uppercase" }}>
            <span className="bonus-live-dot" style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: "#4ade80", boxShadow: "0 0 10px #4ade80",
              animation: "bonusDotPulse 1.6s ease-in-out infinite",
            }} />
            {monthLabel} Team Pot
          </div>
          <div style={{ fontFamily: "ui-monospace, 'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.10em", color: "rgba(255,255,255,0.55)", fontWeight: 600, textTransform: "uppercase" }}>
            <span style={{ color: "#fde047", fontWeight: 700 }}>{countdown}</span> to win
          </div>
        </div>

        {/* $ Amount — shimmering gold */}
        <div style={{ position: "relative", zIndex: 1, textAlign: "center", margin: "6px 0 2px" }}>
          <span
            className="bonus-money-shimmer"
            style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontWeight: 600,
              fontSize: 92,
              letterSpacing: "0.01em",
              lineHeight: 1,
              display: "inline-block",
            }}
          >${currentPot}</span>
        </div>

        {/* Subhead: appts to next tier */}
        <div style={{
          position: "relative", zIndex: 1,
          textAlign: "center",
          fontFamily: "'Cormorant Garamond', Georgia, serif",
          fontWeight: 500, fontSize: 20, letterSpacing: "0.02em",
          margin: "0 0 2px",
          color: "rgba(255,255,255,0.92)",
        }}>
          {nextTierMystery
            ? <><span style={{ color: "#fde047", fontWeight: 700 }}>{apptsToNext}</span> more appointments unlocks <span style={{ color: "#fde047", fontWeight: 700, letterSpacing: "0.08em" }}>???</span></>
            : nextTierPot !== null
              ? <><span style={{ color: "#fde047", fontWeight: 700 }}>{apptsToNext}</span> more appointments unlocks <span style={{ color: "#fde047", fontWeight: 700 }}>${nextTierPot}</span></>
              : <>You maxed the pot. Push for the win.</>}
        </div>
        <p style={{
          position: "relative", zIndex: 1,
          textAlign: "center", fontSize: 11.5, color: "rgba(255,255,255,0.55)",
          margin: "0 0 14px", lineHeight: 1.5, letterSpacing: "0.02em",
        }}>
          {teamAppts} team appointments booked so far this month · 70/30 split at #1 & #2
        </p>

        {/* Ladder progress bar with rungs */}
        <div style={{ position: "relative", zIndex: 1, margin: "0 4px 16px" }}>
          <div style={{
            position: "relative",
            height: 10, borderRadius: 6,
            background: "rgba(0,0,0,0.42)",
            border: "1px solid rgba(200,170,90,0.28)",
            overflow: "hidden",
          }}>
            <div
              className="tp-progress-fill"
              style={{
                position: "absolute", left: 0, top: 0, bottom: 0,
                width: `${progressPct}%`,
                borderRadius: 6,
                boxShadow: "0 0 12px rgba(74,222,128,0.55)",
                transition: "width 800ms cubic-bezier(0.22,0.61,0.36,1)",
              }}
            />
          </div>
          {/* Rung labels */}
          <div style={{ position: "relative", marginTop: 6, height: 22 }}>
            {rungs.map((r) => {
              const pct = (r.appts / maxAppts) * 100;
              const reached = teamAppts >= r.appts;
              const mystery = !!r.mystery;
              return (
                <div key={r.tier} style={{
                  position: "absolute", left: `${pct}%`, transform: "translateX(-50%)",
                  textAlign: "center",
                  fontSize: 9, letterSpacing: mystery ? "0.14em" : "0.10em", textTransform: "uppercase",
                  color: reached
                    ? "#fde047"
                    : mystery ? "rgba(200,170,90,0.85)" : "rgba(255,255,255,0.4)",
                  fontWeight: 700, whiteSpace: "nowrap",
                  textShadow: reached
                    ? "0 0 8px rgba(250,204,21,0.5)"
                    : mystery ? "0 0 6px rgba(200,170,90,0.35)" : "none",
                  animation: mystery ? "tpMysteryPulse 2.6s ease-in-out infinite" : "none",
                }}>
                  <div style={{
                    width: mystery ? 7 : 5, height: mystery ? 7 : 5, borderRadius: "50%",
                    background: reached
                      ? "#facc15"
                      : mystery ? "transparent" : "rgba(255,255,255,0.25)",
                    border: mystery ? "1px dashed rgba(200,170,90,0.85)" : "none",
                    boxShadow: reached
                      ? "0 0 6px #facc15"
                      : mystery ? "0 0 8px rgba(200,170,90,0.5)" : "none",
                    margin: mystery ? "-10px auto 3px" : "-9px auto 3px",
                  }} />
                  {r.label}
                </div>
              );
            })}
          </div>
        </div>

        {/* v20.4.4 — Reigning Champion hero row (previous month's winner). */}
        {champ.agentId ? (
          <div style={{
            position: "relative", zIndex: 1, marginBottom: 10,
            display: "flex", alignItems: "center", gap: 12,
            background: "linear-gradient(90deg, rgba(200,170,90,0.16), rgba(200,170,90,0.06) 60%, transparent)",
            border: "1px solid rgba(200,170,90,0.45)",
            padding: "10px 12px", borderRadius: 12,
            boxShadow: "0 0 0 1px rgba(200,170,90,0.15), 0 0 18px rgba(200,170,90,0.12)",
          }}>
            <div style={{ flexShrink: 0 }}>
              <ChampionFrame agentId={champ.agentId} size={40}>
                {champ.headshotUrl ? (
                  <img
                    src={champ.headshotUrl}
                    alt={champ.agentName || ""}
                    style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover", border: "1px solid rgba(200,170,90,0.5)" }}
                  />
                ) : (
                  <div style={{
                    width: 40, height: 40, borderRadius: "50%",
                    background: "linear-gradient(135deg,#fef9c3,#facc15)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#080808", fontWeight: 800, fontSize: 14,
                  }}>{champ.agentName ? champ.agentName.split(" ").map(s => s[0]).slice(0,2).join("").toUpperCase() : "—"}</div>
                )}
              </ChampionFrame>
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 8.5, letterSpacing: "0.18em", color: "rgba(200,170,90,0.95)", textTransform: "uppercase", fontWeight: 800 }}>
                Reigning Champion
              </div>
              <div style={{ fontSize: 14, color: "#fff", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {champ.agentName}
              </div>
              <div style={{
                fontSize: 10, color: "rgba(200,170,90,0.85)", fontWeight: 700,
                fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
                letterSpacing: "0.02em", marginTop: 1,
              }}>
                {champ.points} pts · {champ.awardedForMonth}
              </div>
            </div>
          </div>
        ) : null}

        {/* Standings row: 1st + 2nd side by side */}
        <div style={{ position: "relative", zIndex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {[
            { rank: 1, data: first, payout: first?.payout ?? 0, ring: "linear-gradient(135deg,#fef9c3,#facc15)", chipBg: "rgba(250,204,21,0.14)", chipBorder: "rgba(250,204,21,0.45)", chipText: "#fde047", initials: firstInitials },
            { rank: 2, data: second, payout: second?.payout ?? 0, ring: "linear-gradient(135deg,#e5e7eb,#9ca3af)", chipBg: "rgba(200,200,200,0.10)", chipBorder: "rgba(200,200,200,0.35)", chipText: "#d1d5db", initials: secondInitials },
          ].map(row => (
            <div key={row.rank} style={{
              display: "flex", alignItems: "center", gap: 10,
              background: "rgba(0,0,0,0.42)",
              border: "1px solid rgba(200,170,90,0.28)",
              padding: "10px 10px", borderRadius: 12,
              minWidth: 0,
            }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <ChampionFrame agentId={row.data?.agentId ?? null} size={32}>
                {row.data?.headshotUrl ? (
                  <img src={row.data.headshotUrl} alt={row.data.name}
                    style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", border: "1px solid rgba(200,170,90,0.5)" }} />
                ) : (
                  <div style={{
                    width: 32, height: 32, borderRadius: "50%",
                    background: row.ring,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#080808", fontWeight: 800, fontSize: 12,
                  }}>{row.initials}</div>
                )}
                </ChampionFrame>
                <div style={{
                  position: "absolute", top: -6, right: -6,
                  width: 16, height: 16, borderRadius: "50%",
                  background: row.ring,
                  color: "#080808", fontSize: 9, fontWeight: 800,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.55)",
                }}>{row.rank}</div>
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 8.5, letterSpacing: "0.16em", color: "rgba(200,170,90,0.8)", textTransform: "uppercase", fontWeight: 700 }}>
                  {row.rank === 1 ? "1st · 70%" : "2nd · 30%"}
                </div>
                <div style={{ fontSize: 12, color: "#fff", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.data?.name || (row.rank === 1 ? "Up for grabs" : "—")}</span>
                  {row.data?.agentId ? <StreakBadge agentId={row.data.agentId} size="sm" /> : null}
                </div>
                <div style={{
                  fontSize: 10, color: row.chipText, fontWeight: 700,
                  fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
                  letterSpacing: "0.02em", marginTop: 1,
                }}>
                  {row.data?.appts ?? 0} appts · ${row.payout}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* v20.4.2 — Champion's Bonus panel REMOVED. All bonus recognition now
            flows through the Challenges system (see ActiveChallengeCard). */}

        {/* CTA */}
        <div style={{ position: "relative", zIndex: 1, textAlign: "center", marginTop: 12, fontSize: 10, letterSpacing: "0.26em", color: "rgba(200,170,90,0.85)", textTransform: "uppercase", fontWeight: 700 }}>
          Set the appointment. Take the pot. →
        </div>
      </div>
    </>
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

// v20.7.4 — ActiveChallengesCard: renders the agent's pinned challenges under
// the Home leaderboard. 3 daily + 2 weekly slots. Empty slots are tappable
// call-to-actions that route to the Challenges tab. Progress bars auto-update
// via the challenges_updated broadcast (see routes.ts). Auto-cleared on
// completion — the server drops the accept row when the challenge finishes.
type ActiveSlot = {
  key: string; cadence: "daily" | "weekly"; leg: string; tier: 1|2|3;
  points: number; label: string; detail: string; gated: boolean;
  progress: number; threshold: number | null;
};
type ActiveChallengesResponse = {
  dailyKey: string; weeklyKey: string;
  dailySlots:  { max: number; filled: ActiveSlot[] };
  weeklySlots: { max: number; filled: ActiveSlot[] };
};

function ActiveChallengesCard() {
  const { data } = useQuery<ActiveChallengesResponse>({
    queryKey: ["/api/challenges/active"],
    queryFn: () => apiRequest("GET", "/api/challenges/active").then(r => r.json()),
    refetchInterval: 30_000,
  });

  const goToChallenges = () => {
    try { (window as any).location.hash = "challenges"; } catch {}
  };

  const renderSlot = (slot: ActiveSlot | null, cadence: "daily" | "weekly", idx: number) => {
    if (!slot) {
      // Empty slot — tap to activate
      return (
        <button
          key={`empty-${cadence}-${idx}`}
          onClick={goToChallenges}
          style={{
            width: "100%", padding: 14, textAlign: "left",
            background: "rgba(255,255,255,0.02)",
            border: "1px dashed rgba(200,170,90,0.25)",
            borderRadius: 12, color: "rgba(200,170,90,0.70)",
            fontSize: 13, fontWeight: 600, letterSpacing: "0.04em",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
          <span style={{ fontSize: 15 }}>+</span>
          <span>Tap to activate a challenge</span>
        </button>
      );
    }
    const tier = TIER_STYLES[slot.tier];
    const pct = slot.threshold ? Math.min(100, Math.round((slot.progress / slot.threshold) * 100)) : 0;
    return (
      <button
        key={slot.key}
        onClick={goToChallenges}
        style={{
          width: "100%", padding: 14, textAlign: "left",
          background: tier.bg,
          border: `1px solid ${tier.border}`,
          borderRadius: 12, cursor: "pointer", display: "block",
        }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.14em", color: tier.chipText, textShadow: "0 1px 3px rgba(0,0,0,0.85)" }}>
            {tier.label} · {slot.leg.replace("_", " ").toUpperCase()}
          </span>
          <span style={{
            fontSize: 11, fontWeight: 800, color: "#ffffff",
            background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.15)",
            padding: "2px 8px", borderRadius: 999,
            textShadow: "0 1px 2px rgba(0,0,0,0.6)",
          }}>+{slot.points} pts</span>
        </div>
        <p style={{ fontSize: 14.5, fontWeight: 700, color: "#ffffff", marginBottom: 8, lineHeight: 1.3, textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>
          {slot.label}
        </p>
        {slot.threshold != null && (
          <div>
            <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,0.10)", overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.35) inset" }}>
              <div style={{
                height: "100%", width: `${pct}%`,
                background: tier.ring, transition: "width 400ms ease",
                boxShadow: `0 0 6px ${tier.ring}55`,
              }}/>
            </div>
            <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.85)", marginTop: 4, letterSpacing: "0.04em", fontWeight: 700, textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}>
              {slot.progress} / {slot.threshold} · {pct}%
            </p>
          </div>
        )}
      </button>
    );
  };

  const dailySlots: (ActiveSlot | null)[] = [];
  for (let i = 0; i < 3; i++) dailySlots.push(data?.dailySlots.filled[i] ?? null);
  const weeklySlots: (ActiveSlot | null)[] = [];
  for (let i = 0; i < 2; i++) weeklySlots.push(data?.weeklySlots.filled[i] ?? null);

  return (
    <div style={{ padding: "20px 20px 8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <p style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 22, fontWeight: 500, color: "#fff", lineHeight: 1 }}>
          Active Challenges
        </p>
        <button onClick={goToChallenges} style={{
          background: "transparent", border: "none", color: "#c8aa5a",
          fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", textTransform: "uppercase",
        }}>View all →</button>
      </div>
      <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)", letterSpacing: "0.06em", marginBottom: 12, textTransform: "uppercase" }}>
        Today · {dailySlots.filter(s => s).length} of 3 active
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {dailySlots.map((s, i) => renderSlot(s, "daily", i))}
      </div>
      <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)", letterSpacing: "0.06em", marginBottom: 12, textTransform: "uppercase" }}>
        This Week · {weeklySlots.filter(s => s).length} of 2 active
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {weeklySlots.map((s, i) => renderSlot(s, "weekly", i))}
      </div>
    </div>
  );
}

// v19.5 — HomeShell wraps LeaderboardTab with a small "Board ↔ Team Map"
// segmented toggle at the very top. Team Map is a zero-PII recruiting surface
// (see /api/team-map/pins). Toggle state is local to the tab so it resets on
// leave/return, which is fine — board is the default landing.
// v20.7.4 — ActiveChallengesCard renders below the leaderboard on board view.
function HomeShell({ mode = "seller" }: { mode?: "seller" } = {}) {
  const [view, setView] = useState<"board" | "map">("board");
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <div style={{ display: "inline-flex", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 999, padding: 3 }}>
          {([
            { k: "board", l: "Leaderboard" },
            { k: "map",   l: "Team Map"   },
          ] as const).map(o => {
            const active = view === o.k;
            return (
              <button key={o.k} onClick={() => setView(o.k)} style={{
                padding: "6px 16px",
                borderRadius: 999,
                border: "none",
                background: active ? "rgba(200,170,90,0.14)" : "transparent",
                color: active ? "#c8aa5a" : "rgba(255,255,255,0.45)",
                fontSize: 12,
                letterSpacing: "0.05em",
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.15s",
              }}>{o.l}</button>
            );
          })}
        </div>
      </div>
      {view === "board" ? (
        <>
          <LeaderboardTab mode={mode} />
          <ActiveChallengesCard />
        </>
      ) : <TeamMap />}
    </div>
  );
}


// v20.4.4 — SwipableLeaderboardStrip removed (replaced by per-row sticky+swipe metric rail).


function LeaderboardTab({ mode = "seller" }: { mode?: "seller" } = {}) {
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

  // v18.0 — Recruiting removed. Only seller leaderboard remains.
  void mode;
  const leaderboardUrl = "/api/agent/leaderboard";
  const { data: statsRaw, isLoading } = useQuery<any[]>({
    queryKey: [leaderboardUrl],
    queryFn: () => apiRequest("GET", leaderboardUrl).then(r => r.json()),
    refetchInterval: 60000,
  });
  const stats: AgentStat[] = React.useMemo(() => {
    if (!Array.isArray(statsRaw)) return [];
    return statsRaw as AgentStat[];
  }, [statsRaw]);

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

  // v16.7 — Leaderboard window tab. Server now returns per-agent .windows.today
  // / .weekly / .monthly / .allTime blocks; each block has {points, appts, dials,
  // kit, refs}. Falls back to legacy cycle stats if the server hasn't shipped
  // yet (older cached client).
  const [lbWindow, setLbWindow] = useState<"today" | "weekly" | "monthly" | "allTime">("weekly");
  const pickWin = (s: any) => {
    // v20.4.4 — server returns per-window blocks at the top level of each agent
    // row: { today, weekly, monthly, allTime } each shaped like
    // { dials, appts, kit, emails, noAnswer, convRate, referrals, oh, dm, dk, social }.
    // We also splice in the top-level `points` (agent_points cycle total) so the
    // sticky PTS column shows for every window (server sends a single points value).
    const raw = s?.[lbWindow];
    if (raw) {
      return {
        points:   s?.points || 0,
        appts:    raw.appts || 0,
        dials:    raw.dials || 0,
        kit:      raw.kit || 0,
        refs:     raw.referrals || 0,
        oh:       raw.oh || 0,
        dm:       raw.dm || 0,
        dk:       raw.dk || 0,
        social:   raw.social || 0,
        emails:   raw.emails || 0,
        noAnswer: raw.noAnswer || 0,
        convRate: raw.convRate || 0,
      };
    }
    // Legacy fallback (very old server payloads).
    return {
      points: s?.points || 0,
      appts:  s?.appointmentsSet || 0,
      dials:  s?.totalAttempts || 0,
      kit:    s?.outcomes?.keep_in_touch || 0,
      refs:   s?.refs || 0,
      oh: 0, dm: 0, dk: 0, social: 0, emails: 0, noAnswer: 0, convRate: 0,
    };
  };

  // v15.11.24 — UNIFIED SORT: Points → Dials → Appts. Matches admin leaderboard exactly.
  // Points are what determine #1 (they already weight appts heaviest and layer in tier
  // multipliers); dials break ties on raw effort; appts as final tiebreaker.
  // v16.7 — sort by the currently selected window.
  const ranked  = stats ? [...stats].sort((a, b) => {
    const wa = pickWin(a), wb = pickWin(b);
    return ((wb.points || 0) - (wa.points || 0)) ||
           ((wb.dials  || 0) - (wa.dials  || 0)) ||
           ((wb.appts  || 0) - (wa.appts  || 0));
  }) : [];

  // v15.11.24 — Gap-to-next-rank helper. Points-first, so show "X more points to catch [Name]".
  const myRankIdx = ranked.findIndex(s => s.agent.id === user?.id);
  const rankAbove = myRankIdx > 0 ? ranked[myRankIdx - 1] : null;
  const pointsGap = rankAbove ? Math.max(0, (rankAbove.points || 0) - (myStats?.points || 0)) : 0;
  const apptsGap  = rankAbove && pointsGap === 0 ? Math.max(0, rankAbove.appointmentsSet - (myStats?.appointmentsSet ?? 0)) : 0;

  // v20.4.6 — SYNC-SCROLL rails. All per-row swipe rails scroll together like
  // frozen-column spreadsheet rows. We keep a Set of live rail nodes and a
  // ref-based syncing lock to prevent scrollLeft assignments from triggering
  // their own onScroll (which would feedback-loop across peers).
  const railsRef = useRef<Set<HTMLDivElement>>(new Set());
  const syncingRef = useRef(false);
  const sharedScrollRef = useRef(0);
  const railBindings = useRef(new WeakMap<HTMLDivElement, boolean>());
  const registerRail = React.useCallback((el: HTMLDivElement | null) => {
    if (!el) return; // React 18 callback refs get null on unmount; ok to let GC clean stale entries via natural DOM detach in the WeakMap. We still garbage-collect stale nodes below.
    if (!railBindings.current.has(el)) {
      railBindings.current.set(el, true);
      railsRef.current.add(el);
    }
    // Bring newly-mounted rails into sync with the current shared position.
    if (Math.abs(el.scrollLeft - sharedScrollRef.current) > 1) {
      syncingRef.current = true;
      el.scrollLeft = sharedScrollRef.current;
      requestAnimationFrame(() => { syncingRef.current = false; });
    }
  }, []);
  // Purge detached nodes from the peers set on each scroll to avoid stale refs.
  const purgeStale = React.useCallback(() => {
    for (const el of railsRef.current) {
      if (!el.isConnected) railsRef.current.delete(el);
    }
  }, []);
  const handleRailScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (syncingRef.current) return;
    const src = e.currentTarget;
    const next = src.scrollLeft;
    sharedScrollRef.current = next;
    syncingRef.current = true;
    purgeStale();
    for (const el of railsRef.current) {
      if (el !== src && Math.abs(el.scrollLeft - next) > 0.5) {
        el.scrollLeft = next;
      }
    }
    // Release the lock next frame so the induced-scroll events (which fire
    // async) get swallowed but user-driven scrolls resume normally.
    requestAnimationFrame(() => { syncingRef.current = false; });
  }, [purgeStale]);

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

      {/* v18.3 — Removed in-page "Who called me?" bar; dedicated global button lives
          in the top bar on every tab. Modal stays wired here for that button. */}
      {lookupOpen && <CallbackLookupModal onClose={() => setLookupOpen(false)} />}

      {/* v15.11.29 — End-of-Month Bonus card (seller depot only). Hero card at the
          top: cash amount, live countdown to deadline, current leader row.
          Auto-hides after the deadline. */}
      {mode === "seller" && <TeamPotCard />}

      {/* v15.3 — Optimal call-time meter (seller depot only). Hot/Warm/Cool/Cold
          receptivity weighted from MIT/InsideSales, CallHippo, PhoneBurner, Cognism. */}
      {mode === "seller" && <CallHeatMeter />}

      {/* ── Personal stats — v15.11.31: Emails column removed. Alex: we do not
           track / reward / display emails, cold sends, or voicemails anymore. */}
      {myStats && (
        <>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr", gap: 8, marginBottom: apptsGap > 0 || pointsGap > 0 ? 10 : 28 }}>
          {[
            { label: "Appts Set",   value: myStats.appointmentsSet,                             hero: true },
            { label: "Points",      value: myStats.points ?? 0,                                   hero: false },
            { label: "Total Calls", value: myStats.totalAttempts,                                 hero: false },
            { label: "KIT",         value: (myStats.outcomes?.keep_in_touch) ?? 0,                hero: false },
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
        {/* v20.4.4 — hide scrollbar on the per-row swipe rail (WebKit + Firefox). */}
        <style>{`
          .lb-swipe-rail::-webkit-scrollbar { display: none; }
          .lb-swipe-rail { scrollbar-width: none; }
        `}</style>
        <p style={{
          fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase",
          color: "rgba(200,170,90,0.6)", marginBottom: 10, fontWeight: 600,
        }}>
          Team Leaderboard
        </p>

        {/* v16.7 — window tabs (Today / Week / Month / All). Matches admin leaderboard tabs. */}
        <div style={{ display: "flex", gap: 0, marginBottom: 12, borderRadius: 8, overflow: "hidden", border: "1px solid rgba(200,170,90,0.2)", width: "fit-content" }}>
          {(["today", "weekly", "monthly", "allTime"] as const).map(t => (
            <button
              key={t}
              onClick={() => setLbWindow(t)}
              style={{
                padding: "5px 12px",
                fontSize: 10, fontWeight: 600, letterSpacing: "0.08em",
                textTransform: "uppercase",
                background: lbWindow === t ? "rgba(200,170,90,0.15)" : "transparent",
                color: lbWindow === t ? "#c8aa5a" : "rgba(255,255,255,0.4)",
                border: "none", cursor: "pointer",
                borderBottom: lbWindow === t ? "2px solid #c8aa5a" : "2px solid transparent",
                transition: "all 0.15s",
              }}
            >
              {t === "today" ? "Today" : t === "weekly" ? "Week" : t === "monthly" ? "Month" : "All"}
            </button>
          ))}
        </div>

        {/* v20.4.4 — SwipableLeaderboardStrip removed. Row-level horizontal swipe
            on the metric columns takes over (sticky PTS/APPT/KIT/REFS + swipe rail
            for DIALS/OH/DM/DK/FB/IG). See per-row rendering below. */}

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
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "12px 12px",
                  background: isMe
                    ? "linear-gradient(135deg, rgba(200,170,90,0.1) 0%, rgba(200,170,90,0.04) 100%)"
                    : "rgba(255,255,255,0.03)",
                  border: `1px solid ${isMe ? "rgba(200,170,90,0.35)" : "rgba(255,255,255,0.08)"}`,
                  borderRadius: 10,
                  boxShadow: isMe ? "0 2px 12px rgba(200,170,90,0.08)" : "none",
                  overflow: "hidden", // v20.4.4 — contain the sticky+swipe metric block
                }}>
                  <span style={{ minWidth: 26, textAlign: "center", display: "flex", justifyContent: "center", alignItems: "center", flexShrink: 0 }}>
                    {trophyRank !== null ? (
                      <RankTrophy
                        rank={trophyRank}
                        size={trophyRank === 1 ? 28 : trophyRank === 2 ? 26 : 22}
                      />
                    ) : (
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>#{i+1}</span>
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
                  {/* v20.4.9 — STICKY (PTS · APPT only) + SWIPE RAIL (KIT · REFS · DIALS · OH · DM · DK · FB/IG).
                       Per Alex: only PTS and APPT stay pinned; everything else slides.
                       Swipe rail flexes to fill remaining space so it can scroll all the way to the last column
                       without snap-back or cutoff. */}
                  {(() => {
                    const w = pickWin(s);
                    const stickyCell = (val: number, label: string, big: boolean, color: string) => (
                      <div style={{ textAlign: "right", minWidth: big ? 42 : 32, flexShrink: 0 }}>
                        <p style={big
                          ? { fontSize: 20, fontWeight: 700, color, lineHeight: 1, fontFamily: "'Cormorant Garamond','Georgia',serif", background: "rgba(200,170,90,0.12)", borderRadius: 8, padding: "2px 6px", display: "inline-block" }
                          : { fontSize: 16, fontWeight: 700, color, lineHeight: 1, fontFamily: "'Cormorant Garamond','Georgia',serif" }
                        }>{val}</p>
                        <p style={{ fontSize: 9, color: color === "#c8aa5a" ? "rgba(200,170,90,0.7)" : "rgba(255,255,255,0.4)", letterSpacing: "0.14em", marginTop: 4, fontWeight: 700 }}>{label}</p>
                      </div>
                    );
                    const swipeCell = (val: number, label: string, color: string) => (
                      <div style={{ textAlign: "right", minWidth: 32, flexShrink: 0 }}>
                        <p style={{ fontSize: 15, fontWeight: 600, color, lineHeight: 1 }}>{val}</p>
                        <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 4 }}>{label}</p>
                      </div>
                    );
                    return (
                      <div style={{ display: "flex", alignItems: "center", flex: "1 1 auto", minWidth: 0, position: "relative" }}>
                        {/* STICKY LEFT: PTS · APPT only */}
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0, paddingRight: 8, borderRight: "1px solid rgba(255,255,255,0.08)" }}>
                          {stickyCell(w.points ?? 0, "PTS", true, "#c8aa5a")}
                          {stickyCell(w.appts ?? 0, "APPT", false, "#c8aa5a")}
                        </div>
                        {/* SWIPE RAIL: KIT · REFS · DIALS · OH · DM · DK · FB/IG (horizontal scroll on phone).
                            v20.4.9 — flex:1 min-width:0 lets the rail take remaining width so scroll can
                            reach the last column. All rails sync-scroll together via registerRail. */}
                        <div
                          className="lb-swipe-rail"
                          ref={registerRail}
                          onScroll={handleRailScroll}
                          style={{
                            display: "flex", gap: 8, alignItems: "center",
                            overflowX: "auto", overflowY: "hidden",
                            paddingLeft: 8, paddingRight: 4,
                            flex: "1 1 0", minWidth: 0,
                            scrollSnapType: "x proximity",
                            WebkitOverflowScrolling: "touch",
                            scrollbarWidth: "none",
                          }}
                          onWheel={(e) => {
                            // Convert vertical wheel to horizontal for desktop testing.
                            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                              e.currentTarget.scrollLeft += e.deltaY;
                            }
                          }}
                        >
                          {swipeCell(w.kit ?? 0, "KIT", "rgba(249,168,212,0.85)")}
                          {swipeCell(w.refs ?? 0, "REFS", "#fde68a")}
                          {swipeCell(w.dials ?? 0, "DIALS", "rgba(255,255,255,0.7)")}
                          {swipeCell(w.oh ?? 0, "OH", "rgba(134,239,172,0.85)")}
                          {swipeCell(w.dm ?? 0, "DM", "rgba(147,197,253,0.85)")}
                          {swipeCell(w.dk ?? 0, "DK", "rgba(253,186,116,0.85)")}
                          {swipeCell(w.social ?? 0, "FB/IG", "rgba(216,180,254,0.85)")}
                        </div>
                      </div>
                    );
                  })()}
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

// v19.5 — ZillowIntelPanel: lazy-loads /api/zillow/intel when a lead detail
// opens. Renders nothing until we have data. If Zillow blocks or the address
// doesn't resolve, silently omit. 24h server-side cache keeps this cheap.
function ZillowIntelPanel({ address, city, state, zip }: { address: string; city?: string | null; state?: string | null; zip?: string | null }) {
  const [state_, setState] = useState<any>(null);
  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ address, city: city || "", state: state || "", zip: zip || "" });
    fetch(`/api/zillow/intel?${qs}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled) setState(j); })
      .catch(() => { if (!cancelled) setState(null); });
    return () => { cancelled = true; };
  }, [address, city, state, zip]);

  if (!state_ || !state_.hit) return null;

  return (
    <div style={{
      marginTop: 12, padding: "12px 14px",
      background: "rgba(147,197,253,0.05)",
      border: "1px solid rgba(147,197,253,0.18)",
      borderRadius: 8,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase",
        color: "rgba(147,197,253,0.7)", fontWeight: 700, marginBottom: 8,
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
      }}>
        <span>Zillow Intel</span>
        {state_.zillowUrl && (
          <a href={state_.zillowUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 9, color: "#7db3ff", textDecoration: "none", letterSpacing: "0.12em" }}>
            OPEN ↗
          </a>
        )}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        {state_.photoUrl && (
          <img src={state_.photoUrl} alt="Property"
            style={{ width: 88, height: 66, objectFit: "cover", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }} />
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px", flex: 1, alignItems: "center" }}>
          {state_.price && (
            <div style={{ fontSize: 13, color: "#c8aa5a", fontWeight: 700, gridColumn: "1 / -1" }}>{state_.price}</div>
          )}
          {state_.beds && (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>{state_.beds} bd</div>
          )}
          {state_.baths && (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>{state_.baths} ba</div>
          )}
          {state_.sqft && (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", gridColumn: "1 / -1" }}>{state_.sqft} sqft</div>
          )}
        </div>
      </div>
      {state_.cached && (
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginTop: 8, letterSpacing: "0.08em" }}>
          cached · {new Date(state_.fetchedAt).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}

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
  // v15.11.35 — Pipeline persistence hardening. Alex rule: "Pipeline should
  // never be deleted or forgotten. Must save boot to boot, agents will quit
  // if their pipeline is affected." Server-side the pipeline IS persistent
  // (see /app/data/data.db on Railway volume; no boot code touches
  // keep_in_touch or contacted_appointment statuses). The failure mode we
  // guard against here is CLIENT-side: a mid-deploy Railway restart or
  // stale-cookie retry can 5xx once and leave the agent staring at
  // "Failed to load pipeline. Pull down to refresh." — which reads to the
  // agent as "my pipeline was wiped." Three defenses:
  //   1. Throw on non-OK responses so react-query actually retries.
  //   2. Retry up to 4 times with exponential backoff before showing error.
  //   3. Cache the last successful snapshot in localStorage and hydrate from
  //      it while the network fetch is in flight or has just failed. Agents
  //      see their real pipeline instantly on every open, even offline.
  const cacheKey = agentId ? `ld_pipeline_v1_${agentId}` : null;
  const cachedInitial = React.useMemo(() => {
    if (!cacheKey || typeof window === "undefined") return undefined;
    try {
      const raw = window.localStorage.getItem(cacheKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.counts && Array.isArray(parsed.appts)) return parsed;
    } catch {}
    return undefined;
  }, [cacheKey]);

  const { data, isLoading, isError } = useQuery<any>({
    queryKey: ["/api/leads/my-pipeline", agentId],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/leads/my-pipeline?agentId=${agentId}`);
      if (!r.ok) throw new Error(`pipeline fetch failed: HTTP ${r.status}`);
      const j = await r.json();
      if (!j || !j.counts) throw new Error("pipeline response missing counts");
      // Persist last-good snapshot for boot-to-boot durability on the client.
      if (cacheKey) {
        try { window.localStorage.setItem(cacheKey, JSON.stringify(j)); } catch {}
      }
      return j;
    },
    enabled: !!agentId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 4,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
    initialData: cachedInitial,
  });
  // v14.80 — Agent Pipeline redesign: tiles now filter the list below instead of
  // just displaying counts. "all" (default) shows every owned pipeline lead.
  const [pipelineFilter, setPipelineFilter] = useState<"all" | "appts" | "kit" | "network">("all");
  // v19.5 — Pipeline view toggle: List (default, phone-friendly) or Kanban (6 stages).
  const [pipelineView, setPipelineView] = useState<"list" | "kanban">(() => {
    try { return (window.localStorage.getItem("ld_pipeline_view_v1") as any) || "list"; } catch { return "list"; }
  });
  useEffect(() => { try { window.localStorage.setItem("ld_pipeline_view_v1", pipelineView); } catch {} }, [pipelineView]);
  const counts = data?.counts || { appts: 0, kit: 0, network: 0, total: 0 };
  const kanban = data?.kanban || { lead: [], contacted: [], nurture: [], hot: [], apptSet: [], clientActive: [] };
  const kanbanCounts = data?.kanbanCounts || { lead: 0, contacted: 0, nurture: 0, hot: 0, apptSet: 0, clientActive: 0 };
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

      {/* v19.5 — List / Kanban toggle */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, padding: 3, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,170,90,0.15)", borderRadius: 8, width: "fit-content" }}>
        {([{ k: "list", label: "LIST" }, { k: "kanban", label: "KANBAN" }] as const).map(o => (
          <button key={o.k} data-testid={`pipeline-view-${o.k}`} onClick={() => setPipelineView(o.k as any)}
            style={{
              padding: "7px 14px", borderRadius: 6, border: "none", cursor: "pointer",
              background: pipelineView === o.k ? "rgba(200,170,90,0.15)" : "transparent",
              color: pipelineView === o.k ? "#c8aa5a" : "rgba(255,255,255,0.55)",
              fontSize: 11, fontWeight: 700, letterSpacing: "0.12em",
              transition: "all 0.15s",
            }}>{o.label}</button>
        ))}
      </div>

      {pipelineView === "kanban" && (
        <KanbanBoard
          isLoading={isLoading}
          isError={isError}
          kanban={kanban}
          kanbanCounts={kanbanCounts}
          onOpenLead={onOpenLead}
        />
      )}

      {pipelineView === "list" && <>
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
      </>}
    </div>
  );
}

// v19.5 — KanbanBoard: 6-column horizontally-scrollable board.
// Columns: Lead / Contacted / Nurture / Hot / Appt Set / Client Active.
interface KanbanBoardProps {
  isLoading: boolean;
  isError: boolean;
  kanban: { lead: any[]; contacted: any[]; nurture: any[]; hot: any[]; apptSet: any[]; clientActive: any[] };
  kanbanCounts: { lead: number; contacted: number; nurture: number; hot: number; apptSet: number; clientActive: number };
  onOpenLead?: (leadId: number) => void;
}
function KanbanBoard({ isLoading, isError, kanban, kanbanCounts, onOpenLead }: KanbanBoardProps) {
  if (isLoading) return <div style={{ padding: 40, textAlign: "center", color: "rgba(255,255,255,0.5)", fontSize: 13 }}>Loading your pipeline…</div>;
  if (isError) return <div style={{ padding: 40, textAlign: "center", color: "rgb(252,165,165)", fontSize: 13 }}>Failed to load pipeline. Pull down to refresh.</div>;

  const COLUMNS: Array<{ key: keyof KanbanBoardProps["kanban"]; label: string; color: string; bg: string }> = [
    { key: "lead",         label: "LEAD",          color: "#8a8a8a", bg: "rgba(255,255,255,0.04)" },
    { key: "contacted",    label: "CONTACTED",     color: "#7db3ff", bg: "rgba(125,179,255,0.06)" },
    { key: "nurture",      label: "NURTURE",       color: "#c8aa5a", bg: "rgba(200,170,90,0.06)" },
    { key: "hot",          label: "HOT",           color: "#f97316", bg: "rgba(249,115,22,0.06)" },
    { key: "apptSet",      label: "APPT SET",      color: "#10b981", bg: "rgba(16,185,129,0.08)" },
    { key: "clientActive", label: "CLIENT ACTIVE", color: "#8b7cff", bg: "rgba(139,124,255,0.08)" },
  ];

  return (
    <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 20, marginLeft: -18, marginRight: -18, paddingLeft: 18, paddingRight: 18, WebkitOverflowScrolling: "touch" }}>
      {COLUMNS.map(col => {
        const rows = kanban[col.key] as any[];
        const count = (kanbanCounts as any)[col.key] || 0;
        return (
          <div key={col.key} style={{ flex: "0 0 260px", background: col.bg, border: `1px solid ${col.color}22`, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 8, minHeight: 240 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px", marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: col.color }}>{col.label}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: col.color, background: `${col.color}18`, borderRadius: 999, padding: "2px 8px" }}>{count}</span>
            </div>
            {rows.length === 0 && (
              <div style={{ padding: "18px 6px", textAlign: "center", fontSize: 11, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>Empty</div>
            )}
            {rows.map(l => (
              <button key={l.id} onClick={() => onOpenLead?.(l.id)} data-testid={`kanban-card-${l.id}`}
                style={{
                  textAlign: "left", background: "rgba(0,0,0,0.35)", border: `1px solid ${col.color}22`, borderRadius: 8,
                  padding: "10px 10px", cursor: "pointer", transition: "all 0.15s", color: "#fff",
                }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", marginBottom: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {l.ownerName || `${l.firstName || ""} ${l.lastName || ""}`.trim() || "—"}
                </div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {l.address || l.city || "—"}
                </div>
                {(l.appt_date || l.intention) && (
                  <div style={{ fontSize: 10, color: col.color, marginTop: 6, letterSpacing: "0.03em" }}>
                    {l.appt_date ? `📅 ${l.appt_date}${l.appt_time ? ` · ${l.appt_time}` : ""}` : l.intention}
                  </div>
                )}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── Challenges Tab (v18.3) ─────────────────────────────────────────────────
// Replaces the old Leaderboard bottom-nav slot. Home tab keeps the leaderboard
// content; this tab is 100% challenges (daily / weekly toggle). Accept-to-notify
// on non-gated, Claim-with-evidence sheet on gated.
type ChallengeState = {
  key: string; cadence: "daily" | "weekly"; leg: string; tier: 1|2|3;
  points: number; label: string; detail: string; gated: boolean;
  accepted: boolean; progress: number; threshold: number | null;
  completion: { status: string; pointsAwarded: number; completedAt: string; approvedAt?: string; rejectedReason?: string } | null;
  evidencePrompt?: string;
};
type ChallengeFeed = { dailyKey: string; weeklyKey: string; daily: ChallengeState[]; weekly: ChallengeState[] };

// v20.4.6 — readability pass. Deeper card bg tint (0.10–0.12 vs old 0.05),
// stronger borders (0.35–0.45 vs old 0.20–0.30), and "chipText" is a high
// contrast color for the tier label + points readout so they stop dissolving
// into the card background. Actual tier ring color kept for progress bar +
// side accent so the visual identity of Bronze/Silver/Gold still reads.
const TIER_STYLES: Record<1|2|3, { bg: string; border: string; ring: string; chipText: string; label: string }> = {
  1: { bg: "rgba(160,180,200,0.10)", border: "rgba(160,180,200,0.45)", ring: "rgba(190,210,230,0.90)", chipText: "#d5e2ee", label: "BRONZE" },
  2: { bg: "rgba(200,170,90,0.11)",  border: "rgba(200,170,90,0.50)",  ring: "rgba(240,210,130,0.95)", chipText: "#f0d282", label: "SILVER" },
  3: { bg: "rgba(220,120,90,0.13)",  border: "rgba(220,120,90,0.55)",  ring: "rgba(255,160,120,0.95)", chipText: "#ffb090", label: "GOLD"   },
};

// ─── v20.4.9 INVENTORY TAB ────────────────────────────────────────────────────
// Sellers + Buyers subtabs. Fed by GET /api/inventory/sellers and /api/inventory/buyers.
// Any agent can view. Match hints ("X buyers match this listing") badge on cards.

type SellerRow = {
  id: number; address: string; city?: string | null; state?: string | null; zip?: string | null;
  list_price?: number | null; status: string; listing_agent?: string | null;
  list_date?: string | null; days_on_market?: number | null;
  beds?: number | null; baths?: number | null; sqft?: number | null;
  notes?: string | null; source?: string | null;
};

type BuyerRow = {
  id: number; name: string; phone?: string | null; email?: string | null; buyers_agent?: string | null;
  price_min?: number | null; price_max?: number | null; preferred_areas?: string | null;
  beds_min?: number | null; baths_min?: number | null; sqft_min?: number | null;
  must_haves?: string | null; no_gos?: string | null; timeline?: string | null;
  pre_approved?: number; lender?: string | null; status: string;
};

function fmtPrice(n?: number | null): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(n%1_000_000===0?0:1)}M`;
  if (n >= 1000) return `$${Math.round(n/1000)}K`;
  return `$${n}`;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string,{bg:string;fg:string;label:string}> = {
    active:      { bg: "rgba(200,170,90,0.18)",  fg: "#e5c67a", label: "LIVE"        },
    coming_soon: { bg: "rgba(245,165,36,0.18)",  fg: "#f5a524", label: "COMING SOON" },
    pocket:      { bg: "rgba(20,184,166,0.18)",  fg: "#5eead4", label: "POCKET"      },
    pending:     { bg: "rgba(147,197,253,0.15)", fg: "#93c5fd", label: "PENDING"     },
    sold:        { bg: "rgba(107,142,90,0.15)",  fg: "#a3c48f", label: "SOLD"        },
    closed:      { bg: "rgba(107,142,90,0.15)",  fg: "#a3c48f", label: "CLOSED"      },
  };
  const s = map[status] || { bg: "rgba(255,255,255,0.08)", fg: "#c7d1dd", label: status.toUpperCase() };
  return <span style={{ display:"inline-block", padding:"2px 8px", borderRadius:6, background:s.bg, color:s.fg, fontSize:10, fontWeight:600, letterSpacing:0.5 }}>{s.label}</span>;
}

function SellerCard({ row }: { row: SellerRow }) {
  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:12, padding:14, marginBottom:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:15, fontWeight:600, color:"#e5e7eb", lineHeight:1.3 }}>{row.address}</div>
          <div style={{ fontSize:12, color:"#9ca3af", marginTop:2 }}>
            {[row.city, row.state, row.zip].filter(Boolean).join(", ")}
          </div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <StatusPill status={row.status} />
          {row.list_price != null && <div style={{ fontSize:15, fontWeight:600, color:"#e5c67a", marginTop:4 }}>{fmtPrice(row.list_price)}</div>}
        </div>
      </div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:12, marginTop:10, fontSize:12, color:"#c7d1dd" }}>
        {row.beds != null && <span>{row.beds} bd</span>}
        {row.baths != null && <span>{row.baths} ba</span>}
        {row.sqft != null && <span>{row.sqft.toLocaleString()} sqft</span>}
        {row.listing_agent && <span>· {row.listing_agent}</span>}
        {row.days_on_market != null && <span>· {row.days_on_market}d</span>}
      </div>
      {row.notes && <div style={{ fontSize:12, color:"#94a3b8", marginTop:8, fontStyle:"italic" }}>{row.notes}</div>}
    </div>
  );
}

function BuyerCard({ row }: { row: BuyerRow }) {
  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:12, padding:14, marginBottom:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:15, fontWeight:600, color:"#e5e7eb", lineHeight:1.3 }}>{row.name}</div>
          {row.buyers_agent && <div style={{ fontSize:12, color:"#9ca3af", marginTop:2 }}>Buyer's agent: {row.buyers_agent}</div>}
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          {row.pre_approved ? <span style={{ display:"inline-block", padding:"2px 8px", borderRadius:6, background:"rgba(107,142,90,0.15)", color:"#a3c48f", fontSize:10, fontWeight:600, letterSpacing:0.5 }}>PRE-APPROVED</span> : null}
          {(row.price_min != null || row.price_max != null) && (
            <div style={{ fontSize:14, fontWeight:600, color:"#5eead4", marginTop:4 }}>
              {fmtPrice(row.price_min)}{row.price_min != null && row.price_max != null ? " – " : ""}{fmtPrice(row.price_max)}
            </div>
          )}
        </div>
      </div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:12, marginTop:10, fontSize:12, color:"#c7d1dd" }}>
        {row.beds_min != null && <span>{row.beds_min}+ bd</span>}
        {row.baths_min != null && <span>{row.baths_min}+ ba</span>}
        {row.sqft_min != null && <span>{row.sqft_min.toLocaleString()}+ sqft</span>}
        {row.timeline && <span>· {row.timeline}</span>}
      </div>
      {row.preferred_areas && <div style={{ fontSize:12, color:"#94a3b8", marginTop:6 }}>Areas: {row.preferred_areas}</div>}
      {row.must_haves && <div style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>Must have: {row.must_haves}</div>}
      {row.no_gos && <div style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>No-gos: {row.no_gos}</div>}
      {row.lender && <div style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>Lender: {row.lender}</div>}
      {row.phone && <div style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>{row.phone}</div>}
    </div>
  );
}

function InventoryTab() {
  const [subtab, setSubtab] = useState<"sellers" | "buyers">("sellers");
  const [sellerFilter, setSellerFilter] = useState<"live" | "coming_soon" | "pocket" | "sold">("live");
  const [buyerFilter, setBuyerFilter] = useState<"active" | "closed">("active");

  const sellersQ = useQuery<{ active:SellerRow[]; coming_soon:SellerRow[]; pocket:SellerRow[]; sold:SellerRow[] }>({
    queryKey: ["/api/inventory/sellers"],
    queryFn: () => fetch("/api/inventory/sellers", { credentials: "include" }).then(r => r.json()),
    refetchInterval: 60_000,
  });
  const buyersQ = useQuery<{ active:BuyerRow[]; closed:BuyerRow[] }>({
    queryKey: ["/api/inventory/buyers"],
    queryFn: () => fetch("/api/inventory/buyers", { credentials: "include" }).then(r => r.json()),
    refetchInterval: 60_000,
  });

  const sellerRows = subtab === "sellers" ? (
    sellerFilter === "live"        ? sellersQ.data?.active :
    sellerFilter === "coming_soon" ? sellersQ.data?.coming_soon :
    sellerFilter === "pocket"      ? sellersQ.data?.pocket :
                                     sellersQ.data?.sold
  ) : [];
  const buyerRows = subtab === "buyers" ? (buyerFilter === "active" ? buyersQ.data?.active : buyersQ.data?.closed) : [];

  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600, letterSpacing: 0.3,
    background: active ? "rgba(200,170,90,0.20)" : "rgba(255,255,255,0.04)",
    color:      active ? "#e5c67a"              : "#94a3b8",
    border:     active ? "1px solid rgba(200,170,90,0.45)" : "1px solid rgba(255,255,255,0.08)",
    cursor: "pointer",
  });

  return (
    <div style={{ padding: "12px 16px 100px" }}>
      <div style={{ display:"flex", gap:8, marginBottom:14 }}>
        <button onClick={() => setSubtab("sellers")} style={chipStyle(subtab === "sellers")}>🏠 Sellers</button>
        <button onClick={() => setSubtab("buyers")}  style={chipStyle(subtab === "buyers")}>👥 Buyers</button>
      </div>

      {subtab === "sellers" ? (
        <>
          <div style={{ display:"flex", gap:6, marginBottom:12, overflowX:"auto", paddingBottom:2 }}>
            <button onClick={() => setSellerFilter("live")}        style={chipStyle(sellerFilter==="live")}>Live ({sellersQ.data?.active?.length ?? 0})</button>
            <button onClick={() => setSellerFilter("coming_soon")} style={chipStyle(sellerFilter==="coming_soon")}>Coming Soon ({sellersQ.data?.coming_soon?.length ?? 0})</button>
            <button onClick={() => setSellerFilter("pocket")}      style={chipStyle(sellerFilter==="pocket")}>Pocket ({sellersQ.data?.pocket?.length ?? 0})</button>
            <button onClick={() => setSellerFilter("sold")}        style={chipStyle(sellerFilter==="sold")}>Sold ({sellersQ.data?.sold?.length ?? 0})</button>
          </div>
          {sellersQ.isLoading ? <Skeleton className="h-40 w-full" /> :
           sellerRows && sellerRows.length ? sellerRows.map(r => <SellerCard key={r.id} row={r} />) :
           <div style={{ padding:24, textAlign:"center", color:"#6b7280", fontSize:13 }}>No listings in this bucket yet.</div>}
        </>
      ) : (
        <>
          <div style={{ display:"flex", gap:6, marginBottom:12 }}>
            <button onClick={() => setBuyerFilter("active")} style={chipStyle(buyerFilter==="active")}>On the Hunt ({buyersQ.data?.active?.length ?? 0})</button>
            <button onClick={() => setBuyerFilter("closed")} style={chipStyle(buyerFilter==="closed")}>Closed this year ({buyersQ.data?.closed?.length ?? 0})</button>
          </div>
          {buyersQ.isLoading ? <Skeleton className="h-40 w-full" /> :
           buyerRows && buyerRows.length ? buyerRows.map(r => <BuyerCard key={r.id} row={r} />) :
           <div style={{ padding:24, textAlign:"center", color:"#6b7280", fontSize:13 }}>No buyers on the hunt yet.</div>}
        </>
      )}
    </div>
  );
}

function ChallengesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const [claimOpen, setClaimOpen] = useState<ChallengeState | null>(null);
  const [unlockOpen, setUnlockOpen] = useState<ChallengeState | null>(null);

  const { data, isLoading } = useQuery<ChallengeFeed>({
    queryKey: ["/api/challenges"],
    queryFn: () => apiRequest("GET", "/api/challenges").then(r => r.json()),
    refetchInterval: 45_000,
  });

  const acceptMut = useMutation({
    mutationFn: async (key: string) => apiRequest("POST", `/api/challenges/${key}/accept`).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/challenges"] }); },
  });

  const claimMut = useMutation({
    mutationFn: async ({ key, notes }: { key: string; notes: string }) =>
      apiRequest("POST", `/api/challenges/${key}/claim`, { notes }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/challenges"] });
      setClaimOpen(null);
      toast({ title: "Submitted for approval", description: "Nate will approve or reject in the admin queue." });
    },
  });

  // Full-screen unlock modal fires ONE-SHOT the first time a completion appears
  // that we haven't shown. Track shown keys in sessionStorage.
  useEffect(() => {
    if (!data) return;
    const shownRaw = sessionStorage.getItem("challenge-unlocks-shown") || "[]";
    const shown = new Set<string>(JSON.parse(shownRaw));
    const all = [...data.daily, ...data.weekly];
    const fresh = all.find(c => c.completion && (c.completion.status === "complete" || c.completion.status === "approved") && !shown.has(c.key));
    if (fresh) {
      setUnlockOpen(fresh);
      shown.add(fresh.key);
      sessionStorage.setItem("challenge-unlocks-shown", JSON.stringify([...shown]));
    }
  }, [data]);

  const list = cadence === "daily" ? data?.daily ?? [] : data?.weekly ?? [];
  const doneCount = list.filter(c => c.completion && (c.completion.status === "complete" || c.completion.status === "approved")).length;
  const pendingCount = list.filter(c => c.completion?.status === "pending").length;

  return (
    <div style={{ width: "100%", padding: "0 0 40px" }}>
      {/* Header */}
      <div style={{ padding: "0 20px 12px" }}>
        <p style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 26, fontWeight: 500, color: "#fff", lineHeight: 1.1 }}>
          Challenges
        </p>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 4, letterSpacing: "0.06em" }}>
          {doneCount} completed · {pendingCount} pending approval · {list.length} total
        </p>
      </div>

      {/* Toggle */}
      <div style={{ display: "flex", gap: 6, padding: "0 20px 16px" }}>
        {(["daily", "weekly"] as const).map(c => (
          <button key={c} onClick={() => setCadence(c)} style={{
            flex: 1, padding: "10px 14px",
            background: cadence === c ? "rgba(200,170,90,0.18)" : "rgba(255,255,255,0.03)",
            border: cadence === c ? "1px solid rgba(200,170,90,0.45)" : "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10, color: cadence === c ? "#c8aa5a" : "rgba(255,255,255,0.55)",
            fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
            cursor: "pointer",
          }}>{c}</button>
        ))}
      </div>

      {isLoading && (
        <div style={{ padding: "0 20px" }}>
          <Skeleton className="h-[100px] w-full rounded-xl mb-3" style={{ background: "rgba(255,255,255,0.03)" }} />
          <Skeleton className="h-[100px] w-full rounded-xl mb-3" style={{ background: "rgba(255,255,255,0.03)" }} />
          <Skeleton className="h-[100px] w-full rounded-xl" style={{ background: "rgba(255,255,255,0.03)" }} />
        </div>
      )}

      {/* Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 20px" }}>
        {list.map(c => {
          const tier = TIER_STYLES[c.tier];
          const done = c.completion && (c.completion.status === "complete" || c.completion.status === "approved");
          const pending = c.completion?.status === "pending";
          const rejected = c.completion?.status === "rejected";
          const pct = c.threshold ? Math.min(100, Math.round((c.progress / c.threshold) * 100)) : (done ? 100 : 0);

          return (
            <div key={c.key} style={{
              position: "relative",
              background: done ? "rgba(79,184,163,0.08)" : tier.bg,
              border: done ? "1px solid rgba(79,184,163,0.45)" : `1px solid ${tier.border}`,
              borderRadius: 12, padding: 14,
            }}>
              {/* Tier chip + points — v20.4.6 legibility: chipText is a high
                  contrast tinted color, points readout uses white to stop it
                  from dissolving into gold/orange card background. */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.16em", color: tier.chipText, textShadow: "0 1px 3px rgba(0,0,0,0.85)" }}>
                  {tier.label} · {c.leg.replace("_", " ").toUpperCase()}
                </span>
                <span style={{
                  fontSize: 13, fontWeight: 800,
                  color: done ? "#4fb8a3" : "#ffffff",
                  background: done ? "rgba(79,184,163,0.15)" : "rgba(0,0,0,0.35)",
                  border: done ? "1px solid rgba(79,184,163,0.35)" : "1px solid rgba(255,255,255,0.15)",
                  padding: "3px 9px", borderRadius: 999,
                  textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                }}>
                  +{c.points} pts
                </span>
              </div>

              {/* Label + detail — v20.4.6 legibility. Bigger label (17px), detail
                  at 0.92 opacity, all with drop shadows so text pops on tinted bg. */}
              <p style={{ fontSize: 17, fontWeight: 700, color: done ? "#4fb8a3" : "#ffffff", marginBottom: 6, lineHeight: 1.3, textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>
                {c.label}{done ? " ✓" : ""}
              </p>
              <p style={{ fontSize: 13.5, color: "rgba(255,255,255,0.92)", lineHeight: 1.45, marginBottom: 12, textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}>
                {c.detail}
              </p>

              {/* Progress bar — v20.4.2 also shows on gated challenges once accepted */}
              {c.threshold != null && (!c.gated || c.accepted) && (
                <div style={{ marginBottom: 10 }}>
                  {/* v20.4.2 — taller bar (5→7), brighter track, readable readout */}
                  <div style={{ height: 7, borderRadius: 4, background: "rgba(255,255,255,0.10)", overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.35) inset" }}>
                    <div style={{
                      height: "100%", width: `${pct}%`,
                      background: done ? "#4fb8a3" : tier.ring,
                      transition: "width 400ms ease",
                      boxShadow: done ? "0 0 8px rgba(79,184,163,0.55)" : `0 0 8px ${tier.ring}55`,
                    }}/>
                  </div>
                  <p style={{ fontSize: 12, color: "rgba(255,255,255,0.90)", marginTop: 6, letterSpacing: "0.04em", fontWeight: 700, textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}>
                    {c.progress} / {c.threshold} · {pct}%
                  </p>
                </div>
              )}

              {/* Actions */}
              {done && (
                <div style={{ fontSize: 11, color: "#4fb8a3", fontWeight: 700, letterSpacing: "0.08em" }}>
                  COMPLETED · +{c.completion?.pointsAwarded ?? c.points} PTS
                </div>
              )}
              {pending && (
                <div style={{ fontSize: 11, color: "#c8aa5a", fontWeight: 700, letterSpacing: "0.08em" }}>
                  PENDING ADMIN APPROVAL
                </div>
              )}
              {rejected && (
                <div style={{ fontSize: 11, color: "#e77070", fontWeight: 700 }}>
                  REJECTED{c.completion?.rejectedReason ? ` — ${c.completion.rejectedReason}` : ""}
                </div>
              )}
              {!done && !pending && !rejected && (
                <div style={{ display: "flex", gap: 8 }}>
                  {c.gated ? (
                    <button onClick={() => setClaimOpen(c)} style={{
                      flex: 1, padding: "9px 12px",
                      background: "rgba(200,170,90,0.15)",
                      border: "1px solid rgba(200,170,90,0.35)",
                      borderRadius: 8, color: "#c8aa5a",
                      fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer",
                    }}>Claim with Evidence</button>
                  ) : (
                    <button
                      disabled={c.accepted || acceptMut.isPending}
                      onClick={() => acceptMut.mutate(c.key)}
                      style={{
                        flex: 1, padding: "9px 12px",
                        background: c.accepted ? "rgba(79,184,163,0.10)" : "rgba(200,170,90,0.15)",
                        border: c.accepted ? "1px solid rgba(79,184,163,0.35)" : "1px solid rgba(200,170,90,0.35)",
                        borderRadius: 8, color: c.accepted ? "#4fb8a3" : "#c8aa5a",
                        fontSize: 12, fontWeight: 700, letterSpacing: "0.06em",
                        cursor: c.accepted ? "default" : "pointer",
                        opacity: c.accepted ? 0.85 : 1,
                      }}>{c.accepted ? "Accepted ✓" : "Accept Challenge"}</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Claim sheet */}
      {claimOpen && (
        <div onClick={() => setClaimOpen(null)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100,
          display: "flex", alignItems: "flex-end", justifyContent: "center",
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "100%", maxWidth: 480, background: "#0a0908",
            borderTop: "1px solid rgba(200,170,90,0.35)", padding: 24, borderRadius: "16px 16px 0 0",
          }}>
            <p style={{ fontSize: 18, fontWeight: 600, color: "#c8aa5a", marginBottom: 6 }}>{claimOpen.label}</p>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginBottom: 14, lineHeight: 1.4 }}>
              {claimOpen.evidencePrompt || "Add a note describing what you did — admin will review."}
            </p>
            <Textarea
              id="claim-notes"
              placeholder="Notes for admin (address, teammate name, count, etc.)"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,170,90,0.20)", color: "#fff", marginBottom: 14 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setClaimOpen(null)} style={{
                flex: 1, padding: "11px 14px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8, color: "rgba(255,255,255,0.65)", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>Cancel</button>
              <button
                disabled={claimMut.isPending}
                onClick={() => {
                  const notes = (document.getElementById("claim-notes") as HTMLTextAreaElement | null)?.value || "";
                  claimMut.mutate({ key: claimOpen.key, notes });
                }}
                style={{
                  flex: 1, padding: "11px 14px",
                  background: "linear-gradient(135deg, #c8aa5a 0%, #a88a44 100%)", border: "none",
                  borderRadius: 8, color: "#0a0908", fontSize: 13, fontWeight: 800, letterSpacing: "0.06em", cursor: "pointer",
                }}>{claimMut.isPending ? "Submitting…" : "Submit for Approval"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Full-screen unlock celebration */}
      {unlockOpen && (
        <div onClick={() => setUnlockOpen(null)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 200,
          display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", padding: 32,
          cursor: "pointer",
        }}>
          <ConfettiCelebration onDone={() => {}} />
          <p style={{ fontSize: 11, color: "#c8aa5a", letterSpacing: "0.28em", fontWeight: 800, marginBottom: 18 }}>
            CHALLENGE UNLOCKED
          </p>
          <p style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 44, fontWeight: 500, color: "#fff", textAlign: "center", lineHeight: 1.05, marginBottom: 14 }}>
            {unlockOpen.label}
          </p>
          <p style={{ fontSize: 15, color: "rgba(255,255,255,0.6)", textAlign: "center", maxWidth: 360, marginBottom: 24, lineHeight: 1.35 }}>
            {unlockOpen.detail}
          </p>
          <div style={{ fontSize: 34, fontWeight: 800, color: "#4fb8a3", letterSpacing: "0.04em", marginBottom: 24 }}>
            +{unlockOpen.completion?.pointsAwarded ?? unlockOpen.points} pts
          </div>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: "0.15em" }}>TAP TO CLOSE</p>
        </div>
      )}
    </div>
  );
}

// v19.6 — Referrals Hub wrapper deleted (was orphaned when nav bar dropped `refer`).
// ReferralTab (agent recruiting /join link) now opens directly from Lead Gen sheet.
// ─── Referrals Hub (DELETED v19.6) ─────────────────────────────────────────
// Consolidates Client Referral (network lead → auto-assigned to referring agent,
// jumps to Work-the-Lead card immediately) and Agent Referral (recruiting).

// ─── Client Referral Form (v14.50) ────────────────────────────────────────
function ClientReferralForm(props: { source?: WarmLeadSource; addressPrefill?: string; onSubmitted?: (leadId: number) => void } = {}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const source: WarmLeadSource = props.source || "network";
  const [netName, setNetName]   = useState("");
  const [netPhone, setNetPhone] = useState("");
  const [netEmail, setNetEmail] = useState("");
  const [netAddr, setNetAddr]   = useState(props.addressPrefill || "");
  const [netNotes, setNetNotes] = useState("");
  const [intent, setIntent]     = useState<WarmLeadIntent | "">("");
  const [dupeStatus, setDupeStatus] = useState<null | { checking: boolean; existing: any | null }>(null);
  const [netSending, setNetSending] = useState(false);

  // Phone dupe check — fires 500ms after user stops typing a 10+ digit phone.
  useEffect(() => {
    const digits = netPhone.replace(/[^0-9]/g, "");
    if (digits.length < 10) { setDupeStatus(null); return; }
    let cancelled = false;
    setDupeStatus({ checking: true, existing: null });
    const timer = setTimeout(async () => {
      try {
        const r = await apiRequest("GET", `/api/leads/lookup-by-phone?phone=${encodeURIComponent(digits)}`);
        if (cancelled) return;
        if (r.ok) {
          const data = await r.json();
          setDupeStatus({ checking: false, existing: data.lead || null });
        } else {
          setDupeStatus({ checking: false, existing: null });
        }
      } catch {
        if (!cancelled) setDupeStatus({ checking: false, existing: null });
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [netPhone]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!netName.trim() || !netPhone.trim()) {
      toast({ title: "Name and phone required", variant: "destructive" }); return;
    }
    if (!netEmail.trim()) {
      toast({ title: "Email required", description: "Warm leads need an email for follow-up.", variant: "destructive" }); return;
    }
    if (!netNotes.trim()) {
      toast({ title: "Notes required", description: "How did you meet? What's their situation?", variant: "destructive" }); return;
    }
    if (!intent) {
      const proceed = window.confirm("No client intent selected — the Work-the-Lead card won't show a script tab. Submit anyway?");
      if (!proceed) return;
    }
    if (dupeStatus?.existing) {
      const owner = dupeStatus.existing.assignedAgentName || "another agent";
      const proceed = window.confirm(`This phone is already in Depot (assigned to ${owner}). Submit anyway?`);
      if (!proceed) return;
    }
    setNetSending(true);
    try {
      const r = await apiRequest("POST", "/api/leads/network", {
        ownerName: netName.trim(), phone: netPhone.trim(),
        email: netEmail.trim(), address: netAddr.trim(),
        notes: netNotes.trim(),
        submittedBy: user?.id, submittedByName: user?.name,
        warmLeadIntent: intent || null,
        warmLeadSource: source,
      });
      const data = await r.json();
      if (r.ok && data.leadId) {
        toast({ title: "Warm lead captured", description: "Opening Work-the-Lead card…" });
        setNetName(""); setNetPhone(""); setNetEmail(""); setNetAddr(""); setNetNotes(""); setIntent("");
        try { sessionStorage.setItem("pending_lead_jump", String(data.leadId)); } catch {}
        window.dispatchEvent(new Event("pending_lead_jump_changed"));
        qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
        if (props.onSubmitted) props.onSubmitted(data.leadId);
      } else {
        toast({ title: "Failed to submit", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to submit", variant: "destructive" });
    } finally {
      setNetSending(false);
    }
  };

  const sourcePill = WARM_LEAD_SOURCE_PILLS[source];

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
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "#c8aa5a", fontWeight: 700, margin: 0 }}>
            Warm Lead Capture
          </p>
          <p style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(200,170,90,0.45)", fontWeight: 500, marginTop: 2 }}>
            You'll be dropped straight into their Work-the-Lead card
          </p>
        </div>
        <span style={{
          fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700,
          color: sourcePill.fg, background: sourcePill.bg, border: `1px solid ${sourcePill.border}`,
          borderRadius: 999, padding: "4px 10px",
        }}>{sourcePill.label}</span>
      </div>
      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 18, lineHeight: 1.55 }}>
        Know someone thinking about selling, buying, or renting? Drop their info here — the lead is auto-assigned to you and opens instantly.
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
        {dupeStatus?.existing && (
          <div style={{
            padding: "8px 12px", borderRadius: 8,
            background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)",
            fontSize: 11, color: "#fca5a5", lineHeight: 1.5,
          }}>
            <strong>Duplicate:</strong> This phone is already in Depot
            {dupeStatus.existing.assignedAgentName ? ` (assigned to ${dupeStatus.existing.assignedAgentName})` : ""}. You can submit anyway.
          </div>
        )}
        {dupeStatus?.checking && (
          <div style={{ fontSize: 10, color: "rgba(200,170,90,0.55)", letterSpacing: "0.08em" }}>Checking Depot for duplicates…</div>
        )}
        <div>
          <label style={labelStyle}>Email *</label>
          <input value={netEmail} onChange={e => setNetEmail(e.target.value)} placeholder="john@email.com" type="email" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Property Address</label>
          <input value={netAddr} onChange={e => setNetAddr(e.target.value)} placeholder="123 Oak St, Fernandina Beach, FL" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Notes *</label>
          <textarea value={netNotes} onChange={e => setNetNotes(e.target.value)} placeholder="How you met + situation + timeline" rows={2}
            style={{ ...inputStyle, resize: "none", lineHeight: 1.5 }} />
        </div>
        <div>
          <label style={labelStyle}>Client Intent</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {WARM_LEAD_INTENTS.map(opt => {
              const active = intent === opt.key;
              return (
                <button key={opt.key} type="button" onClick={() => setIntent(opt.key)} style={{
                  padding: "9px 10px", borderRadius: 8, cursor: "pointer",
                  fontSize: 11, fontWeight: 600, letterSpacing: "0.04em",
                  textAlign: "left",
                  background: active ? opt.bg : "rgba(255,255,255,0.03)",
                  border: `1px solid ${active ? opt.border : "rgba(255,255,255,0.10)"}`,
                  color: active ? opt.fg : "rgba(255,255,255,0.7)",
                }}>
                  {opt.future && <span style={{ opacity: 0.6, fontSize: 9, marginRight: 4 }}>FUTURE</span>}
                  {opt.label}
                </button>
              );
            })}
          </div>
          {intent && (
            <p style={{ fontSize: 10, color: "rgba(200,170,90,0.55)", marginTop: 6, letterSpacing: "0.04em" }}>
              Work-the-Lead will open with the {WARM_LEAD_INTENTS.find(o => o.key === intent)?.script} script tab.
            </p>
          )}
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

// ─── v17.2 Warm-Lead unified capture form constants ──────────────────
// One form handles all 4 lead-producing legs (Network Referral, OH Lead,
// Door-Knock Lead, Direct-Mail Lead). `source` param drives the pill + downstream
// analytics. Intent drives which script tab opens on the Work-the-Lead card:
// LPMAMA (buyer), CPMAMA (seller), LPMA (renter), plus combos.
export type WarmLeadSource = "network" | "open_house" | "door_knock" | "direct_mail";
export type WarmLeadIntent =
  | "buyer" | "seller" | "renter" | "seller_and_buyer" | "seller_and_renter"
  | "future_buyer" | "future_seller" | "future_renter"
  | "future_seller_and_buyer" | "future_seller_and_renter";

export const WARM_LEAD_SOURCE_PILLS: Record<WarmLeadSource, { label: string; bg: string; fg: string; border: string }> = {
  network:     { label: "Network",    bg: "rgba(200,170,90,0.14)", fg: "#c8aa5a", border: "rgba(200,170,90,0.4)" },
  open_house:  { label: "Open House", bg: "rgba(147,197,253,0.14)", fg: "#93c5fd", border: "rgba(59,130,246,0.4)" },
  door_knock:  { label: "Door Knock", bg: "rgba(74,222,128,0.14)",  fg: "#4ade80", border: "rgba(34,197,94,0.4)" },
  direct_mail: { label: "Direct Mail",bg: "rgba(251,146,60,0.14)",  fg: "#fb923c", border: "rgba(249,115,22,0.4)" },
};

export const WARM_LEAD_INTENTS: {
  key: WarmLeadIntent; label: string; script: "LPMAMA" | "CPMAMA" | "LPMA" | "CPMAMA + LPMAMA" | "CPMAMA + LPMA";
  future: boolean; bg: string; fg: string; border: string;
}[] = [
  { key: "buyer",  label: "Buyer",              script: "LPMAMA", future: false, bg: "rgba(147,197,253,0.22)", fg: "#93c5fd", border: "rgba(59,130,246,0.55)" },
  { key: "seller", label: "Seller",             script: "CPMAMA", future: false, bg: "rgba(200,170,90,0.22)",  fg: "#c8aa5a", border: "rgba(200,170,90,0.55)" },
  { key: "renter", label: "Renter",             script: "LPMA",   future: false, bg: "rgba(74,222,128,0.22)",  fg: "#4ade80", border: "rgba(34,197,94,0.55)" },
  { key: "seller_and_buyer",  label: "Seller + Buyer",  script: "CPMAMA + LPMAMA", future: false, bg: "linear-gradient(90deg, rgba(200,170,90,0.22) 0%, rgba(147,197,253,0.22) 100%)", fg: "#f0f0f0", border: "rgba(200,170,90,0.5)" },
  { key: "seller_and_renter", label: "Seller + Renter", script: "CPMAMA + LPMA",   future: false, bg: "linear-gradient(90deg, rgba(200,170,90,0.22) 0%, rgba(74,222,128,0.22) 100%)",  fg: "#f0f0f0", border: "rgba(200,170,90,0.5)" },
  { key: "future_buyer",  label: "Buyer",       script: "LPMAMA", future: true, bg: "rgba(147,197,253,0.10)", fg: "#93c5fd", border: "rgba(59,130,246,0.30)" },
  { key: "future_seller", label: "Seller",      script: "CPMAMA", future: true, bg: "rgba(200,170,90,0.10)",  fg: "#c8aa5a", border: "rgba(200,170,90,0.30)" },
  { key: "future_renter", label: "Renter",      script: "LPMA",   future: true, bg: "rgba(74,222,128,0.10)",  fg: "#4ade80", border: "rgba(34,197,94,0.30)" },
  { key: "future_seller_and_buyer",  label: "Seller + Buyer",  script: "CPMAMA + LPMAMA", future: true, bg: "linear-gradient(90deg, rgba(200,170,90,0.10) 0%, rgba(147,197,253,0.10) 100%)", fg: "#e0e0e0", border: "rgba(200,170,90,0.30)" },
  { key: "future_seller_and_renter", label: "Seller + Renter", script: "CPMAMA + LPMA",   future: true, bg: "linear-gradient(90deg, rgba(200,170,90,0.10) 0%, rgba(74,222,128,0.10) 100%)",  fg: "#e0e0e0", border: "rgba(200,170,90,0.30)" },
];

// ─── Nav tabs ─────────────────────────────────────────────────────────────────
// v17.2 — SYMMETRICAL 4-tab bottom nav (both agents + admins). Middle slot is
// the yellow radial chooser (5 lead-gen legs: Dial / OH / Knock / Direct Mail /
// Network Referral). Tab order: Home / Pipeline / [+] / Leaderboard / Profile.
// "refer" tab retired — folds into the radial chooser's Network Referral leg.
// v18.4 — Leaderboard slot swapped for Challenges. Home tab still renders the
// leaderboard content (that's the dashboard). "leaderboard" id kept in the union
// to gracefully fall through for anyone with a stale initialTab or bookmark.
type Tab = "leads" | "leaderboard" | "challenges" | "pipeline" | "profile" | "home" | "inventory";
// v20.6.8 — Profile removed from bottom nav (moved to header profile circle).
// 5 symmetric slots around the FAB: Home / Pipeline / [Lead Gen] / Inventory / Challenges.
const NAV: { id: Tab; label: string; icon: typeof Phone }[] = [
  { id: "home",       label: "Home",       icon: Home },
  { id: "pipeline",   label: "Pipeline",   icon: Layers },
  { id: "leads",      label: "Lead Gen",   icon: Phone },
  { id: "inventory",  label: "Inventory",  icon: Package },
  { id: "challenges", label: "Challenges", icon: Target },
];

// ─── Main AgentView ───────────────────────────────────────────────────────────
export default function AgentView({ onBackToAdmin, onOpenAdmin, initialTab, mode = "seller" }: { onBackToAdmin?: () => void; onOpenAdmin?: () => void; initialTab?: Tab; mode?: "seller" } = {}) {
  const { user, logout } = useAuth();
  // v17.2 — Both roles land on Home. Prior default was "leaderboard".
  const [tab, setTab] = useState<Tab>(initialTab ?? "home");
  // v16.7 — Lead Gen chooser state. Middle nav button opens the chooser sheet
  // instead of navigating straight to Dial. Chooser has 4 tiles; Dial tile sets
  // tab="leads" and closes chooser. Other tiles open sub-sheets or forms.
  const [leadGenOpen, setLeadGenOpen] = useState(false);
  // v20.6.9 — motivational quote frozen at the moment Lead Gen opens so it
  // doesn't reshuffle mid-render. Refreshed each open. See leadgen-quotes.ts.
  const [leadGenQuote, setLeadGenQuote] = useState<MotivationalQuote | null>(null);
  const [leadGenView, setLeadGenView] = useState<
    "root" | "open-house" | "oh-log" | "oh-lead" | "network-referral"
    | "door-knock" | "door-knock-lead" | "direct-mail" | "direct-mail-lead"
    | "oh-knock-route" | "social" | "refer-agent"
  >("root");
  const { connected: wsConnected } = useRealtimeUpdates();
  const qc = useQueryClient();
  const { toast } = useToast(); // v15.11.17 — used by CLOSED_STATUSES redirect notice

  // v19.5 — Prime Time notifier boot. Idempotent; only fires when permission is granted.
  useEffect(() => { startPrimeNotifier(); }, []);

  // v20.4.9 — Two-stage PermissionGate. Fires on first login and every 90 days.
  // Modal is non-blocking; agent can skip. Uses localStorage timestamp.
  const [permGateOpen, setPermGateOpen] = useState(false);
  useEffect(() => {
    // Delay a tick so we don't slam the modal over the login transition.
    const t = setTimeout(() => {
      if (shouldPromptPermissions()) setPermGateOpen(true);
    }, 1200);
    return () => clearTimeout(t);
  }, []);
  const [primePerm, setPrimePerm] = useState<NotificationPermission>(
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "denied"
  );

  // v15.3 — REAL dialing-now indicator. Replaces v14.9 vibe count that showed
  // "6 dialing now" 24/7 based on active_agents_count + random bump.
  // Source of truth: /api/agents/live-count returns COUNT(DISTINCT agent_id) with
  // a lead_activity insert in the last 10 minutes. Zero means zero — no fudging.
  const { data: liveCountData } = useQuery<{ dialingNow: number; windowMinutes: number; lastActivityAt: string | null }>({
    queryKey: ["/api/agents/live-count"],
    queryFn: () => apiRequest("GET", "/api/agents/live-count").then(r => r.json()),
    refetchInterval: 60000, // v19.5 — presence badge, 60s lag imperceptible
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
  // v18.0 — Recruiting removed. Kept as harmless `false` so downstream branches compile.
  void mode;
  const prospectingMode = false as boolean;
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
    refetchInterval: 30000, // v19.5 — prospecting counter
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
      {/* v20.4.9 — Two-stage PermissionGate modal (first login + 90-day recheck) */}
      {permGateOpen && <PermissionGate onDone={() => setPermGateOpen(false)} />}
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* v20.6.8 — Company name (LEAD DEPOT + user name + version) sticks to
              the FAR LEFT for everyone. Admin pill sits IMMEDIATELY to the right of
              the LEAD DEPOT block (was on the left in prior versions). Non-admins
              simply don't see the admin pill — nothing else moves. */}
          <div>
            <p style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: 15, fontWeight: 500, letterSpacing: "0.2em",
              color: "#fff", textTransform: "uppercase", lineHeight: 1,
            }}>Lead Depot</p>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <span style={{ fontSize: 11, color: "rgba(200,170,90,0.7)", letterSpacing: "0.08em" }}>{user?.name}</span>
              <span style={{ fontSize: 9, color: "rgba(200,170,90,0.55)", letterSpacing: "0.10em", fontWeight: 700 }}>v20.7.4</span>
            </div>
          </div>
          {onBackToAdmin && (
            <button onClick={onBackToAdmin} style={{
              display: "flex", alignItems: "center", gap: 5,
              fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", fontWeight: 700,
              color: "#c8aa5a",
              background: "rgba(200,170,90,0.10)", border: "1px solid rgba(200,170,90,0.30)",
              borderRadius: 8, padding: "6px 9px", cursor: "pointer",
            }}>
              <ChevronLeft size={12} /> Admin
            </button>
          )}
          {isAdmin && onOpenAdmin && !onBackToAdmin && (
            <button
              onClick={onOpenAdmin}
              title="Open admin tools"
              style={{
                display: "flex", alignItems: "center", gap: 5,
                fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", fontWeight: 700,
                color: "#c8aa5a",
                background: "rgba(200,170,90,0.12)",
                border: "1px solid rgba(200,170,90,0.35)",
                borderRadius: 8, padding: "6px 10px", cursor: "pointer",
              }}
            >
              <Shield size={12} /> Admin
            </button>
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
          {/* v20.6.8 — Circular profile button sits immediately LEFT of Sign out.
              Replaces the Profile bottom-nav tab (removed this deploy). Tap opens
              the same Profile page. Renders the user's headshot when available,
              falls back to initials on a gold gradient. */}
          <button
            onClick={() => setTab("profile")}
            title="Profile"
            aria-label="Open profile"
            style={{
              width: 32, height: 32, borderRadius: "50%",
              padding: 0, cursor: "pointer", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              overflow: "hidden",
              background: "linear-gradient(135deg, rgba(200,170,90,0.35), rgba(140,110,50,0.25))",
              border: "1px solid rgba(200,170,90,0.55)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.4), 0 0 0 0.5px rgba(255,220,140,0.25) inset",
              color: "#fff5e0", fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
            }}
          >
            {(user as any)?.headshotUrl ? (
              <img
                src={(user as any).headshotUrl}
                alt={user?.name ?? "Profile"}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <span>{(user?.name ?? "?").trim().split(/\s+/).map(w => w[0] ?? "").join("").slice(0,2).toUpperCase() || "?"}</span>
            )}
          </button>
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

      {/* v18.3 — Removed "Leads Ready — Tap to Work Your Queue" banner.
          Dial button up top + Leads tab in bottom nav make it redundant. */}

      {/* ── Main ── */}
      <main ref={mainRef} style={{ flex: 1, overflowY: "auto", padding: "16px 12px 90px" }}>
        {/* v17.2 — Both roles land on Home first. Home currently reuses the
            LeaderboardTab body (which already includes Prime Time / Team Pot /
            Live On Air / KPIs / challenges). Phase 3d will split them: Home stays
            personal-focused; Leaderboard tab becomes standings-focused with the
            sticky-swipe agent selector. Placeholder for now so the nav renders. */}
        {tab === "home" && (
          <HomeShell mode={mode} />
        )}
        {tab === "leaderboard" && <LeaderboardTab mode={mode} />}
        {tab === "challenges" && <ChallengesTab />}
        {tab === "inventory" && <InventoryTab />}

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
                    {/* v15.11.37 — Coach's Corner. Rotating advice cards sit
                        under the lead card so agents see them mid-dial without
                        blocking the outcome buttons. */}
                    <AdviceCarousel />
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

        {/* v19.6 — refer tab route removed. ReferralTab reachable from Lead Gen sheet. */}

        {/* v14.50 — Global Who called me? modal (rendered from AgentView, works on every tab) */}
        {globalLookupOpen && (
          <CallbackLookupModal
            onClose={() => setGlobalLookupOpen(false)}
            onPickLead={(leadId: number, destTab?: string) => {
              // v15.11.32 — destTab lets closed leads route to Pipeline instead of Dial.
              // Pipeline doesn't consume pending_lead_jump (that key drives Dial),
              // so don't set it when routing to Pipeline — otherwise the next
              // Dial-tab visit will silently try to jump to a closed lead and
              // fire the "already Keep in Touch" toast Bronson just escaped from.
              const isPipeline = destTab === "pipeline";
              if (!isPipeline) {
                try { sessionStorage.setItem("pending_lead_jump", String(leadId)); } catch {}
                setPendingLeadId(leadId);
              } else {
                try { sessionStorage.removeItem("pending_lead_jump"); } catch {}
                setPendingLeadId(null);
              }
              setGlobalLookupOpen(false);
              setTab((destTab as any) || "leads");
            }}
          />
        )}
        {tab === "profile" && <ProfilePage onBack={() => setTab("home")} />}
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
            <button key={n.id} onClick={() => {
              // v16.7 — Middle button opens the Lead Gen chooser instead of
              // going straight to Dial. Dial is one of the tiles inside.
              if (isDial) {
                setLeadGenView("root");
                setLeadGenQuote(pickLeadGenQuote());   // v20.6.9
                setLeadGenOpen(true);
                return;
              }
              setTab(n.id);
            }} style={{
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
                /* v20.6.7 — FAB now wears the arc-hero glass treatment at rest:
                   radial gold gradient + inner rims + specular gloss + soft ambient
                   glow so it already looks like the bubble it's about to unspool.
                   Retains the 60px black safety ring so it stands off the nav bar. */
                <div className={(!active && !leadGenOpen) ? `fab-hero-pulse${fabNudge ? " fab-nudge" : ""}` : undefined} style={{
                  position: "relative",
                  width: 60, height: 60,
                  marginTop: -22,
                  borderRadius: "50%",
                  background: "radial-gradient(circle at 50% 22%, rgba(255,240,180,0.65) 0%, rgba(253,224,71,0.42) 30%, rgba(200,170,90,0.32) 62%, rgba(138,111,42,0.42) 100%)",
                  border: "1px solid rgba(255,220,140,0.75)",
                  backdropFilter: "blur(20px) saturate(180%) brightness(1.06)",
                  WebkitBackdropFilter: "blur(20px) saturate(180%) brightness(1.06)",
                  boxShadow: [
                    "0 12px 36px rgba(200,170,90,0.55)",           // ambient gold glow
                    "0 4px 14px rgba(0,0,0,0.42)",                  // depth
                    "0 0 0 3px rgba(6,6,6,0.98)",                   // safety ring against nav
                    "0 0 0 0.5px rgba(255,255,255,0.35) inset",     // outer rim
                    "0 2px 0 rgba(255,240,190,0.55) inset",         // top rim highlight
                    "0 -8px 18px rgba(80,50,10,0.30) inset",        // bottom inner shadow
                    "0 12px 22px rgba(255,220,120,0.18) inset",     // interior warm bloom
                  ].join(", "),
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "transform 0.36s cubic-bezier(0.16, 1, 0.3, 1)",
                  transform: leadGenOpen ? "rotate(-135deg)" : "rotate(0deg)",
                }}>
                  {/* Specular gloss on the FAB itself so it reads as liquid, not flat. */}
                  <span aria-hidden="true" style={{
                    position: "absolute",
                    top: 3, left: "14%", right: "14%", height: "38%",
                    borderRadius: "50% / 100% 100% 0 0",
                    background: "linear-gradient(180deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.10) 55%, rgba(255,255,255,0) 100%)",
                    pointerEvents: "none",
                    filter: "blur(0.5px)",
                  }} />
                  <span aria-hidden="true" style={{
                    position: "absolute",
                    top: "14%", left: "32%",
                    width: "14%", height: "9%",
                    borderRadius: "50%",
                    background: "rgba(255,255,255,0.72)",
                    filter: "blur(1.5px)",
                    pointerEvents: "none",
                  }} />
                  <Plus size={32} style={{ color: "#0a0700", strokeWidth: 2.5, position: "relative", zIndex: 1, filter: "drop-shadow(0 1px 2px rgba(255,240,180,0.35))" }} />
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

      {/* v16.7 — Lead Gen chooser sheet. Bottom sheet with 4 tiles. Middle nav
          button opens it. Sub-views for Open House (photo log or full lead
          capture) and Network Referral (existing form). Door Knock stubbed. */}
      {leadGenOpen && (
        <LeadGenSheet
          view={leadGenView}
          setView={setLeadGenView}
          motivationalQuote={leadGenQuote}
          close={() => { setLeadGenOpen(false); setLeadGenView("root"); }}
          goToDial={() => { setLeadGenOpen(false); setLeadGenView("root"); setTab("leads"); }}
          user={user}
          toast={toast}
        />
      )}

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
        /* v20.6.7 — hero-bubble pulse for the collapsed Dial FAB. Same rhythm as
           the arc-hero bubble; slightly lower amplitude because the FAB is smaller
           and always on-screen so a big pulse would be visually loud. */
        @keyframes fabHeroPulse {
          0%,100% { box-shadow: 0 12px 36px rgba(200,170,90,0.55), 0 4px 14px rgba(0,0,0,0.42), 0 0 0 3px rgba(6,6,6,0.98), 0 0 0 0.5px rgba(255,255,255,0.35) inset, 0 2px 0 rgba(255,240,190,0.55) inset, 0 -8px 18px rgba(80,50,10,0.30) inset, 0 12px 22px rgba(255,220,120,0.18) inset; }
          50%     { box-shadow: 0 18px 52px rgba(220,180,90,0.72), 0 4px 14px rgba(0,0,0,0.42), 0 0 0 3px rgba(6,6,6,0.98), 0 0 0 0.5px rgba(255,255,255,0.42) inset, 0 2px 0 rgba(255,240,190,0.65) inset, 0 -8px 18px rgba(80,50,10,0.30) inset, 0 14px 24px rgba(255,220,120,0.28) inset; }
        }
        .fab-hero-pulse { animation: fabHeroPulse 3.2s ease-in-out infinite; }
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

// ─── v16.7 Lead Gen Sheet ────────────────────────────────────────────────────
// Bottom-sheet chooser opened by the enlarged middle nav button. Holds 4 tiles
// (Dial | Open House | Door Knocking | Network Referral). Open House opens a
// sub-chooser with 2 options: Log OH (photo + address, 20 pts, no lead) and
// Log OH Lead (full lead form, 20 pts, creates Depot lead assigned to
// submitter; FUB push waits for KIT/Appt outcome per standing rule).
function LeadGenSheet(props: {
  view: "root" | "open-house" | "oh-log" | "oh-lead" | "network-referral"
    | "oh-knock-route" | "social"
    | "door-knock" | "door-knock-lead" | "direct-mail" | "direct-mail-lead"
    | "refer-agent";
  setView: (v: any) => void;
  close: () => void;
  goToDial: () => void;
  user: any;
  toast: any;
  // v20.6.9 — curated motivational quote to display on the arc backdrop when
  // Lead Gen opens. Powerful, not theatrical: quiet fade-in ~180ms after the
  // backdrop takes over, centered editorial serif type, no bounce/shimmer.
  motivationalQuote?: MotivationalQuote | null;
}) {
  const { view, setView, close, goToDial, user, toast, motivationalQuote } = props;

  // Lock body scroll while sheet is open
  useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => { document.body.classList.remove("ld-modal-open"); };
  }, []);

  const backdrop: React.CSSProperties = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
    backdropFilter: "blur(8px)", zIndex: 60,
    display: "flex", alignItems: "flex-end", justifyContent: "center",
    animation: "leadgenFade 0.18s ease-out",
  };
  const sheet: React.CSSProperties = {
    width: "100%", maxWidth: 560, maxHeight: "92vh", overflow: "auto",
    background: "linear-gradient(180deg,#0d0c0a 0%,#080706 100%)",
    borderTop: "1px solid rgba(200,170,90,0.28)",
    borderRadius: "18px 18px 0 0",
    padding: "18px 20px calc(28px + env(safe-area-inset-bottom, 0px))",
    animation: "leadgenSlide 0.22s cubic-bezier(0.16,1,0.3,1)",
  };
  const header = (title: string, back?: () => void) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {back && (
          <button onClick={back} style={{
            background: "rgba(200,170,90,0.08)", border: "1px solid rgba(200,170,90,0.2)",
            borderRadius: 8, padding: "6px 10px", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 4,
            color: "#c8aa5a", fontSize: 12, fontWeight: 600,
          }}><ArrowLeft size={12} /> Back</button>
        )}
        <div>
          <p style={{ margin: 0, fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "#c8aa5a", fontWeight: 700 }}>Lead Gen</p>
          <h2 style={{ margin: "2px 0 0", fontSize: 20, color: "#fff", fontWeight: 700, fontFamily: "'Cormorant Garamond',serif", letterSpacing: "0.01em" }}>{title}</h2>
        </div>
      </div>
      <button onClick={close} style={{
        background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "50%", width: 32, height: 32, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", color: "#fff",
      }}><X size={16} /></button>
    </div>
  );

  const tile = (opts: {
    icon: React.ReactNode; title: string; sub: string;
    onClick: () => void; hero?: boolean; comingSoon?: boolean;
  }) => (
    <button onClick={opts.onClick} disabled={opts.comingSoon} style={{
      width: "100%", display: "flex", alignItems: "center", gap: 14,
      padding: "16px 16px",
      background: opts.hero
        ? "linear-gradient(135deg, rgba(200,170,90,0.14) 0%, rgba(200,170,90,0.05) 100%)"
        : "rgba(255,255,255,0.02)",
      border: opts.hero
        ? "1px solid rgba(200,170,90,0.4)"
        : "1px solid rgba(255,255,255,0.08)",
      borderRadius: 14,
      cursor: opts.comingSoon ? "not-allowed" : "pointer",
      opacity: opts.comingSoon ? 0.55 : 1,
      textAlign: "left", transition: "all 0.15s ease",
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12,
        background: opts.hero
          ? "linear-gradient(135deg,#c8aa5a 0%,#8a6f2a 100%)"
          : "rgba(200,170,90,0.12)",
        border: opts.hero ? "none" : "1px solid rgba(200,170,90,0.25)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: opts.hero ? "#0a0700" : "#c8aa5a", flexShrink: 0,
      }}>{opts.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 15, color: "#fff", fontWeight: 700 }}>{opts.title}</p>
        <p style={{ margin: "3px 0 0", fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 1.4 }}>{opts.sub}</p>
      </div>
      {opts.comingSoon && (
        <span style={{
          fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase",
          color: "rgba(200,170,90,0.7)", fontWeight: 700,
          padding: "4px 8px", border: "1px solid rgba(200,170,90,0.3)", borderRadius: 6,
        }}>Soon</span>
      )}
    </button>
  );

  // v20.4.2.1 — GOLD LIQUID ARC. Rebuilt from v20.4.2 which shipped with three bugs:
  //   1) Overlap: 7 bubbles across 135° sweep kissed at the shoulders. Fix:
  //      widened radius to 172px + slightly compressed the sweep so bubbles have
  //      real breathing room.
  //   2) Broken animation: --arc-final-transform was set to translate(-50%,-50%)
  //      which is just the CENTERING math. Bubbles faded in place instead of
  //      flying out from the FAB. Fix: keyframe now animates FROM the FAB origin
  //      (0,0 relative to arc anchor) TO the bubble's polar destination.
  //   3) Ripple stagger from center: bubbles pulsed OUT from Dial in both
  //      directions. Fix: sequential LEFT→RIGHT stagger keyed by index, 42ms
  //      apart, cubic-bezier(0.16,1,0.3,1) — fast but rhythmic, like flicking
  //      a rolodex open.
  //   Also: color pass. Regular bubbles now warm gold-tinted glass (matching
  //   the middle Dial hero) so the fan reads as one gold set, not white glass
  //   with one gold odd-one-out. Plus icon rotates counter-clockwise (-135°).
  //
  // Arc geometry (v20.4.3 — no-overlap symmetric fit):
  //   7 bubbles across a 168° sweep, 28° between neighbors.
  //   Center = 90° (straight up). Angles 6°/34°/62°/90°/118°/146°/174° —
  //   perfectly symmetric around 90°.
  //   Radius = 178px, regular bubbles = 68px, hero = 88px.
  //   Chord between neighbors = 2×178×sin(14°) ≈ 86px, so with 68px bubbles
  //   there's ~18px of clean space at every join. No shoulder-kissing anywhere,
  //   including the bottom corners which used to be the worst offenders.
  //
  // v20.7.4 — Split arc: 5 lead-gen bubbles ON the arc (Direct Mail · Open House ·
  // DIAL · Social Post · Door Knock), plus 2 smaller "agent task" bubbles nested
  // BELOW the arc's underside as a centered shelf row (Network Lead · Refer Agent).
  // Alex's ask: Network + Refer aren't first-party prospecting — they're agent
  // tasks. Pull them out of the main arc, shrink them, tuck them under the shelter
  // of the arc. Same fly-out animation for continuity.
  //
  // Arc reading left→right: Direct Mail · Open House · DIAL · Social Post · Door Knock.
  //
  // v20.7.4 — Since the arc now has 5 items instead of 7, we can widen the
  // between-bubble step and slightly LOWER the whole arc anchor point (more
  // vertical breathing room up top). Sweep stays around 160° for a proper fan.
  if (view === "root") {
    // Viewport-adaptive sizing. Arc bubbles same size as before; shelf bubbles
    // 12px smaller (roughly 80% of arc bubble diameter).
    const vw = typeof window !== "undefined" ? window.innerWidth : 393;
    const BUBBLE_SIZE = vw < 360 ? 56 : vw < 400 ? 60 : 64;
    const HERO_SIZE = BUBBLE_SIZE + 22;
    const SHELF_SIZE = Math.round(BUBBLE_SIZE * 0.78); // ~50px on 393px iPhones
    // v20.7.4 — labels are now full words ("Direct Mail", "Open House", "Door Knock",
    // "Social Post", "Network Lead", "Refer Agent"). Widest is "Direct Mail" / "Social Post"
    // at ~72px @ 11px semibold. Bump LABEL_HALF 34 → 42.
    const LABEL_HALF = 42;
    const EDGE_MARGIN = 10;
    const MAX_RADIUS = (vw / 2) - (BUBBLE_SIZE / 2) - LABEL_HALF - EDGE_MARGIN;
    const vh = typeof window !== "undefined" ? window.innerHeight : 780;
    // v20.7.4 — Reserve extra vertical room under the arc for the 2-bubble shelf.
    // Shelf needs ~SHELF_SIZE + label + gap = ~90px. Bump VERTICAL_CAP subtract to 300.
    const VERTICAL_CAP = vh - 300;
    const ARC_RADIUS = Math.max(160, Math.min(260, MAX_RADIUS, VERTICAL_CAP));
    const HERO_LIFT = 20;

    // v20.7.4 — 5 arc bubbles across ~160°. Center = 90° (Dial hero), step = 30°.
    // Angles: 150 / 120 / 90 / 60 / 30. Symmetric around DIAL.
    const bubbles: Array<{
      key: string; label: string; icon: React.ReactNode;
      angleDeg: number; hero?: boolean; onClick: () => void;
    }> = [
      { key: "mail",   label: "Direct Mail", icon: <Mail size={20} />,     angleDeg: 150, onClick: () => setView("direct-mail" as any) },
      { key: "oh",     label: "Open House",  icon: <Home size={20} />,     angleDeg: 120, onClick: () => setView("open-house") },
      { key: "dial",   label: "Dial",        icon: <Phone size={28} />,    angleDeg: 90,  hero: true, onClick: goToDial },
      { key: "social", label: "Social Post", icon: <Share2 size={20} />,   angleDeg: 60,  onClick: () => setView("social" as any) },
      { key: "knock",  label: "Door Knock",  icon: <DoorOpen size={20} />, angleDeg: 30,  onClick: () => setView("door-knock" as any) },
    ];

    // v20.7.4 — Shelf bubbles (Network Lead, Refer Agent) rendered separately
    // below the arc. Not part of the polar-arc math — they sit on a horizontal
    // baseline centered under the FAB, equally-spaced from screen bottom as they
    // are from the arc's underside.
    const shelfBubbles: Array<{
      key: string; label: string; icon: React.ReactNode; onClick: () => void;
    }> = [
      { key: "network", label: "Network Lead", icon: <Users size={18} />, onClick: () => setView("network-referral") },
      { key: "refer",   label: "Refer Agent",  icon: <Send size={18} />,  onClick: () => setView("refer-agent" as any) },
    ];
    // FAB is centered horizontally in the nav; nav sits at bottom + safe-area.
    // Anchor the arc's origin over the FAB center.
    const arcBackdrop: React.CSSProperties = {
      position: "fixed", inset: 0, zIndex: 60,
      background: "radial-gradient(ellipse at 50% 100%, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.88) 60%, rgba(0,0,0,0.94) 100%)",
      backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
      animation: "arcBackdropFade 0.24s ease-out",
    };
    return (
      <div style={arcBackdrop} onClick={close}>
        <style>{`
          @keyframes arcBackdropFade { from { opacity: 0 } to { opacity: 1 } }
          /* v20.6.9 — motivational quote fade-in. Quiet: no translate, no scale,
             no bounce. Just presence. */
          @keyframes leadgenQuoteIn {
            0%   { opacity: 0; transform: translateY(4px); }
            100% { opacity: 1; transform: translateY(0);   }
          }
          /* v20.4.2.1 — bubbles FLY OUT from FAB origin to their polar destination.
             --arc-dx / --arc-dy carry the final polar offset; keyframe drives the
             translate + scale together for a proper spring pop. */
          /* v20.6.7 — bubbles now TWIST and SPIN into place. Starting rotation is
             −220deg (feels like they're unspooling from the FAB); end at 0. Slight
             overshoot in the scale curve keeps the "pop" alive so the spin never
             feels sluggish. */
          @keyframes arcBubbleFly {
            0%   { opacity: 0; transform: translate(-50%, -50%) translate(0px, 0px) rotate(-220deg) scale(0.18); }
            55%  { opacity: 1; }
            80%  { transform: translate(-50%, -50%) translate(calc(var(--arc-dx) * 1.03), calc(var(--arc-dy) * 1.03)) rotate(8deg) scale(1.05); }
            100% { opacity: 1; transform: translate(-50%, -50%) translate(var(--arc-dx), var(--arc-dy)) rotate(0deg) scale(1); }
          }
          @keyframes arcLabelFade {
            0%   { opacity: 0; transform: translateY(-4px); }
            100% { opacity: 1; transform: translateY(0); }
          }
          @keyframes arcHeroPulse {
            0%,100% { box-shadow: 0 14px 44px rgba(200,170,90,0.55), 0 6px 20px rgba(0,0,0,0.40), 0 0 0 0.5px rgba(255,255,255,0.35) inset, 0 2px 0 rgba(255,255,255,0.55) inset, 0 -8px 18px rgba(80,50,10,0.30) inset, 0 12px 24px rgba(255,220,120,0.16) inset; }
            50%     { box-shadow: 0 20px 60px rgba(220,180,90,0.72), 0 6px 20px rgba(0,0,0,0.40), 0 0 0 0.5px rgba(255,255,255,0.42) inset, 0 2px 0 rgba(255,255,255,0.65) inset, 0 -8px 18px rgba(80,50,10,0.30) inset, 0 14px 28px rgba(255,220,120,0.26) inset; }
          }
          .arc-bubble {
            animation: arcBubbleFly 620ms cubic-bezier(0.16,1,0.3,1) both;
          }
          .arc-label {
            animation: arcLabelFade 220ms ease-out both;
          }
          .arc-glass { transition: transform 160ms cubic-bezier(0.16,1,0.3,1); }
          .arc-glass:active { transform: scale(0.92); }
          .arc-glass-hero { animation: arcHeroPulse 2.6s ease-in-out infinite; animation-delay: 800ms; }
        `}</style>

        {/* Arc container anchored to bottom-center where the FAB sits. */}
        <div style={{
          position: "absolute",
          left: "50%",
          // FAB center: bottom of nav (~66px tall) + FAB lift (~-22px from nav top) → ~52-58px above screen bottom, add safe-area.
          bottom: `calc(52px + env(safe-area-inset-bottom, 0px))`,
          width: 0, height: 0,
          pointerEvents: "none",
        }} onClick={e => e.stopPropagation()}>
          {bubbles.map((b, idx) => {
            const rad = (b.angleDeg * Math.PI) / 180;
            const dx = Math.cos(rad) * ARC_RADIUS;
            const dy = -Math.sin(rad) * ARC_RADIUS - (b.hero ? HERO_LIFT : 0);
            const size = b.hero ? HERO_SIZE : BUBBLE_SIZE;
            // v20.4.2.1 — sequential LEFT→RIGHT stagger by index.
            // idx 0 (Social, leftmost) fires first, idx 6 (Refer, rightmost) last.
            // 42ms between each = ~294ms total spread = fast but rhythmic.
            const delay = idx * 42;
            // v20.4.2.1 — GOLD glass on regular bubbles (matches Dial), just a
            // shade cooler + more translucent so Dial still crowns as the hero.
            const glassBase = b.hero
              ? "radial-gradient(circle at 50% 22%, rgba(255,240,180,0.55) 0%, rgba(253,224,71,0.32) 30%, rgba(200,170,90,0.22) 62%, rgba(138,111,42,0.28) 100%)"
              : "radial-gradient(circle at 50% 22%, rgba(255,235,175,0.30) 0%, rgba(230,195,105,0.18) 40%, rgba(190,155,75,0.13) 78%, rgba(140,110,50,0.14) 100%)";
            const glassBorder = b.hero
              ? "1px solid rgba(255,220,140,0.65)"
              : "1px solid rgba(220,185,115,0.42)";
            const glassShadow = b.hero
              ? [
                  "0 16px 48px rgba(200,170,90,0.55)",             // ambient gold glow
                  "0 6px 20px rgba(0,0,0,0.40)",                    // depth shadow
                  "0 0 0 0.5px rgba(255,255,255,0.40) inset",       // outer rim
                  "0 2px 0 rgba(255,240,190,0.60) inset",           // top rim highlight (warmer)
                  "0 -8px 18px rgba(80,50,10,0.35) inset",          // bottom inner shadow
                  "0 14px 26px rgba(255,220,120,0.18) inset",       // interior warm bloom
                ].join(", ")
              : [
                  "0 14px 40px rgba(140,105,45,0.42)",              // warm gold ambient (was black)
                  "0 4px 14px rgba(0,0,0,0.35)",                    // contact shadow
                  "0 0 0 0.5px rgba(255,220,140,0.28) inset",       // outer gold rim
                  "0 2px 0 rgba(255,235,180,0.45) inset",           // top gold rim highlight
                  "0 -8px 18px rgba(60,40,10,0.32) inset",          // bottom warm inner shadow
                ].join(", ");
            return (
              <div
                key={b.key}
                className="arc-bubble"
                style={{
                  position: "absolute",
                  left: "0px",
                  top: "0px",
                  pointerEvents: "auto",
                  animationDelay: `${delay}ms`,
                  // @ts-ignore CSS custom property
                  "--arc-dx": `${dx}px`,
                  // @ts-ignore CSS custom property
                  "--arc-dy": `${dy}px`,
                  display: "flex", flexDirection: "column", alignItems: "center",
                  transformOrigin: "center center",
                } as React.CSSProperties}
              >
                <button
                  onClick={b.onClick}
                  aria-label={b.label}
                  className={b.hero ? "arc-glass arc-glass-hero" : "arc-glass"}
                  style={{
                    position: "relative",
                    width: size, height: size,
                    borderRadius: "50%",
                    border: glassBorder,
                    background: glassBase,
                    backdropFilter: "blur(28px) saturate(200%) brightness(1.06)",
                    WebkitBackdropFilter: "blur(28px) saturate(200%) brightness(1.06)",
                    boxShadow: glassShadow,
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: b.hero ? "#fff5d0" : "#fff",
                    padding: 0,
                    transition: "transform 180ms cubic-bezier(0.16,1,0.3,1)",
                  }}
                >
                  {/* Specular gloss — thin bright crescent hugging the top rim */}
                  <span aria-hidden="true" style={{
                    position: "absolute",
                    top: 3, left: "14%", right: "14%", height: "38%",
                    borderRadius: "50% / 100% 100% 0 0",
                    background: b.hero
                      ? "linear-gradient(180deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.10) 55%, rgba(255,255,255,0) 100%)"
                      : "linear-gradient(180deg, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.08) 55%, rgba(255,255,255,0) 100%)",
                    pointerEvents: "none",
                    filter: "blur(0.5px)",
                  }} />
                  {/* Tiny specular dot — the pinpoint highlight that sells 'liquid' */}
                  <span aria-hidden="true" style={{
                    position: "absolute",
                    top: "14%", left: "32%",
                    width: "14%", height: "9%",
                    borderRadius: "50%",
                    background: "rgba(255,255,255,0.72)",
                    filter: "blur(1.5px)",
                    pointerEvents: "none",
                  }} />
                  <span style={{
                    position: "relative", zIndex: 1,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    filter: b.hero
                      ? "drop-shadow(0 1px 2px rgba(0,0,0,0.5))"
                      : "drop-shadow(0 1px 2px rgba(0,0,0,0.65))",
                  }}>
                    {b.icon}
                  </span>
                </button>
                {/* Label floats BELOW the bubble so the circle stays perfect.
                    v20.4.2.1 — label fades AFTER the bubble arrives at its destination
                    (delay = bubble delay + full bubble flight time). */}
                {/* v20.4.6 — label legibility pass: bigger, mixed case, less letter-spacing,
                    fuller opacity. Nowrap kept but multi-word labels have breathing room. */}
                <span className="arc-label" style={{
                  marginTop: 8,
                  fontSize: b.hero ? 12 : 11,
                  letterSpacing: "0.03em",
                  fontWeight: b.hero ? 700 : 600,
                  color: b.hero ? "#fde68a" : "#fff5e0",
                  /* v20.6.8 — shortened labels (Mail/Network/OH/Dial/Social/Refer/Knock)
                     fit inside a tighter pill. Smaller font, tighter padding. */
                  background: "linear-gradient(180deg, rgba(6,6,6,0.72) 0%, rgba(6,6,6,0.86) 100%)",
                  padding: "2px 7px",
                  borderRadius: 999,
                  textShadow: "0 1px 2px rgba(0,0,0,0.9)",
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  animationDelay: `${delay + 380}ms`,
                }}>{b.label}</span>
              </div>
            );
          })}
        </div>

        {/* v20.7.5 — Shelf row: 2 smaller "agent task" bubbles (Network Lead,
            Refer Agent) tucked under the arc's underside, centered horizontally.

            BUG FIXED (v20.7.5): at bottom=118px the shelf sat almost directly
            under Open House (120°) and Social Post (60°) — the two arc bubbles
            that hang the LOWEST labels of the whole fan (their labels dangled
            to ~height 134-144 from screen bottom). With the shelf's top edge
            at ~141.5, those labels visually collided with the Network Lead /
            Refer Agent bubbles rendered on top of them (shelf div paints after
            the arc div), producing the overlapping/cut-off text seen on device.

            Fix: drop the shelf anchor to 80px. Worst case (smallest ARC_RADIUS
            = 160, on the narrowest supported viewport) this still leaves >28px
            of clear vertical gap between the lowest arc label and the shelf's
            top edge — comfortably non-overlapping on every screen size, since
            larger ARC_RADIUS on bigger phones only increases the gap further. */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            left: 0, right: 0,
            bottom: `calc(80px + env(safe-area-inset-bottom, 0px))`,
            display: "flex",
            justifyContent: "center",
            gap: 28,
            pointerEvents: "none",
          }}
        >
          {shelfBubbles.map((b, idx) => {
            // Reuse the same fly-out animation; delay staggers AFTER the main
            // arc bubbles land so shelf reads as a secondary tier. Main arc
            // finishes ~ (4 * 42ms delay) + 620ms flight = ~790ms. Shelf starts
            // around 220ms in so it feels like part of the same motion.
            const delay = 220 + (idx * 60);
            return (
              <div
                key={b.key}
                className="arc-bubble"
                style={{
                  pointerEvents: "auto",
                  animationDelay: `${delay}ms`,
                  // Shelf bubbles fly UP+OUT from FAB origin. dx = idx-based
                  // offset (-1 for left, +1 for right), dy = negative (rise up).
                  // These CSS vars feed the shared arcBubbleFly keyframe.
                  // @ts-ignore CSS custom property
                  "--arc-dx": `${(idx === 0 ? -1 : 1) * ((SHELF_SIZE / 2) + 14)}px`,
                  // @ts-ignore CSS custom property
                  "--arc-dy": `0px`,
                  display: "flex", flexDirection: "column", alignItems: "center",
                  transformOrigin: "center center",
                } as React.CSSProperties}
              >
                <button
                  onClick={b.onClick}
                  aria-label={b.label}
                  className="arc-glass"
                  style={{
                    position: "relative",
                    width: SHELF_SIZE, height: SHELF_SIZE,
                    borderRadius: "50%",
                    border: "1px solid rgba(220,185,115,0.42)",
                    background: "radial-gradient(circle at 50% 22%, rgba(255,235,175,0.30) 0%, rgba(230,195,105,0.18) 40%, rgba(190,155,75,0.13) 78%, rgba(140,110,50,0.14) 100%)",
                    backdropFilter: "blur(28px) saturate(200%) brightness(1.06)",
                    WebkitBackdropFilter: "blur(28px) saturate(200%) brightness(1.06)",
                    boxShadow: [
                      "0 10px 30px rgba(140,105,45,0.38)",
                      "0 3px 10px rgba(0,0,0,0.32)",
                      "0 0 0 0.5px rgba(255,220,140,0.28) inset",
                      "0 2px 0 rgba(255,235,180,0.42) inset",
                      "0 -6px 14px rgba(60,40,10,0.30) inset",
                    ].join(", "),
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff",
                    padding: 0,
                    transition: "transform 180ms cubic-bezier(0.16,1,0.3,1)",
                  }}
                >
                  <span aria-hidden="true" style={{
                    position: "absolute",
                    top: 3, left: "14%", right: "14%", height: "38%",
                    borderRadius: "50% / 100% 100% 0 0",
                    background: "linear-gradient(180deg, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.08) 55%, rgba(255,255,255,0) 100%)",
                    pointerEvents: "none",
                    filter: "blur(0.5px)",
                  }} />
                  <span aria-hidden="true" style={{
                    position: "absolute",
                    top: "14%", left: "32%",
                    width: "14%", height: "9%",
                    borderRadius: "50%",
                    background: "rgba(255,255,255,0.72)",
                    filter: "blur(1.5px)",
                    pointerEvents: "none",
                  }} />
                  <span style={{
                    position: "relative", zIndex: 1,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.65))",
                  }}>
                    {b.icon}
                  </span>
                </button>
                <span className="arc-label" style={{
                  marginTop: 7,
                  fontSize: 10,
                  letterSpacing: "0.03em",
                  fontWeight: 600,
                  color: "#fff5e0",
                  background: "linear-gradient(180deg, rgba(6,6,6,0.72) 0%, rgba(6,6,6,0.86) 100%)",
                  padding: "2px 7px",
                  borderRadius: 999,
                  textShadow: "0 1px 2px rgba(0,0,0,0.9)",
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  animationDelay: `${delay + 380}ms`,
                }}>{b.label}</span>
              </div>
            );
          })}
        </div>

        {/* "Tap outside to close" hint at the top of the screen. */}
        <div style={{
          position: "absolute", top: `calc(20px + env(safe-area-inset-top, 0px))`,
          left: 0, right: 0, textAlign: "center",
          animation: "arcHint 2.4s ease-in-out infinite",
          pointerEvents: "none",
        }}>
          <p style={{ margin: 0, fontSize: 10, letterSpacing: "0.28em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", fontWeight: 600 }}>
            What are you doing?
          </p>
        </div>

        {/* v20.6.9 — Motivational quote. Sits in the vertical whitespace above
            the arc bubbles, below the top hint. Powerful, not theatrical:
            editorial serif, quiet 500ms fade-in delayed 180ms after backdrop,
            no shimmer, no bounce, no gold gradient. Just presence. */}
        {motivationalQuote && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              top: `calc(60px + env(safe-area-inset-top, 0px))`,
              left: 0, right: 0, bottom: "46vh",
              display: "flex", flexDirection: "column", justifyContent: "center",
              padding: "0 32px",
              pointerEvents: "none",
              animation: "leadgenQuoteIn 700ms cubic-bezier(0.16,1,0.3,1) 180ms both",
              textAlign: "center",
            }}
          >
            <p style={{
              margin: 0,
              fontFamily: "'Cormorant Garamond', 'Georgia', serif",
              fontSize: "clamp(19px, 5.4vw, 26px)",
              lineHeight: 1.32,
              fontWeight: 500,
              fontStyle: "italic",
              color: "rgba(255,255,255,0.92)",
              letterSpacing: "0.005em",
              textShadow: "0 1px 20px rgba(0,0,0,0.6)",
            }}>
              &ldquo;{motivationalQuote.text}&rdquo;
            </p>
            <p style={{
              margin: "14px 0 0",
              fontSize: 10,
              letterSpacing: "0.24em",
              textTransform: "uppercase",
              color: "rgba(200,170,90,0.72)",
              fontWeight: 700,
            }}>
              &mdash; {motivationalQuote.author}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={backdrop} onClick={close}>
      <div style={sheet} onClick={e => e.stopPropagation()}>
        <style>{`
          @keyframes leadgenFade { from { opacity: 0 } to { opacity: 1 } }
          @keyframes leadgenSlide { from { transform: translateY(24px); opacity: 0.6 } to { transform: translateY(0); opacity: 1 } }
        `}</style>

        {view === "refer-agent" && (
          <>
            {header("Refer an Agent", () => setView("root"))}
            <ReferAnAgentForm user={props.user} toast={props.toast} onDone={close} />
          </>
        )}

        {view === "open-house" && (
          <>
            {header("Open House", () => setView("root"))}
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 14, lineHeight: 1.55 }}>
              Log the OH, capture a lead, or piggyback a knock route while you're on-site. Points bank when Nate approves.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {tile({
                icon: <MapPin size={22} />, title: "Book an Open House", sub: "Grab an open house from the team's offered list. First come, first serve.",
                hero: true,
                onClick: () => setView("oh-book" as any),
              })}
              {tile({
                icon: <Camera size={22} />, title: "Log Open House", sub: "Selfie + address. Proof you showed up. 20 pts.",
                onClick: () => setView("oh-log"),
              })}
              {tile({
                icon: <UserPlus size={22} />, title: "Log Open House Lead", sub: "Captured a lead? Full lead form → auto-assigned. 20 pts.",
                hero: true,
                onClick: () => setView("oh-lead"),
              })}
              {tile({
                icon: <DoorOpen size={22} />, title: "Neighborhood Knock Route", sub: "Piggyback the OH — knock the block. 40 pts on Nate's approval.",
                onClick: () => setView("oh-knock-route" as any),
              })}
            </div>
          </>
        )}

        {view === "oh-log" && (
          <>
            {header("Log Open House", () => setView("open-house"))}
            <OpenHouseLogForm user={user} toast={toast} onDone={close} />
          </>
        )}

        {view === ("oh-book" as any) && (
          <>
            {header("Book Open House", () => setView("open-house"))}
            <BookOpenHouseSheet userId={(user as any)?.id} onBooked={() => { /* handled inside sheet */ }} />
          </>
        )}

        {view === "oh-lead" && (
          <>
            {header("Open House Lead", () => setView("open-house"))}
            <ClientReferralForm source="open_house" onSubmitted={() => close()} />
          </>
        )}

        {view === "network-referral" && (
          <>
            {header("Network Referral", () => setView("root"))}
            <ClientReferralForm source="network" onSubmitted={() => close()} />
          </>
        )}

        {view === "door-knock" && (
          <>
            {header("Door Knock", () => setView("root"))}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <DoorKnockLogForm user={props.user} toast={props.toast} onDone={close} />
              <div style={{
                padding: "14px 16px", borderRadius: 12,
                background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.22)",
              }}>
                <p style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#4ade80", fontWeight: 700, margin: 0, marginBottom: 4 }}>
                  Picked up a warm lead?
                </p>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginBottom: 10, lineHeight: 1.5 }}>
                  Someone opened the door and wants to talk — capture them.
                </p>
                <button type="button" onClick={() => setView("door-knock-lead")} style={{
                  width: "100%", padding: "11px 16px", borderRadius: 8,
                  background: "rgba(74,222,128,0.14)", border: "1px solid rgba(74,222,128,0.4)",
                  color: "#4ade80", fontWeight: 700, fontSize: 12, letterSpacing: "0.12em",
                  textTransform: "uppercase", cursor: "pointer",
                }}>+ Capture Warm Lead</button>
              </div>
            </div>
          </>
        )}

        {view === "door-knock-lead" && (
          <>
            {header("Door Knock Lead", () => setView("door-knock"))}
            <ClientReferralForm source="door_knock" onSubmitted={() => close()} />
          </>
        )}

        {view === "direct-mail" && (
          <>
            {header("Direct Mail", () => setView("root"))}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <DirectMailLogForm user={props.user} toast={props.toast} onDone={close} />
              <div style={{
                padding: "14px 16px", borderRadius: 12,
                background: "rgba(251,146,60,0.06)", border: "1px solid rgba(251,146,60,0.22)",
              }}>
                <p style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#fb923c", fontWeight: 700, margin: 0, marginBottom: 4 }}>
                  Mailer got a call-back?
                </p>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginBottom: 10, lineHeight: 1.5 }}>
                  Recipient reached out — capture them as a warm lead.
                </p>
                <button type="button" onClick={() => setView("direct-mail-lead")} style={{
                  width: "100%", padding: "11px 16px", borderRadius: 8,
                  background: "rgba(251,146,60,0.14)", border: "1px solid rgba(251,146,60,0.4)",
                  color: "#fb923c", fontWeight: 700, fontSize: 12, letterSpacing: "0.12em",
                  textTransform: "uppercase", cursor: "pointer",
                }}>+ Capture Warm Lead</button>
              </div>
            </div>
          </>
        )}

        {view === "direct-mail-lead" && (
          <>
            {header("Direct Mail Lead", () => setView("direct-mail"))}
            <ClientReferralForm source="direct_mail" onSubmitted={() => close()} />
          </>
        )}

        {view === "oh-knock-route" && (
          <>
            {header("Neighborhood Knock Route", () => setView("open-house"))}
            <OpenHouseKnockRouteForm user={props.user} toast={props.toast} onDone={close} />
          </>
        )}

        {view === "social" && (
          <>
            {header("Social Post", () => setView("root"))}
            <SocialPostForm user={props.user} toast={props.toast} onDone={close} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── v16.7 Open House LOG form (photo + address) ────────────────────────────
function OpenHouseLogForm(props: { user: any; toast: any; onDone: () => void }) {
  const { user, toast, onDone } = props;
  const [address, setAddress] = useState("");
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsErr, setGpsErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // v17.0 — Results form (fires the Open House Results email to Denise on submit)
  const [attendees, setAttendees] = useState<string>("");
  const [ohNotes, setOhNotes] = useState("");
  const [issues, setIssues] = useState("");
  const [recommendations, setRecommendations] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Grab GPS immediately when the form mounts. Silent — no permission spam if
  // the browser denies; we just record null and move on.
  useEffect(() => {
    if (!("geolocation" in navigator)) { setGpsErr("GPS not supported"); return; }
    navigator.geolocation.getCurrentPosition(
      pos => setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => setGpsErr(err.message || "Location unavailable"),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }, []);

  const onPickPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 6 * 1024 * 1024) {
      toast({ title: "Photo too large", description: "Try a smaller image (< 6MB).", variant: "destructive" });
      return;
    }
    // Downscale to ~1024px longest edge to keep payload small
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const MAX = 1024;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = MAX / Math.max(width, height);
          width = Math.round(width * scale); height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) { ctx.drawImage(img, 0, 0, width, height); }
        setPhotoDataUrl(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    if (!address.trim()) { toast({ title: "Address required", variant: "destructive" }); return; }
    if (!photoDataUrl) { toast({ title: "Selfie required", description: "Snap a selfie with the OH sign in the background.", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const r = await apiRequest("POST", "/api/lead-gen/open-house-log", {
        agentId: user?.id,
        address: address.trim(),
        photoDataUrl,
        gpsLat: gps?.lat ?? null,
        gpsLng: gps?.lng ?? null,
        timestamp: new Date().toISOString(),
        attendees: attendees.trim() ? parseInt(attendees.trim()) : null,
        notes: ohNotes.trim(),
        issues: issues.trim(),
        recommendations: recommendations.trim(),
      });
      const data = await r.json();
      if (r.ok && data.submitted) {
        toast({
          title: "Submitted for approval",
          description: "Denise gets your results now. Nate will approve your +20 pts.",
        });
        onDone();
      } else {
        toast({ title: "Failed to submit", description: data.error || "Unknown error", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Failed to submit", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* v17.0 — Explanatory intro. Sign-in-background is a soft rule; social
          nudge is meant to feel like a normal social habit, not a corporate ask. */}
      <div style={{
        padding: "12px 14px", background: "rgba(200,170,90,0.06)",
        border: "1px solid rgba(200,170,90,0.18)", borderRadius: 10,
      }}>
        <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.75)", lineHeight: 1.55 }}>
          Take a selfie <strong>with the Open House sign in the background</strong>. While you're at it —
          post it on Instagram or your story. That's what top agents do anyway.
        </p>
      </div>

      <div>
        <label style={{ display: "block", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, marginBottom: 6 }}>Selfie with the OH sign *</label>
        <input ref={fileRef} type="file" accept="image/*" capture="user" onChange={onPickPhoto} style={{ display: "none" }} />
        {photoDataUrl ? (
          <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(200,170,90,0.28)" }}>
            <img src={photoDataUrl} alt="OH selfie" style={{ width: "100%", display: "block", maxHeight: 320, objectFit: "cover" }} />
            <button onClick={() => { setPhotoDataUrl(null); if (fileRef.current) fileRef.current.value = ""; }} style={{
              position: "absolute", top: 8, right: 8,
              background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 8, padding: "6px 10px", cursor: "pointer",
              color: "#fff", fontSize: 11, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 4,
            }}><X size={12} /> Retake</button>
          </div>
        ) : (
          <button onClick={() => fileRef.current?.click()} style={{
            width: "100%", padding: "24px 14px",
            background: "rgba(200,170,90,0.05)", border: "1px dashed rgba(200,170,90,0.4)",
            borderRadius: 12, cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
            color: "#c8aa5a",
          }}>
            <Camera size={28} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Tap to take selfie</span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Front camera opens · sign in background</span>
          </button>
        )}
      </div>

      <div>
        <label style={{ display: "block", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, marginBottom: 6 }}>Property address *</label>
        <input value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Oak St, Fernandina Beach, FL" style={{
          width: "100%", padding: "12px 14px", borderRadius: 8,
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,170,90,0.28)",
          color: "#fff", fontSize: 14, boxSizing: "border-box", fontFamily: "'Switzer','Inter',sans-serif",
        }} />
      </div>

      {/* v17.0 — Open House Results section. Sent to Denise + Alex + Nate on submit. */}
      <div style={{
        marginTop: 4, padding: "14px 14px 4px",
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10,
      }}>
        <p style={{ margin: "0 0 12px", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#c8aa5a", fontWeight: 700 }}>Open House Results</p>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, marginBottom: 6 }}>Number of attendees</label>
          <input value={attendees} onChange={e => setAttendees(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 12" inputMode="numeric" style={{
            width: "100%", padding: "12px 14px", borderRadius: 8,
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,170,90,0.28)",
            color: "#fff", fontSize: 14, boxSizing: "border-box", fontFamily: "'Switzer','Inter',sans-serif",
          }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, marginBottom: 6 }}>Notes</label>
          <textarea value={ohNotes} onChange={e => setOhNotes(e.target.value)} placeholder="How did it go? Vibe of the crowd?" rows={2} style={{
            width: "100%", padding: "12px 14px", borderRadius: 8,
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,170,90,0.28)",
            color: "#fff", fontSize: 14, boxSizing: "border-box", resize: "none", lineHeight: 1.5, fontFamily: "'Switzer','Inter',sans-serif",
          }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, marginBottom: 6 }}>Issues we should know about</label>
          <textarea value={issues} onChange={e => setIssues(e.target.value)} placeholder="Anything the seller needs to fix, signage problems, complaints, etc." rows={2} style={{
            width: "100%", padding: "12px 14px", borderRadius: 8,
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,170,90,0.28)",
            color: "#fff", fontSize: 14, boxSizing: "border-box", resize: "none", lineHeight: 1.5, fontFamily: "'Switzer','Inter',sans-serif",
          }} />
        </div>

        <div style={{ marginBottom: 6 }}>
          <label style={{ display: "block", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, marginBottom: 6 }}>Recommendations</label>
          <textarea value={recommendations} onChange={e => setRecommendations(e.target.value)} placeholder="Price adjustments, staging, next-step advice for Denise…" rows={2} style={{
            width: "100%", padding: "12px 14px", borderRadius: 8,
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,170,90,0.28)",
            color: "#fff", fontSize: 14, boxSizing: "border-box", resize: "none", lineHeight: 1.5, fontFamily: "'Switzer','Inter',sans-serif",
          }} />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
        <MapPin size={12} />
        {gps ? (
          <span>GPS locked · {gps.lat.toFixed(4)}, {gps.lng.toFixed(4)}</span>
        ) : gpsErr ? (
          <span>Location unavailable ({gpsErr})</span>
        ) : (
          <span>Locking GPS…</span>
        )}
      </div>

      <button onClick={submit} disabled={submitting || !photoDataUrl || !address.trim()} style={{
        marginTop: 4, padding: "14px 20px",
        background: (submitting || !photoDataUrl || !address.trim())
          ? "rgba(200,170,90,0.25)"
          : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
        border: "none", borderRadius: 10, cursor: submitting ? "wait" : "pointer",
        fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
        color: "#080808",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        <Send size={14} /> {submitting ? "Sending…" : "Submit → Denise + Approval"}
      </button>

      <p style={{ margin: "6px 0 0", fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.5, textAlign: "center" }}>
        Denise gets your results now. Nate approves your +20 pts.
      </p>
    </div>
  );
}


// ─── v17.2 Door Knock LOG form ──────────────────────────────
// Field-prospecting flow. Address + doors-knocked count + notes. Evidence
// lives in the rep-card app (external); no photo required in Depot. Points
// = 2 pts x doors, awarded when Nate approves in the Phase 6 approvals queue.
function DoorKnockLogForm(props: { user: any; toast: any; onDone: () => void }) {
  const { user, toast, onDone } = props;
  const [address, setAddress] = useState("");
  const [doorsCount, setDoorsCount] = useState("");
  const [notes, setNotes] = useState("");
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      pos => setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }, []);

  const doorsNum = doorsCount.trim() ? Math.max(0, parseInt(doorsCount.trim()) || 0) : 0;
  const pointsPreview = Math.min(doorsNum, 250) * 2;

  const submit = async () => {
    if (!address.trim()) { toast({ title: "Address / block required", variant: "destructive" }); return; }
    if (!doorsNum) { toast({ title: "Doors count required", description: "How many doors did you knock?", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const r = await apiRequest("POST", "/api/lead-gen/door-knock-log", {
        agentId: user?.id,
        address: address.trim(),
        doorsCount: doorsNum,
        notes: notes.trim(),
        gpsLat: gps?.lat ?? null,
        gpsLng: gps?.lng ?? null,
        timestamp: new Date().toISOString(),
      });
      const data = await r.json();
      if (r.ok && data.submitted) {
        toast({
          title: "Submitted for approval",
          description: `Nate reconciles with the rep-card app. ${data.pointsPotential ?? pointsPreview} pts bank on approval.`,
        });
        onDone();
      } else {
        toast({ title: "Failed to submit", description: data.error || "Unknown error", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Failed to submit", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(200,170,90,0.22)",
    borderRadius: 10, padding: "12px 14px", color: "#fff", fontSize: 14, outline: "none",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", margin: 0, lineHeight: 1.55 }}>
        Log a knock route. Evidence lives in the rep-card app — Nate reconciles and approves. 2 pts per door.
      </p>
      <input
        style={inputStyle} placeholder="Block / cross-streets / neighborhood"
        value={address} onChange={e => setAddress(e.target.value)}
      />
      <input
        style={inputStyle} placeholder="Doors knocked"
        inputMode="numeric" value={doorsCount} onChange={e => setDoorsCount(e.target.value.replace(/[^0-9]/g, ""))}
      />
      {doorsNum > 0 && (
        <div style={{
          padding: "10px 12px", borderRadius: 10,
          background: "rgba(200,170,90,0.10)", border: "1px solid rgba(200,170,90,0.28)",
          fontSize: 12, color: "#c8aa5a", letterSpacing: "0.04em",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span>{doorsNum > 250 ? `250 doors capped (of ${doorsNum})` : `${doorsNum} doors x 2 pts`}</span>
          <strong style={{ color: "#fde047", fontSize: 14 }}>+{pointsPreview} pts pending</strong>
        </div>
      )}
      <textarea
        style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: "inherit" }}
        placeholder="Notes — what did you say at the door? Any live prospects?"
        value={notes} onChange={e => setNotes(e.target.value)}
      />
      <button onClick={submit} disabled={submitting} style={{
        width: "100%", marginTop: 4, padding: "14px 16px",
        background: submitting ? "rgba(200,170,90,0.4)" : "linear-gradient(135deg,#fde047 0%,#c8aa5a 100%)",
        border: "none", borderRadius: 12, cursor: submitting ? "wait" : "pointer",
        fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#080808",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        <Send size={14} /> {submitting ? "Submitting…" : "Submit for approval"}
      </button>
    </div>
  );
}

// ─── v17.2 Direct Mail LOG form ─────────────────────────────────────────────
// Log a mailer campaign. Agent uploads evidence of the mailer (photo + audience
// description + count). Nate approves and awards points (1 pt per address).
function DirectMailLogForm(props: { user: any; toast: any; onDone: () => void }) {
  const { user, toast, onDone } = props;
  const [audience, setAudience] = useState("");
  const [mailedCount, setMailedCount] = useState("");
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 6 * 1024 * 1024) {
      toast({ title: "Photo too large", description: "Try a smaller image (< 6MB).", variant: "destructive" });
      return;
    }
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const MAX = 1024;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = MAX / Math.max(width, height);
          width = Math.round(width * scale); height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) { ctx.drawImage(img, 0, 0, width, height); }
        setPhotoDataUrl(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    if (!audience.trim()) { toast({ title: "Audience required", variant: "destructive" }); return; }
    if (!mailedCount.trim() || !parseInt(mailedCount.trim())) { toast({ title: "Address count required", variant: "destructive" }); return; }
    if (!photoDataUrl) { toast({ title: "Mailer photo required", description: "Attach a photo of the mailer.", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const r = await apiRequest("POST", "/api/lead-gen/direct-mail-log", {
        agentId: user?.id,
        audience: audience.trim(),
        mailedCount: parseInt(mailedCount.trim()),
        photoDataUrl,
        notes: notes.trim(),
        timestamp: new Date().toISOString(),
      });
      const data = await r.json();
      if (r.ok && data.submitted) {
        toast({
          title: "Submitted for approval",
          description: "Nate reviews mailer + approves. Points bank at 1 pt per address on approval.",
        });
        onDone();
      } else {
        toast({ title: "Failed to submit", description: data.error || "Unknown error", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Failed to submit", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(200,170,90,0.22)",
    borderRadius: 10, padding: "12px 14px", color: "#fff", fontSize: 14, outline: "none",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", margin: 0, lineHeight: 1.55 }}>
        Log a direct-mail campaign. Nate approves the mailer + audience + count. Points bank at approval.
      </p>
      <input
        style={inputStyle} placeholder="Audience — e.g. 32082 zip, expired listings"
        value={audience} onChange={e => setAudience(e.target.value)}
      />
      <input
        style={inputStyle} placeholder="Addresses mailed (count)"
        inputMode="numeric" value={mailedCount} onChange={e => setMailedCount(e.target.value)}
      />
      <textarea
        style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: "inherit" }}
        placeholder="Notes — piece type, CTA, sending window, follow-up plan"
        value={notes} onChange={e => setNotes(e.target.value)}
      />
      <div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPickPhoto} />
        <button onClick={() => fileRef.current?.click()} style={{
          width: "100%", padding: "14px 16px", borderRadius: 12,
          background: photoDataUrl ? "rgba(74,222,128,0.14)" : "rgba(200,170,90,0.14)",
          border: `1px solid ${photoDataUrl ? "rgba(74,222,128,0.4)" : "rgba(200,170,90,0.35)"}`,
          color: photoDataUrl ? "#4ade80" : "#c8aa5a",
          fontSize: 14, fontWeight: 600, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        }}>
          <Camera size={16} /> {photoDataUrl ? "Photo attached — tap to replace" : "Attach mailer photo"}
        </button>
      </div>
      <button onClick={submit} disabled={submitting} style={{
        width: "100%", marginTop: 4, padding: "14px 16px",
        background: submitting ? "rgba(200,170,90,0.4)" : "linear-gradient(135deg,#fde047 0%,#c8aa5a 100%)",
        border: "none", borderRadius: 12, cursor: submitting ? "wait" : "pointer",
        fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#080808",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        <Send size={14} /> {submitting ? "Submitting…" : "Submit for approval"}
      </button>
    </div>
  );
}

// ─── v17.6 OH Knock Route form ──────────────────────────────────────────────
// Piggyback an open house — walk the block, knock 25+ doors, log tally + selfie.
// 40 pts flat on Nate's approval. Kind = "oh_knock_route".
function OpenHouseKnockRouteForm(props: { user: any; toast: any; onDone: () => void }) {
  const { user, toast, onDone } = props;
  const [ohAddress, setOhAddress] = useState("");
  const [routeArea, setRouteArea] = useState("");
  const [doorsKnocked, setDoorsKnocked] = useState("");
  const [contacts, setContacts] = useState("");
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      pos => setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }, []);

  const onPickPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 6 * 1024 * 1024) { toast({ title: "Photo too large", variant: "destructive" }); return; }
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const MAX = 1024;
        let { width, height } = img;
        if (width > MAX || height > MAX) { const s = MAX / Math.max(width, height); width = Math.round(width*s); height = Math.round(height*s); }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(img, 0, 0, width, height);
        setPhotoDataUrl(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    if (!ohAddress.trim()) { toast({ title: "OH address required", variant: "destructive" }); return; }
    const doors = parseInt(doorsKnocked || "0", 10);
    if (!doors || doors < 25) { toast({ title: "Minimum 25 doors", description: "Knock 25+ to log a route.", variant: "destructive" }); return; }
    if (!photoDataUrl) { toast({ title: "Selfie required", description: "Snap a selfie on the block.", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const r = await apiRequest("POST", "/api/lead-gen/oh-knock-route", {
        agentId: user?.id,
        ohAddress: ohAddress.trim(),
        routeArea: routeArea.trim() || null,
        doorsKnocked: doors,
        contacts: parseInt(contacts || "0", 10) || 0,
        photoDataUrl,
        gpsLat: gps?.lat ?? null, gpsLng: gps?.lng ?? null,
        notes: notes.trim(),
        timestamp: new Date().toISOString(),
      });
      const data = await r.json();
      if (r.ok && data.submitted) {
        toast({ title: "Submitted for approval", description: "Nate will approve your +40 pts." });
        onDone();
      } else {
        toast({ title: "Failed to submit", description: data.error || "Unknown error", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Failed to submit", description: err?.message || String(err), variant: "destructive" });
    } finally { setSubmitting(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "12px 14px", borderRadius: 8,
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(200,170,90,0.22)",
    color: "#fff", fontSize: 14,
  };
  const labelStyle: React.CSSProperties = { display: "block", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, marginBottom: 6 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ padding: "12px 14px", background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.22)", borderRadius: 10 }}>
        <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.75)", lineHeight: 1.55 }}>
          Piggyback the open house. Knock the block while you're there.
          Minimum <strong>25 doors</strong> — 40 pts flat.
        </p>
      </div>

      <div>
        <label style={labelStyle}>Selfie on the block *</label>
        <input ref={fileRef} type="file" accept="image/*" capture="user" onChange={onPickPhoto} style={{ display: "none" }} />
        {photoDataUrl ? (
          <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(74,222,128,0.28)" }}>
            <img src={photoDataUrl} alt="Route selfie" style={{ width: "100%", display: "block", maxHeight: 320, objectFit: "cover" }} />
            <button onClick={() => { setPhotoDataUrl(null); if (fileRef.current) fileRef.current.value = ""; }} style={{
              position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: "#fff", fontSize: 11, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 4,
            }}><X size={12} /> Retake</button>
          </div>
        ) : (
          <button onClick={() => fileRef.current?.click()} style={{
            width: "100%", padding: "24px 14px", background: "rgba(74,222,128,0.05)",
            border: "1px dashed rgba(74,222,128,0.4)", borderRadius: 12, cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 8, color: "#4ade80",
          }}>
            <Camera size={28} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Tap to take selfie</span>
          </button>
        )}
      </div>

      <div>
        <label style={labelStyle}>OH address *</label>
        <input value={ohAddress} onChange={e => setOhAddress(e.target.value)} placeholder="123 Oak St, Fernandina Beach, FL" style={inputStyle} />
      </div>

      <div>
        <label style={labelStyle}>Route area / neighborhood</label>
        <input value={routeArea} onChange={e => setRouteArea(e.target.value)} placeholder="Oak St, blocks 100-300" style={inputStyle} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <label style={labelStyle}>Doors knocked *</label>
          <input type="number" min={25} inputMode="numeric" value={doorsKnocked} onChange={e => setDoorsKnocked(e.target.value)} placeholder="25" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}># conversations</label>
          <input type="number" min={0} inputMode="numeric" value={contacts} onChange={e => setContacts(e.target.value)} placeholder="0" style={inputStyle} />
        </div>
      </div>

      <div>
        <label style={labelStyle}>Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything notable — hot neighborhoods, warm doors, follow-ups…" rows={3} style={{ ...inputStyle, resize: "vertical" as any }} />
      </div>

      <button onClick={submit} disabled={submitting} style={{
        width: "100%", marginTop: 4, padding: "14px 16px",
        background: submitting ? "rgba(74,222,128,0.4)" : "linear-gradient(135deg,#86efac 0%,#4ade80 100%)",
        border: "none", borderRadius: 12, cursor: submitting ? "wait" : "pointer",
        fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#0a2a10",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        <Send size={14} /> {submitting ? "Submitting…" : "Submit for +40 pts approval"}
      </button>
    </div>
  );
}

// ─── v17.6 Social Post form ─────────────────────────────────────────────────
// v19.6 Refer an Agent form
// Agent submits name/phone/email of someone they'd refer; server creates the
// candidate + returns the /join/<token> link. Agent picks SMS, Email, or
// Copy Link to hand it off. 100 pts awarded when Alex approves the candidate.
function ReferAnAgentForm(props: { user: any; toast: any; onDone: () => void }) {
  const { toast } = props;
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !phone.trim()) {
      toast?.({ title: "Name + phone required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/candidates/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim(), phone: phone.trim(), email: email.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "invite failed");
      setInviteUrl(data.inviteUrl);
      toast?.({ title: "Invite ready — share the link" });
    } catch (err: any) {
      toast?.({ title: err.message || "Something went wrong", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const firstName = name.split(/\s+/)[0] || "there";
  const shareMsg = `Hey ${firstName} — I think you'd be a great fit for our team at Brothers Group Real Estate (Momentum Realty). Take 3 minutes to fill out this quick form and we'll talk: ${inviteUrl || ""}`;
  const isApple  = typeof navigator !== "undefined" && /iPhone|iPad|Mac/.test(navigator.userAgent);
  const smsHref  = `sms:${(phone || "").replace(/[^\d+]/g, "")}${isApple ? "&" : "?"}body=${encodeURIComponent(shareMsg)}`;
  const mailHref = email ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Come check out our real estate team")}&body=${encodeURIComponent(shareMsg)}` : "";

  const copyLink = async () => {
    if (!inviteUrl) return;
    try { await navigator.clipboard.writeText(inviteUrl); toast?.({ title: "Link copied" }); }
    catch { toast?.({ title: "Copy failed — select the link manually", variant: "destructive" }); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "12px 14px", borderRadius: 10,
    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.14)",
    color: "#fff", fontSize: 15, marginBottom: 12,
  };

  if (inviteUrl) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ padding: 14, borderRadius: 12, background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.28)" }}>
          <p style={{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: "#38bdf8", fontWeight: 700, margin: 0, marginBottom: 6 }}>Invite ready for {name}</p>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", margin: 0, wordBreak: "break-all" }}>{inviteUrl}</p>
        </div>
        <a href={smsHref} style={{ display: "block", textAlign: "center", padding: "14px 16px", borderRadius: 10, background: "rgba(74,222,128,0.14)", border: "1px solid rgba(74,222,128,0.4)", color: "#4ade80", fontWeight: 700, fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", textDecoration: "none" }}>Text {firstName} the link
        </a>
        {email && (
          <a href={mailHref} style={{ display: "block", textAlign: "center", padding: "14px 16px", borderRadius: 10, background: "rgba(56,189,248,0.14)", border: "1px solid rgba(56,189,248,0.4)", color: "#38bdf8", fontWeight: 700, fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", textDecoration: "none" }}>Email {firstName} the link
          </a>
        )}
        <button type="button" onClick={copyLink} style={{ padding: "14px 16px", borderRadius: 10, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.18)", color: "#fff", fontWeight: 700, fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>Copy link
        </button>
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", textAlign: "center", margin: "4px 0 0" }}>
          Alex reviews once {firstName} submits their application. 100 pts to you if they're hired.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginBottom: 14, lineHeight: 1.55 }}>
        Know a licensed agent (or licensable person) who'd thrive on our team? Drop their info and we'll generate a private application link you can text or email to them. 100 pts to you if Alex approves.
      </p>
      <label style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginBottom: 6, fontWeight: 700 }}>Full name</label>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Jane Smith" style={inputStyle} />
      <label style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginBottom: 6, fontWeight: 700 }}>Mobile phone</label>
      <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 123-4567" type="tel" style={inputStyle} />
      <label style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginBottom: 6, fontWeight: 700 }}>Email (optional)</label>
      <input value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" type="email" style={inputStyle} />
      <button type="button" onClick={submit} disabled={submitting || !name.trim() || !phone.trim()} style={{
        marginTop: 8, padding: "14px 16px", borderRadius: 10,
        background: submitting ? "rgba(167,139,250,0.14)" : "rgba(167,139,250,0.24)",
        border: "1px solid rgba(167,139,250,0.5)",
        color: "#a78bfa", fontWeight: 700, fontSize: 13, letterSpacing: "0.12em",
        textTransform: "uppercase", cursor: submitting ? "wait" : "pointer",
      }}>{submitting ? "Creating invite…" : "Create invite link"}</button>
    </div>
  );
}

// 15 pts flat, 1/day ET cap. Kind = "social_post". Screenshot + platform + link.
function SocialPostForm(props: { user: any; toast: any; onDone: () => void }) {
  const { user, toast, onDone } = props;
  const [platform, setPlatform] = useState<"instagram" | "facebook" | "tiktok" | "youtube" | "linkedin" | "x">("instagram");
  const [postUrl, setPostUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 6 * 1024 * 1024) { toast({ title: "Photo too large", variant: "destructive" }); return; }
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const MAX = 1024;
        let { width, height } = img;
        if (width > MAX || height > MAX) { const s = MAX / Math.max(width, height); width = Math.round(width*s); height = Math.round(height*s); }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(img, 0, 0, width, height);
        setPhotoDataUrl(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    if (!photoDataUrl) { toast({ title: "Screenshot required", description: "Attach a screenshot of the post.", variant: "destructive" }); return; }
    if (!postUrl.trim() && !caption.trim()) { toast({ title: "Add a link or caption", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const r = await apiRequest("POST", "/api/lead-gen/social-post", {
        agentId: user?.id,
        platform,
        postUrl: postUrl.trim() || null,
        caption: caption.trim() || null,
        photoDataUrl,
        timestamp: new Date().toISOString(),
      });
      const data = await r.json();
      if (r.ok && data.submitted) {
        toast({ title: "Submitted for approval", description: "+15 pts pending Nate's review." });
        onDone();
      } else if (r.status === 409) {
        toast({ title: "Already logged today", description: "One social post per day. Come back tomorrow.", variant: "destructive" });
      } else {
        toast({ title: "Failed to submit", description: data.error || "Unknown error", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Failed to submit", description: err?.message || String(err), variant: "destructive" });
    } finally { setSubmitting(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "12px 14px", borderRadius: 8,
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(200,170,90,0.22)",
    color: "#fff", fontSize: 14,
  };
  const labelStyle: React.CSSProperties = { display: "block", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, marginBottom: 6 };

  const platforms: Array<{ id: typeof platform; label: string }> = [
    { id: "instagram", label: "Instagram" },
    { id: "facebook", label: "Facebook" },
    { id: "tiktok", label: "TikTok" },
    { id: "youtube", label: "YouTube" },
    { id: "linkedin", label: "LinkedIn" },
    { id: "x", label: "X / Twitter" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ padding: "12px 14px", background: "rgba(200,170,90,0.06)", border: "1px solid rgba(200,170,90,0.18)", borderRadius: 10 }}>
        <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.75)", lineHeight: 1.55 }}>
          Post about real estate — tag <strong>@watsonbrothersgroup</strong> or the brand. 15 pts flat, one per day.
        </p>
      </div>

      <div>
        <label style={labelStyle}>Screenshot of the post *</label>
        <input ref={fileRef} type="file" accept="image/*" onChange={onPickPhoto} style={{ display: "none" }} />
        {photoDataUrl ? (
          <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(200,170,90,0.28)" }}>
            <img src={photoDataUrl} alt="Post screenshot" style={{ width: "100%", display: "block", maxHeight: 400, objectFit: "cover" }} />
            <button onClick={() => { setPhotoDataUrl(null); if (fileRef.current) fileRef.current.value = ""; }} style={{
              position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: "#fff", fontSize: 11, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 4,
            }}><X size={12} /> Replace</button>
          </div>
        ) : (
          <button onClick={() => fileRef.current?.click()} style={{
            width: "100%", padding: "24px 14px", background: "rgba(200,170,90,0.05)",
            border: "1px dashed rgba(200,170,90,0.4)", borderRadius: 12, cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 8, color: "#c8aa5a",
          }}>
            <Instagram size={28} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Tap to attach screenshot</span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Show the caption, hashtags, or brand tag</span>
          </button>
        )}
      </div>

      <div>
        <label style={labelStyle}>Platform *</label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          {platforms.map(p => (
            <button key={p.id} type="button" onClick={() => setPlatform(p.id)} style={{
              padding: "10px 8px", borderRadius: 8,
              background: platform === p.id ? "rgba(200,170,90,0.18)" : "rgba(255,255,255,0.04)",
              border: platform === p.id ? "1px solid rgba(200,170,90,0.55)" : "1px solid rgba(255,255,255,0.08)",
              color: platform === p.id ? "#fde047" : "rgba(255,255,255,0.65)",
              fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>{p.label}</button>
          ))}
        </div>
      </div>

      <div>
        <label style={labelStyle}>Post link (optional)</label>
        <input value={postUrl} onChange={e => setPostUrl(e.target.value)} placeholder="https://instagram.com/p/…" style={inputStyle} />
      </div>

      <div>
        <label style={labelStyle}>Caption / notes</label>
        <textarea value={caption} onChange={e => setCaption(e.target.value)} placeholder="What was the post about? (helps Nate approve faster)" rows={3} style={{ ...inputStyle, resize: "vertical" as any }} />
      </div>

      <button onClick={submit} disabled={submitting} style={{
        width: "100%", marginTop: 4, padding: "14px 16px",
        background: submitting ? "rgba(200,170,90,0.4)" : "linear-gradient(135deg,#fde047 0%,#c8aa5a 100%)",
        border: "none", borderRadius: 12, cursor: submitting ? "wait" : "pointer",
        fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", color: "#080808",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        <Send size={14} /> {submitting ? "Submitting…" : "Submit for +15 pts approval"}
      </button>
    </div>
  );
}
