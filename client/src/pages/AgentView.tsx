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
  Home, Voicemail,
} from "lucide-react";
import ProfilePage from "./ProfilePage";
import TutorialModal from "../components/TutorialModal";
import ConfettiCelebration from "../components/ld/ConfettiCelebration";
import type { Lead } from "@shared/schema";

// ─── Logo ─────────────────────────────────────────────────────────────────────
function LogoIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-label="Lead Depot">
      <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.6"/>
      <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
      <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.4"/>
    </svg>
  );
}

// ─── LPMAMA fields config ─────────────────────────────────────────────────────
// v14.20 — split into SELLER (6 fields, drops the buyer catch-all) and BUYER (5 fields,
// only shown when the seller says they're also buying). The Buyer LPMAMA is the whole
// point of the redesign: we can now give buyer-side service without cramming it into
// a single text field.
const SELLER_LPMAMA_FIELDS = [
  { key: "location",    label: "L — Location",    color: "#c8aa5a", hint: "Where do they want to go? Area preferences?",           leadField: "lLocation" },
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
const OUTCOMES = [
  // Row 1 — fast per-line taps
  { key: "no_answer",               label: "No Answer",     icon: PhoneMissed,   bg: "rgba(234,179,8,0.12)",   border: "rgba(234,179,8,0.4)",    text: "rgb(253,224,71)",       hoverBg: "rgba(234,179,8,0.22)" },
  { key: "wrong_number",            label: "Wrong #",       icon: AlertTriangle, bg: "rgba(239,68,68,0.08)",   border: "rgba(239,68,68,0.25)",   text: "rgba(252,165,165,0.8)", hoverBg: "rgba(239,68,68,0.15)" },
  { key: "disconnected",            label: "Disconnected",  icon: PhoneOff,      bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.35)", text: "rgb(203,213,225)",      hoverBg: "rgba(148,163,184,0.20)" },
  // Row 2 — decision, lead-level
  { key: "contacted_not_interested",label: "Not Interested",icon: XCircle,       bg: "rgba(239,68,68,0.12)",   border: "rgba(239,68,68,0.4)",    text: "rgb(252,165,165)",      hoverBg: "rgba(239,68,68,0.22)" },
  { key: "recycled",                label: "Recycle",       icon: RefreshCw,     bg: "rgba(34,211,238,0.12)",  border: "rgba(34,211,238,0.4)",   text: "rgb(103,232,249)",      hoverBg: "rgba(34,211,238,0.22)" },
  { key: "listed",                  label: "Listed",        icon: Home,          bg: "rgba(139,92,246,0.12)",  border: "rgba(139,92,246,0.4)",   text: "rgb(196,181,253)",      hoverBg: "rgba(139,92,246,0.22)" },
  // Row 3 — wins
  { key: "contacted_appointment",   label: "Appt Set",      icon: CheckCircle2,  bg: "rgba(34,197,94,0.12)",   border: "rgba(34,197,94,0.4)",    text: "rgb(134,239,172)",      hoverBg: "rgba(34,197,94,0.22)" },
  { key: "keep_in_touch",           label: "Keep in Touch", icon: Heart,         bg: "rgba(236,72,153,0.12)",  border: "rgba(236,72,153,0.4)",   text: "rgb(249,168,212)",      hoverBg: "rgba(236,72,153,0.22)" },
  { key: "left_voicemail",          label: "Left VM",       icon: Voicemail,     bg: "rgba(59,130,246,0.12)",  border: "rgba(59,130,246,0.4)",   text: "rgb(147,197,253)",      hoverBg: "rgba(59,130,246,0.22)" },
] as const;

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
            <label style={labelStyle}>Client Intention <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>(select all that apply)</span></label>
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
  const [showScript, setShowScript] = useState(false);
  const [hoveredOutcome, setHoveredOutcome] = useState<string | null>(null);
  const [pendingOutcome, setPendingOutcome] = useState<"contacted_appointment" | "keep_in_touch" | null>(null);
  const [pendingRecycle, setPendingRecycle] = useState(false);
  // v14.20 — lpmOpen/toneOpen state removed. Seller LPMAMA is always visible;
  // Tone Rules + Guardrails + Branch Cues moved to the Scripts admin page.
  const [outcomeFlash, setOutcomeFlash] = useState<{ label: string; color: string } | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
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
  // v14.20 — Also buying toggle. Unfolds Buyer LPMAMA when YES.
  const [alsoBuying, setAlsoBuying] = useState<boolean>(!!(lead as any).alsoBuying);

  const extra = (() => { try { return JSON.parse(lead.extraData || "{}"); } catch { return {}; } })();

  const { data: script } = useQuery<{ content: string }>({
    queryKey: ["/api/scripts", lead.leadType],
    queryFn: () => apiRequest("GET", `/api/scripts/${lead.leadType}`).then(r => r.json()),
    staleTime: 60000,
  });

  const OUTCOME_FLASH: Record<string, { label: string; color: string }> = {
    keep_in_touch:            { label: "Keep in Touch — Logged", color: "rgb(249,168,212)" },
    contacted_appointment:    { label: "Appointment Set!",         color: "rgb(134,239,172)" },
    no_answer:                { label: "No Answer — Logged",      color: "rgb(253,224,71)" },
    contacted_not_interested: { label: "Not Interested — Logged", color: "rgb(252,165,165)" },
    wrong_number:             { label: "Wrong # — Logged",        color: "rgba(252,165,165,0.8)" },
    recycled:                 { label: "Recycled to Pool",         color: "#22d3ee" },
    // v14.16 — 9-outcome grid additions
    disconnected:             { label: "Disconnected — Logged",    color: "rgb(203,213,225)" },
    listed:                   { label: "Listed — Closed Out",      color: "rgb(196,181,253)" },
    left_voicemail:           { label: "Voicemail — Logged",       color: "rgb(147,197,253)" },
  };

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
        lpmamab: { ...lpmData, alsoBuying },
      }).then(r => r.json()),
    onSuccess: (data, variables) => {
      // Show success flash for 900ms, then load next lead
      const flash = OUTCOME_FLASH[variables.outcome] ?? { label: "Outcome Logged", color: "#c8aa5a" };
      setOutcomeFlash(flash);
      // Confetti for appointments!
      if (variables.outcome === "contacted_appointment") {
        setShowConfetti(true);
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
          const label = variables.outcome === "disconnected" ? "Disconnected" : "Wrong #";
          if (data && data.deleted) {
            toast({
              title: `${label} — line ${currentLineNum} struck`,
              description: "All numbers dead — lead removed.",
              duration: 3000,
            });
          } else if (data && data.keptOnLead) {
            const nextIdx = allPhones.findIndex(p => p === untriedRemaining[0]);
            toast({
              title: `${label} — line ${currentLineNum} struck`,
              description: `Now dialing line ${nextIdx + 1} of ${total}.`,
              duration: 3000,
            });
          } else {
            toast({
              title: `${label} — line ${currentLineNum} struck`,
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
  const struckCount = Object.values(phoneStates).filter(s => s === "struck").length;
  const triedTodayCount = Object.values(phoneStates).filter(s => s === "no_answer_today").length;
  const remainingCount = allPhones.filter(p => phoneStates[p] !== "struck").length;

  const handleOutcome = (key: string) => {
    if (key === "contacted_appointment" || key === "keep_in_touch") {
      setPendingOutcome(key as "contacted_appointment" | "keep_in_touch");
      return;
    }
    if (key === "recycled") {
      setPendingRecycle(true);
      return;
    }
    outcomeMutation.mutate({ outcome: key, notes, dialedPhone: activePhone });
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

  // v14.26 — Mailto is now built from the editable Flow 1 template on the server.
  // We render synchronously with a fallback (in case the fetch hasn't returned yet),
  // and swap in the DB-rendered version once loaded.
  const [mailtoOverride, setMailtoOverride] = useState<string | null>(null);
  const [mailtoOverride3, setMailtoOverride3] = useState<string | null>(null);
  // v14.28 — Email eligibility for Flow 3 button + 2nd-attempt badge
  // v14.34 — Adds tap timestamp, 24h gate, and FUB evidence status
  const [emailStatus, setEmailStatus] = useState<{
    flow1Sent: boolean;
    contactedYet: boolean;
    emailedToday: boolean;
    flow3Eligible: boolean;
    secondAttemptBadge: boolean;
    tappedAt: string | null;
    unlockAt: string | null;
    secondsUntilUnlock: number;
    gateOpen: boolean;
    evidenceConfirmed: boolean;
    evidenceAt: string | null;
  } | null>(null);
  const [flow3Sending, setFlow3Sending] = useState(false);
  // v14.34 — live countdown ticker for the locked 2nd-attempt button
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const refreshEmailStatus = () => {
    if (!lead?.id) return;
    fetch(`/api/leads/${lead.id}/email-status`)
      .then(r => r.ok ? r.json() : null)
      .then(j => setEmailStatus(j))
      .catch(() => {});
  };
  useEffect(() => { refreshEmailStatus(); }, [lead?.id]);
  // v14.34 — Tick every second while a gate countdown is showing.
  useEffect(() => {
    if (!emailStatus?.unlockAt || emailStatus?.gateOpen) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [emailStatus?.unlockAt, emailStatus?.gateOpen]);
  useEffect(() => {
    if (!lead?.id || !lead?.email) { setMailtoOverride(null); setMailtoOverride3(null); return; }
    const q = `agentId=${user?.id || ""}`;
    fetch(`/api/leads/${lead.id}/email-template?flow=1&${q}`)
      .then(r => r.ok ? r.json() : null)
      .then((j: any) => {
        if (!j) return;
        const s = encodeURIComponent(j.subject || "");
        const b = encodeURIComponent(j.body || "");
        setMailtoOverride(`mailto:${lead.email}?subject=${s}&body=${b}`);
      })
      .catch(() => {});
    // v14.28 — Also prefetch Flow 3 template for the 2nd-attempt button (only rendered if eligible)
    fetch(`/api/leads/${lead.id}/email-template?flow=3&${q}`)
      .then(r => r.ok ? r.json() : null)
      .then((j: any) => {
        if (!j) return;
        const s = encodeURIComponent(j.subject || "");
        const b = encodeURIComponent(j.body || "");
        setMailtoOverride3(`mailto:${lead.email}?subject=${s}&body=${b}`);
      })
      .catch(() => {});
  }, [lead?.id, lead?.email, user?.id]);
  const _fallbackSubject = encodeURIComponent(`Regarding your property at ${lead.address}`);
  const _fallbackBody = encodeURIComponent(`Hi ${lead.ownerName || "there"},\n\nI wanted to reach out about your property at ${lead.address}. I specialize in helping homeowners in your area and I'd love to connect.\n\nWould you be available for a quick call?\n\nBest,\nBrothers Group Real Estate Team at Momentum Realty`);
  const mailtoLink = lead.email
    ? (mailtoOverride || `mailto:${lead.email}?subject=${_fallbackSubject}&body=${_fallbackBody}`)
    : null;

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
              {remainingCount}/{allPhones.length} viable
              {struckCount > 0 ? ` · ${struckCount} struck` : ""}
              {triedTodayCount > 0 ? ` · ${triedTodayCount} tried today` : ""}
            </span>
          </div>
        )}

        {/* ── v14.22 — Stacked phone lines (INACTIVE lines on top, active DIAL button at bottom) ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          {/* Inactive lines first (thumb-reach: keep the big Dial button at the bottom of the stack) */}
          {allPhones.map((p, i) => {
            if (p === activePhone) return null;
            const state = phoneStates[p] || "untried";
            const isStruck = state === "struck";
            const stateLabel = state === "struck" ? "WRONG #" : state === "no_answer_today" ? "NO ANSWER TODAY" : "UNTRIED";
            const stateColor = state === "struck" ? "#6b7280" : state === "no_answer_today" ? "#f97316" : "rgba(200,170,90,0.7)";
            return (
              <div key={p} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "9px 14px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 8, minHeight: 36,
                opacity: isStruck ? 0.35 : 0.55,
              }}>
                <span style={{
                  fontSize: 13, fontWeight: 500,
                  color: "rgba(255,255,255,0.6)",
                  textDecoration: isStruck ? "line-through" : "none",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  Line {i + 1}: {p}
                </span>
                <span style={{
                  fontSize: 9, letterSpacing: "0.14em", fontWeight: 700,
                  color: stateColor,
                }}>
                  {stateLabel}
                </span>
              </div>
            );
          })}
          {/* Big gold Dial button for the active line — anchored at the bottom of the stack */}
          {activePhone && (() => {
            const activeIdx = allPhones.findIndex(p => p === activePhone);
            return (
              <a href={`tel:${activePhone}`} style={{
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: 4, padding: "18px 22px",
                background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                borderRadius: 12, textDecoration: "none",
                color: "#080808", minHeight: 76,
                border: "2px solid #e8c96a",
                boxShadow: "0 6px 24px rgba(200,170,90,0.4), 0 0 0 4px rgba(200,170,90,0.12)",
              }}>
                <span style={{
                  fontSize: 9, letterSpacing: "0.24em", fontWeight: 800,
                  color: "rgba(8,8,8,0.65)",
                }}>
                  DIAL LINE {activeIdx + 1}
                </span>
                <span style={{
                  fontSize: "clamp(1.5rem, 6.5vw, 1.9rem)", fontWeight: 800,
                  letterSpacing: "0.02em", display: "flex", alignItems: "center", gap: 10,
                  lineHeight: 1,
                }}>
                  <Phone size={22} strokeWidth={2.5} /> {activePhone}
                </span>
              </a>
            );
          })()}
        </div>

        {/* v14.28 — 2nd-attempt badge: shows when Flow 1 was previously sent but no contact yet */}
        {emailStatus?.secondAttemptBadge && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "5px 10px", marginBottom: 10,
            background: "rgba(158,197,254,0.12)", border: "1px solid rgba(158,197,254,0.35)",
            borderRadius: 999, fontSize: 11, letterSpacing: "0.08em",
            textTransform: "uppercase", color: "#9ec5fe", fontWeight: 600,
          }}>
            <Mail size={11} /> 2nd email attempt
          </div>
        )}

        {/* v14.22 — Email + Zillow strip (outside the phone stack, below the Dial button) */}
        {/* v14.28 — Adds Flow 3 "Send 2nd Attempt" button when eligible */}
        {(mailtoLink || zillow || emailStatus?.flow3Eligible || (emailStatus?.flow1Sent && !emailStatus?.contactedYet && !emailStatus?.gateOpen)) && (
          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            {mailtoLink && !emailStatus?.flow1Sent && (
              <a
                href={mailtoLink}
                onClick={() => {
                  fetch(`/api/leads/${lead.id}/email-sent`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ agentId: user?.id }),
                  }).then(() => refreshEmailStatus()).catch(() => {});
                }}
                style={{
                  flex: 1, minWidth: 140,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                  padding: "13px 18px",
                  background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 8, textDecoration: "none",
                  fontSize: 13, color: "rgba(255,255,255,0.7)", minHeight: 48,
                }}
              >
                <Mail size={14} /> Email Owner
              </a>
            )}
            {emailStatus?.flow3Eligible && (
              <button
                onClick={() => {
                  if (flow3Sending) return;
                  setFlow3Sending(true);
                  fetch(`/api/leads/${lead.id}/email-flow3`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ agentId: user?.id }),
                  })
                    .then(async r => {
                      const j = await r.json().catch(() => ({}));
                      if (r.ok) {
                        toast({ title: "2nd attempt email sent", description: "+5 pts (email_sent_value). Note pushed to FUB." });
                      } else {
                        toast({ title: "Send failed", description: j.error || r.statusText, variant: "destructive" });
                      }
                      refreshEmailStatus();
                    })
                    .catch(err => toast({ title: "Send failed", description: err?.message || String(err), variant: "destructive" }))
                    .finally(() => setFlow3Sending(false));
                }}
                disabled={flow3Sending}
                style={{
                  flex: 1, minWidth: 140,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                  padding: "13px 18px",
                  background: "linear-gradient(135deg, rgba(158,197,254,0.14) 0%, rgba(158,197,254,0.08) 100%)",
                  border: "1px solid rgba(158,197,254,0.4)", cursor: flow3Sending ? "wait" : "pointer",
                  borderRadius: 8, fontSize: 13, color: "rgba(200,220,255,0.95)",
                  minHeight: 48, fontWeight: 600, letterSpacing: "0.02em",
                  opacity: flow3Sending ? 0.6 : 1,
                }}
              >
                <Mail size={14} /> {flow3Sending ? "Sending\u2026" : "Send 2nd Attempt"}
              </button>
            )}
            {/* v14.34 — Locked 2nd-attempt button with live countdown. */}
            {emailStatus?.flow1Sent && !emailStatus?.contactedYet && !emailStatus?.gateOpen && emailStatus?.unlockAt && (() => {
              const unlockMs = new Date(emailStatus.unlockAt).getTime();
              const remainingSec = Math.max(0, Math.round((unlockMs - nowMs) / 1000));
              const h = Math.floor(remainingSec / 3600);
              const m = Math.floor((remainingSec % 3600) / 60);
              const s = remainingSec % 60;
              const label = h > 0 ? `Available in ${h}h ${m}m` : (m > 0 ? `Available in ${m}m ${s}s` : `Available in ${s}s`);
              return (
                <div
                  aria-disabled="true"
                  title={`Unlocks at ${new Date(emailStatus.unlockAt).toLocaleString()}`}
                  style={{
                    flex: 1, minWidth: 140, textAlign: "center",
                    padding: "13px 18px",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px dashed rgba(200,170,90,0.35)",
                    borderRadius: 8, cursor: "not-allowed",
                    fontSize: 12, color: "rgba(255,255,255,0.55)", minHeight: 48,
                    display: "inline-flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
                  }}
                >
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, letterSpacing: "0.02em" }}>
                    <Mail size={12} /> 2nd attempt — {label}
                  </div>
                  {emailStatus.evidenceConfirmed && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: "rgba(200,170,90,0.85)", letterSpacing: "0.05em" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "rgb(200,170,90)", boxShadow: "0 0 6px rgba(200,170,90,0.6)" }} />
                      Confirmed by FUB
                    </div>
                  )}
                </div>
              );
            })()}
            {zillow && (
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

        {lead.attemptCount > 0 && (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 4 }}>
            {lead.attemptCount} previous attempt{lead.attemptCount !== 1 ? "s" : ""}
          </p>
        )}
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

      {/* v14.20 ── SELLER LPMAMA (6 fields, always visible — no chevron) ── */}
      <div style={{ padding: "0 20px 20px" }}>
        <div style={{
          background: "linear-gradient(180deg, rgba(200,170,90,0.06), rgba(200,170,90,0.02))",
          border: "1px solid rgba(200,170,90,0.22)", borderRadius: 12,
          padding: "14px 14px 12px",
        }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
            <SectionLabel style={{ margin: 0 }}>Seller LPMAMA</SectionLabel>
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

      {/* v14.20 ── ALSO BUYING? Yes/No pill toggle ── */}
      <div style={{ padding: "0 20px 18px" }}>
        <div style={{
          background: alsoBuying ? "rgba(59,130,246,0.08)" : "rgba(255,255,255,0.03)",
          border: `1px solid ${alsoBuying ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.10)"}`,
          borderRadius: 12, padding: "14px 14px",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          transition: "all 0.18s ease",
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.9)" }}>
              Also buying?
            </p>
            <p style={{ margin: "2px 0 0", fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.4 }}>
              If yes, we'll capture Buyer LPMAMA and give both sides service.
            </p>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {[
              { key: false, label: "No",  activeBg: "rgba(148,163,184,0.20)", activeText: "rgb(226,232,240)", activeBorder: "rgba(148,163,184,0.5)" },
              { key: true,  label: "Yes", activeBg: "rgba(59,130,246,0.22)",  activeText: "rgb(147,197,253)", activeBorder: "rgba(59,130,246,0.6)" },
            ].map(opt => {
              const active = alsoBuying === opt.key;
              return (
                <button key={String(opt.key)} onClick={() => setAlsoBuying(opt.key)}
                  style={{
                    minWidth: 60, minHeight: 40,
                    background: active ? opt.activeBg : "rgba(255,255,255,0.03)",
                    border: `1px solid ${active ? opt.activeBorder : "rgba(255,255,255,0.10)"}`,
                    color: active ? opt.activeText : "rgba(255,255,255,0.55)",
                    borderRadius: 999, padding: "8px 16px",
                    fontSize: 12, fontWeight: 700, letterSpacing: "0.06em",
                    cursor: "pointer", transition: "all 0.15s ease",
                  }}
                >{opt.label}</button>
              );
            })}
          </div>
        </div>
      </div>

      {/* v14.20 ── BUYER LPMAMA (conditional on alsoBuying === true) ── */}
      {alsoBuying && (
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
      <div aria-hidden style={{ height: 262 }} />

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
        padding: "8px 12px 8px",
      }}>
        <div style={{ maxWidth: 640, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "repeat(3, 1fr)", gap: 5 }}>
          {OUTCOMES.map(o => {
            const Icon = o.icon;
            const isHovered = hoveredOutcome === o.key;
            return (
              <button key={o.key} onClick={() => handleOutcome(o.key)} disabled={outcomeMutation.isPending}
                onMouseEnter={() => setHoveredOutcome(o.key)} onMouseLeave={() => setHoveredOutcome(null)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
                  padding: "6px 4px",
                  background: isHovered ? o.hoverBg : o.bg,
                  border: `1px solid ${isHovered ? o.text : o.border}`,
                  borderRadius: 9, cursor: "pointer",
                  transition: "all 0.18s ease", minHeight: 46,
                  opacity: outcomeMutation.isPending ? 0.6 : 1,
                }}
              >
                <Icon size={14} style={{ color: o.text }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: o.text, letterSpacing: "0.02em", textAlign: "center", lineHeight: 1.15 }}>{o.label}</span>
              </button>
            );
          })}
        </div>
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

      {/* Recycle confirm sheet */}
      {pendingRecycle && (
        <RecycleModal
          onClose={() => setPendingRecycle(false)}
          onSubmit={handleRecycleSubmit}
          isPending={outcomeMutation.isPending}
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

  const cleanDigits = digits.replace(/\D/g, "");
  const shouldFetch = submitted && cleanDigits.length >= 4;
  const { data, isLoading, isError } = useQuery<any>({
    queryKey: ["/api/leads/callback-lookup", cleanDigits],
    queryFn: () => apiRequest("GET", `/api/leads/callback-lookup?last4=${cleanDigits}`).then(r => r.json()),
    enabled: shouldFetch,
    staleTime: 0,
  });

  const results: any[] = Array.isArray(data?.results) ? data.results : [];

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
                {onPickLead && (
                  <button
                    onClick={() => onPickLead(r.leadId)}
                    style={{
                      marginTop: 10, width: "100%", padding: "9px",
                      background: "linear-gradient(135deg,#c8aa5a,#a8893a)",
                      color: "#0a0700", border: "none", borderRadius: 8,
                      fontSize: 12, fontWeight: 700, letterSpacing: "0.1em",
                      textTransform: "uppercase", cursor: "pointer",
                    }}
                  >Open Lead Card →</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
  // v14.24 — UNIFIED SORT: Appts → Points → Dials. Matches admin leaderboard exactly.
  // Appointments are the #1 goal; points break ties (they already weight appts 10× a dial),
  // total dials are the final tiebreaker.
  const ranked  = stats ? [...stats].sort((a, b) =>
    (b.appointmentsSet - a.appointmentsSet) ||
    ((b.points || 0) - (a.points || 0)) ||
    (b.totalAttempts - a.totalAttempts)
  ) : [];

  // v14.24 — Gap-to-next-rank helper: show "X more appts to catch [Name]" on your own row
  const myRankIdx = ranked.findIndex(s => s.agent.id === user?.id);
  const rankAbove = myRankIdx > 0 ? ranked[myRankIdx - 1] : null;
  const apptsGap  = rankAbove ? Math.max(0, rankAbove.appointmentsSet - (myStats?.appointmentsSet ?? 0)) : 0;
  const pointsGap = rankAbove && apptsGap === 0 ? Math.max(0, (rankAbove.points || 0) - (myStats?.points || 0)) : 0;

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

      {/* ── Personal stats — v14.24: Appts hero (big), then Points, Dials, Emails ── */}
      {myStats && (
        <>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: 8, marginBottom: apptsGap > 0 || pointsGap > 0 ? 10 : 28 }}>
          {[
            { label: "Appts Set",   value: myStats.appointmentsSet,      hero: true },
            { label: "Points",      value: myStats.points ?? 0,           hero: false },
            { label: "Total Calls", value: myStats.totalAttempts,         hero: false },
            { label: "Emails",      value: myStats.emailsSent ?? 0,       hero: false },
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
              }}>{s.value}</p>
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
            {apptsGap > 0
              ? <><strong style={{ color: "#c8aa5a", fontSize: 13 }}>{apptsGap}</strong> more appt{apptsGap === 1 ? "" : "s"} to catch <strong>{rankAbove.agent.name}</strong></>
              : <>Tied on appts — <strong style={{ color: "#c8aa5a", fontSize: 13 }}>{pointsGap}</strong> more point{pointsGap === 1 ? "" : "s"} to pass <strong>{rankAbove.agent.name}</strong></>}
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
              const medalColor = i === 0 ? "#c8aa5a" : i === 1 ? "#9ca3af" : i === 2 ? "#b45309" : null;
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
                  <span style={{ minWidth: 24, textAlign: "center" }}>
                    {medalColor
                      ? <Trophy size={16} style={{ color: medalColor }} />
                      : <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>#{i+1}</span>}
                  </span>
                  {/* v13.9 — headshot or initials */}
                  {(() => {
                    const initials = s.agent.name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
                    const commonStyle = {
                      width: 32, height: 32, borderRadius: "50%",
                      border: `1.5px solid ${medalColor ?? "rgba(255,255,255,0.12)"}`,
                      flexShrink: 0,
                    } as const;
                    if (s.agent.headshotUrl) {
                      return (
                        <img
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
                      <div style={{
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
                  {/* v14.24 — Column order matches admin: APPTS (hero) → PTS → CALLS → EMAILS */}
                  <div style={{ display: "flex", gap: 14, flexShrink: 0, alignItems: "center" }}>
                    <div style={{ textAlign: "right", minWidth: 40 }}>
                      <p style={{ fontSize: 22, fontWeight: 700, color: "#c8aa5a", lineHeight: 1, fontFamily: "'Cormorant Garamond','Georgia',serif" }}>{s.appointmentsSet}</p>
                      <p style={{ fontSize: 9, color: "rgba(200,170,90,0.65)", letterSpacing: "0.12em", marginTop: 3, fontWeight: 700 }}>APPTS</p>
                    </div>
                    <div style={{ textAlign: "right", minWidth: 34 }}>
                      <p style={{ fontSize: 15, fontWeight: 700, color: "#c8aa5a", lineHeight: 1, background: "rgba(200,170,90,0.1)", borderRadius: 6, padding: "2px 6px", display: "inline-block" }}>{s.points ?? 0}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 3 }}>PTS</p>
                    </div>
                    <div style={{ textAlign: "right", minWidth: 30 }}>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "rgba(255,255,255,0.7)", lineHeight: 1 }}>{s.totalAttempts}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 3 }}>CALLS</p>
                    </div>
                    <div style={{ textAlign: "right", minWidth: 30 }}>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "rgba(147,197,253,0.85)", lineHeight: 1 }}>{s.emailsSent ?? 0}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 3 }}>EMAILS</p>
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
// Pipeline interfaces, PipelineCard, and MyLeadsTab removed — see git history.


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
type Tab = "leads" | "leaderboard" | "refer" | "profile";
const NAV: { id: Tab; label: string; icon: typeof Phone }[] = [
  { id: "leaderboard", label: "Dashboard", icon: Trophy },
  { id: "leads",       label: "Dial",      icon: Phone },
  { id: "refer",       label: "Referrals", icon: UserPlus },
  { id: "profile",     label: "Profile",   icon: UserCircle2 },
];

// ─── Main AgentView ───────────────────────────────────────────────────────────
export default function AgentView({ onBackToAdmin, initialTab, mode = "seller" }: { onBackToAdmin?: () => void; initialTab?: Tab; mode?: "seller" | "recruiting" } = {}) {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab ?? "leaderboard");
  const [showTutorial, setShowTutorial] = useState(false);
  useRealtimeUpdates();
  const qc = useQueryClient();
  // v14.50 — pull-to-refresh: swipe down from the very top to refetch every query.
  usePullToRefresh(() => qc.invalidateQueries());

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
  const displayedLead: Lead | null | undefined = overrideLead || nextLead;

  const { data: myQueueData } = useQuery<{ count: number }>({
    queryKey: [`/api/leads/my-count/${user?.id}`],
    queryFn: () => apiRequest("GET", `/api/leads/my-count/${user?.id}`).then(r => r.json()),
    enabled: !!user?.id,
    refetchInterval: 15000,
  });

  const queueCount = myQueueData?.count ?? 0;
  const hasLeads   = queueCount > 0;

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
          <LogoIcon size={26} />
          <div>
            <p style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: 15, fontWeight: 500, letterSpacing: "0.2em",
              color: "#fff", textTransform: "uppercase", lineHeight: 1,
            }}>{mode === "recruiting" ? "Recruiting Depot" : "Lead Depot"}</p>
            <p style={{ fontSize: 11, color: "rgba(200,170,90,0.7)", letterSpacing: "0.08em", marginTop: 2 }}>{user?.name}</p>
          </div>
          {/* v12.5 — admin-only cross-link between Seller ↔ Recruiting */}
          {isAdmin && (
            <a
              href={mode === "recruiting" ? "#/" : "#/recruiting"}
              style={{
                marginLeft: 6, fontSize: 10, color: "rgba(79,184,163,0.85)",
                textDecoration: "none", letterSpacing: "0.1em", textTransform: "uppercase",
                background: "rgba(79,184,163,0.08)",
                border: "1px solid rgba(79,184,163,0.25)",
                borderRadius: 6, padding: "4px 8px", fontWeight: 700,
              }}
            >
              {mode === "recruiting" ? "← Seller" : "Recruiting →"}
            </a>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          <button
            onClick={() => setShowTutorial(true)}
            title="How to use Lead Depot"
            style={{
              width: 32, height: 32, borderRadius: "50%",
              background: "rgba(200,170,90,0.08)", border: "1px solid rgba(200,170,90,0.2)",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", color: "rgba(200,170,90,0.6)",
              fontSize: 13, fontWeight: 700,
            }}
          >?</button>
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
                        {nextAgentLead.attempt_count > 0 && (
                          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>{nextAgentLead.attempt_count} previous dials</span>
                        )}
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
                    <LeadCard lead={displayedLead} />
                  </>
                )}
              </>
            )}
          </div>
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
      <nav style={{
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
          return (
            <button key={n.id} onClick={() => setTab(n.id)} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              gap: 5, padding: "12px 8px 14px",
              background: active ? "rgba(200,170,90,0.07)" : "transparent",
              borderTop: active ? "2px solid #c8aa5a" : "2px solid transparent",
              border: "none", cursor: "pointer",
              position: "relative", transition: "all 0.2s ease",
            }}>
              {showBadge && (
                <span style={{
                  position: "absolute", top: 8, right: "calc(50% - 18px)",
                  width: 8, height: 8, borderRadius: "50%",
                  background: "#c8aa5a", boxShadow: "0 0 7px rgba(200,170,90,0.9)",
                }} />
              )}
              <Icon size={22} style={{ color: active ? "#c8aa5a" : "rgba(255,255,255,0.35)", transition: "color 0.15s" }} />
              <span style={{
                fontSize: 10, letterSpacing: "0.08em",
                color: active ? "#c8aa5a" : "rgba(255,255,255,0.35)",
                fontWeight: active ? 700 : 400,
                transition: "color 0.15s",
              }}>
                {n.label}
              </span>
            </button>
          );
        })}
      </nav>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.85)} }
        input::placeholder, textarea::placeholder { color: rgba(255,255,255,0.25); }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.6) sepia(1) saturate(2) hue-rotate(5deg); }
      `}</style>

      {/* Tutorial modal */}
      {showTutorial && <TutorialModal onClose={() => setShowTutorial(false)} />}
    </div>
  );
}
