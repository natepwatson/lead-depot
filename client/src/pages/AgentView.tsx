import React, { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Phone, PhoneMissed, XCircle,
  CheckCircle2, AlertTriangle, MapPin, Mail, LogOut,
  TrendingUp, ChevronLeft, ScrollText, ChevronDown,
  ChevronUp, Trophy, Users, Send, UserPlus, Heart,
  RefreshCw, Briefcase, Clock, PhoneCall, Star, UserCircle2,
} from "lucide-react";
import ProfilePage from "./ProfilePage";
import TutorialModal from "../components/TutorialModal";
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

// ─── LPMAMAB fields config ────────────────────────────────────────────────────
const LPMAMAB_FIELDS = [
  { key: "location",    label: "L — Location",    color: "#c8aa5a", hint: "Where do they want to go? Area preferences?",           leadField: "lLocation" },
  { key: "price",       label: "P — Price",       color: "#e2d5b0", hint: "What are they thinking price-wise? Ballpark only.",      leadField: "lPricePaid" },
  { key: "motivation",  label: "M — Motivation",  color: "#7ec8e3", hint: "Why are they selling? Divorce, downsizing, job move?",   leadField: "lMotivation" },
  { key: "agent",       label: "A — Agent",       color: "#a8d5a2", hint: "Are they working with an agent already?",                leadField: "lAgentHistory" },
  { key: "mortgage",    label: "M — Mortgage",    color: "#e2d5b0", hint: "Do they have a loan? Paid off? Roughly what's owed?",   leadField: "lMortgage" },
  { key: "appointment", label: "A — Appointment", color: "#c8aa5a", hint: "Are they open to a meeting? Any dates that work?",       leadField: "lAppointment" },
  { key: "buyer",       label: "B — Buyer",       color: "#a8d5a2", hint: "Are they also buying after? What are they looking for?", leadField: "lBuy" },
] as const;

// ─── Outcome configs ───────────────────────────────────────────────────────────
const OUTCOMES = [
  { key: "keep_in_touch",           label: "Keep in Touch", icon: Heart,         bg: "rgba(236,72,153,0.12)",  border: "rgba(236,72,153,0.4)",   text: "rgb(249,168,212)",      hoverBg: "rgba(236,72,153,0.22)" },
  { key: "contacted_appointment",   label: "Appt Set",      icon: CheckCircle2,  bg: "rgba(34,197,94,0.12)",   border: "rgba(34,197,94,0.4)",    text: "rgb(134,239,172)",      hoverBg: "rgba(34,197,94,0.22)" },
  { key: "contacted_not_interested",label: "Not Interested",icon: XCircle,       bg: "rgba(239,68,68,0.12)",   border: "rgba(239,68,68,0.4)",    text: "rgb(252,165,165)",      hoverBg: "rgba(239,68,68,0.22)" },
  { key: "no_answer",               label: "No Answer",     icon: PhoneMissed,   bg: "rgba(234,179,8,0.12)",   border: "rgba(234,179,8,0.4)",    text: "rgb(253,224,71)",       hoverBg: "rgba(234,179,8,0.22)" },
  { key: "wrong_number",            label: "Wrong #",       icon: AlertTriangle, bg: "rgba(239,68,68,0.08)",   border: "rgba(239,68,68,0.25)",   text: "rgba(252,165,165,0.8)", hoverBg: "rgba(239,68,68,0.15)" },
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

function ApptModal({
  lead, outcome, onClose, onSubmit, isPending,
}: {
  lead: Lead;
  outcome: "contacted_appointment" | "keep_in_touch";
  onClose: () => void;
  onSubmit: (data: {
    apptEmail: string; confirmedAddress: string;
    apptDate: string; apptTime: string; stage: string; intention: string;
  }) => void;
  isPending: boolean;
}) {
  const isAppt = outcome === "contacted_appointment";
  const [apptEmail, setApptEmail] = React.useState(lead.email || "");
  const [addressConfirmed, setAddressConfirmed] = React.useState(true);
  const [altAddress, setAltAddress] = React.useState("");
  const [apptDate, setApptDate] = React.useState("");
  const [apptTime, setApptTime] = React.useState("");
  const [stage, setStage] = React.useState<string>("Hot Prospect");
  const [intentions, setIntentions] = React.useState<string[]>([]);

  const toggleIntention = (key: string) => {
    setIntentions(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const confirmedAddress = addressConfirmed ? (lead.address || "") : altAddress;
  const canSubmit = apptEmail.trim() &&
    (addressConfirmed || altAddress.trim()) &&
    (!isAppt || (apptDate && apptTime)) &&
    stage && intentions.length > 0;

  const sourceLabel: Record<string, string> = {
    expired: "Expired Listing", distressed: "Distressed Property",
    website_lead: "Website / Network Lead", fsbo: "FSBO", land: "Land Lead",
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
          onClick={() => onSubmit({ apptEmail, confirmedAddress, apptDate, apptTime, stage, intention: intentions.map(k => INTENTIONS.find(i => i.key === k)?.label || k).join(" + ") })}
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


// ─── Callback Modal ──────────────────────────────────────────────────────────
function CallbackModal({
  onClose, onSubmit, isPending,
}: {
  onClose: () => void;
  onSubmit: (data: { callbackDate: string; callbackTime: string }) => void;
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
          This lead will be immediately returned to the pool and assigned to the next agent in rotation — just like a fresh lead.
        </p>
        <button
          onClick={() => onSubmit({ callbackDate: "", callbackTime: "" })}
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

// ─── Recycle Button ──────────────────────────────────────────────────────────
function RecycleButton({ lead, inGrid = false }: { lead: Lead; inGrid?: boolean }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [notes, setNotes] = useState("");

  const recycleMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/leads/${lead.id}/recycle`, {
        agentId: user?.id,
        notes: notes || "Lead recycled — returned to pool for reassignment.",
      }).then(r => r.json()),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
      qc.invalidateQueries({ queryKey: [`/api/leads/my-count/${user?.id}`] });
      toast({
        title: "Lead recycled",
        description: data.reassignedTo
          ? `Reassigned to ${data.reassignedTo}.`
          : "Returned to pool.",
      });
      setConfirming(false);
    },
    onError: () => toast({ title: "Error recycling lead", variant: "destructive" }),
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(239,68,68,0.3)",
    padding: "10px 12px", borderRadius: 8,
    fontFamily: "'Switzer','Inter',sans-serif", fontSize: 13,
    color: "#fff", outline: "none",
    boxSizing: "border-box" as const, marginTop: 10,
    resize: "none" as const,
  };

  // In-grid mode: render just the button cell (no outer padding wrapper)
  const triggerBtn = (
    <button
      onClick={() => setConfirming(true)}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
        padding: "14px 8px", width: "100%", height: "100%", minHeight: 70,
        background: "rgba(239,68,68,0.06)",
        border: "1px solid rgba(239,68,68,0.25)",
        borderRadius: 10, cursor: "pointer",
        transition: "all 0.18s ease",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.14)"; (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(252,165,165,0.6)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.06)"; (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(239,68,68,0.25)"; }}
    >
      <RefreshCw size={18} style={{ color: "rgba(252,165,165,0.8)" }} />
      <span style={{ fontSize: 10, fontWeight: 600, color: "rgba(252,165,165,0.8)", letterSpacing: "0.03em", textAlign: "center", lineHeight: 1.3 }}>Recycle</span>
    </button>
  );

  return (
    <>
      {inGrid ? triggerBtn : (
        <div style={{ padding: "0 20px 16px" }}>
          <button
            onClick={() => setConfirming(true)}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              padding: "13px", borderRadius: 10, border: "1px solid rgba(239,68,68,0.3)",
              background: "rgba(239,68,68,0.06)", cursor: "pointer",
              fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
              color: "rgba(252,165,165,0.85)", transition: "all 0.18s",
            }}
          >
            <RefreshCw size={14} /> Recycle Lead
          </button>
        </div>
      )}

      {/* Recycle confirm sheet */}
      {confirming && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
          <div onClick={() => setConfirming(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }} />
          <div style={{
            position: "relative", zIndex: 1,
            background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
            border: "1px solid rgba(239,68,68,0.3)", borderBottom: "none",
            borderRadius: "20px 20px 0 0", padding: "28px 22px 48px",
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", margin: "0 auto 22px" }} />
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 24, fontWeight: 400, color: "#fff", margin: 0 }}>
                Recycle Lead
              </h2>
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 5, lineHeight: 1.55 }}>
                This lead will be removed from your queue and reassigned to the next agent in rotation. The dial still counts toward your activity.
              </p>
            </div>
            <div style={{ padding: "12px 16px", background: "rgba(200,170,90,0.07)", border: "1px solid rgba(200,170,90,0.2)", borderRadius: 10, marginBottom: 16 }}>
              <p style={{ fontSize: 14, color: "#fff", margin: "0 0 2px", fontWeight: 600 }}>{lead.ownerName || "Unknown"}</p>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", margin: 0 }}>{lead.address}</p>
            </div>
            <label style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600 }}>
              Reason (optional)
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Connected but they need a different approach…"
              rows={2}
              style={inputStyle}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 20 }}>
              <button
                onClick={() => setConfirming(false)}
                style={{
                  padding: "14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)",
                  background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)",
                  fontSize: 14, fontWeight: 600, cursor: "pointer",
                }}
              >Cancel</button>
              <button
                onClick={() => recycleMutation.mutate()}
                disabled={recycleMutation.isPending}
                style={{
                  padding: "14px", borderRadius: 10, border: "none",
                  background: recycleMutation.isPending ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.85)",
                  color: "#fff", fontSize: 14, fontWeight: 700, cursor: recycleMutation.isPending ? "default" : "pointer",
                }}
              >
                {recycleMutation.isPending ? "Recycling…" : "Confirm Recycle"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Lead card ────────────────────────────────────────────────────────────────
function LeadCard({ lead }: { lead: Lead }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");
  const [showScript, setShowScript] = useState(false);
  const [hoveredOutcome, setHoveredOutcome] = useState<string | null>(null);
  const [pendingOutcome, setPendingOutcome] = useState<"contacted_appointment" | "keep_in_touch" | null>(null);
  const [pendingCallback, setPendingCallback] = useState(false);
  const [lpmOpen, setLpmOpen] = useState(false);
  const [outcomeFlash, setOutcomeFlash] = useState<{ label: string; color: string } | null>(null);
  const [lpmData, setLpmData] = useState<Record<string, string>>({
    location: lead.lLocation ?? "",
    price: lead.lPricePaid ?? "",
    motivation: lead.lMotivation ?? "",
    agent: lead.lAgentHistory ?? "",
    mortgage: lead.lMortgage ?? "",
    appointment: lead.lAppointment ?? "",
    buyer: lead.lBuy ?? "",
  });

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
    callback_requested:       { label: "Callback Scheduled",      color: "#e8af34" },
  };

  const outcomeMutation = useMutation({
    mutationFn: (data: { outcome: string; notes?: string; callbackDate?: string; apptEmail?: string; confirmedAddress?: string; apptDate?: string; apptTime?: string; stage?: string; intention?: string; dialedPhone?: string }) =>
      apiRequest("POST", `/api/leads/${lead.id}/outcome`, { ...data, agentId: user?.id, lpmamab: lpmData }).then(r => r.json()),
    onSuccess: (_data, variables) => {
      // Show success flash for 900ms, then load next lead
      const flash = OUTCOME_FLASH[variables.outcome] ?? { label: "Outcome Logged", color: "#c8aa5a" };
      setOutcomeFlash(flash);
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
    if (key === "callback_requested") {
      setPendingCallback(true);
      return;
    }
    outcomeMutation.mutate({ outcome: key, notes, dialedPhone: activePhone });
  };

  const handleCallbackSubmit = (data: { callbackDate: string; callbackTime: string }) => {
    const callbackDateTime = data.callbackTime
      ? `${data.callbackDate}T${data.callbackTime}`
      : data.callbackDate;
    outcomeMutation.mutate({ outcome: "callback_requested", notes, callbackDate: callbackDateTime });
    setPendingCallback(false);
  };

  const handleApptSubmit = (data: { apptEmail: string; confirmedAddress: string; apptDate: string; apptTime: string; stage: string; intention: string }) => {
    if (!pendingOutcome) return;
    outcomeMutation.mutate({
      outcome: pendingOutcome,
      notes,
      ...data,
    });
    setPendingOutcome(null);
  };

  const zillow = lead.address ? `https://www.zillow.com/homes/${encodeURIComponent(lead.address)}_rb/` : null;
  const emailSubject = encodeURIComponent(`Regarding your property at ${lead.address}`);
  const emailBody = encodeURIComponent(`Hi ${lead.ownerName || "there"},\n\nI wanted to reach out about your property at ${lead.address}. I specialize in helping homeowners in your area and I'd love to connect.\n\nWould you be available for a quick call?\n\nBest,\nBrothers Group Real Estate at Momentum Realty`);
  const mailtoLink = lead.email ? `mailto:${lead.email}?subject=${emailSubject}&body=${emailBody}` : null;

  const typeLabel: Record<string, string> = {
    expired: "Expired", distressed: "Distressed", website_lead: "Website",
    fsbo: "FSBO", land: "Land",
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
        <span style={{
          fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase",
          color: "#c8aa5a", fontWeight: 700,
        }}>
          {typeLabel[lead.leadType] || lead.leadType}
        </span>
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
            marginBottom: 18, lineHeight: 1.4,
          }}>
            <MapPin size={13} style={{ marginTop: 1, flexShrink: 0, color: "#c8aa5a" }} />
            {lead.address}
          </p>
        )}

        {/* ── Contact row ── */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          {/* Multi-number phone display */}
          <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {activePhone && (
              <a href={`tel:${activePhone}`} style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "13px 22px",
                background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                borderRadius: 8, textDecoration: "none",
                fontSize: 15, fontWeight: 700, letterSpacing: "0.03em",
                color: "#080808", justifyContent: "center", minHeight: 48,
                boxShadow: "0 4px 16px rgba(200,170,90,0.3)",
              }}>
                <Phone size={15} /> {activePhone}
              </a>
            )}
            {allPhones.length > 1 && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", paddingLeft: 2 }}>
                {allPhones.map((p, i) => {
                  const state = phoneStates[p] || "untried";
                  const isActive = p === activePhone;
                  const dotColor = state === "struck" ? "#6b7280" : state === "no_answer_today" ? "#f97316" : isActive ? "#c8aa5a" : "rgba(255,255,255,0.2)";
                  const dotLabel = state === "struck" ? "✕" : state === "no_answer_today" ? "~" : `${i + 1}`;
                  const title = state === "struck" ? `${p} — wrong # (struck)` : state === "no_answer_today" ? `${p} — tried today` : isActive ? `${p} — calling now` : `${p} — untried`;
                  return (
                    <span key={p} title={title} style={{
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      width: 22, height: 22, borderRadius: "50%", fontSize: 10, fontWeight: 700,
                      border: `1.5px solid ${dotColor}`, color: dotColor,
                      background: isActive ? "rgba(200,170,90,0.15)" : "transparent", flexShrink: 0,
                    }}>{dotLabel}</span>
                  );
                })}
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>
                  {remainingCount}/{allPhones.length} viable
                  {struckCount > 0 ? ` · ${struckCount} struck` : ""}
                  {triedTodayCount > 0 ? ` · ${triedTodayCount} tried today` : ""}
                </span>
              </div>
            )}
          </div>
          {mailtoLink && (
            <a
              href={mailtoLink}
              onClick={() => {
                // Log email sent activity
                fetch(`/api/leads/${lead.id}/email-sent`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ agentId: user?.id }),
                }).catch(() => {});
              }}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "13px 18px",
                background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 8, textDecoration: "none",
                fontSize: 13, color: "rgba(255,255,255,0.7)", minHeight: 48,
              }}
            >
              <Mail size={14} /> Email
            </a>
          )}
          {zillow && (
            <a href={zillow} target="_blank" rel="noopener noreferrer" style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "13px 18px",
              background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.3)",
              borderRadius: 8, textDecoration: "none",
              fontSize: 13, color: "rgba(147,197,253,0.9)", minHeight: 48,
            }}>
              <TrendingUp size={13} /> Zillow
            </a>
          )}
        </div>

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

      {/* ── Script (inline) ── */}
      <div style={{ borderTop: "1px solid rgba(200,170,90,0.15)", padding: "18px 20px 0" }}>
        <SectionLabel>Call Script</SectionLabel>
        <pre style={{
          fontSize: 12, color: "rgba(255,255,255,0.7)", whiteSpace: "pre-wrap", lineHeight: 1.7,
          fontFamily: "'Switzer','Inter',sans-serif",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(200,170,90,0.15)", borderRadius: 8, padding: "14px",
          maxHeight: 220, overflowY: "auto", marginBottom: 18,
        }}>
          {script?.content || "No script saved for this lead type."}
        </pre>
      </div>

      {/* ── Notes ── */}
      <div style={{ padding: "0 20px 18px" }}>
        <SectionLabel>Call Notes</SectionLabel>
        <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Enter call notes…"
          className="min-h-[80px] text-sm leading-relaxed resize-none"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(200,170,90,0.2)",
            color: "rgba(255,255,255,0.85)",
            fontFamily: "'Switzer','Inter',sans-serif",
            borderRadius: 8,
          }}
        />
      </div>

      {/* ── LPMAMAB ── */}
      <div style={{ padding: "0 20px 18px" }}>
        <button
          onClick={() => setLpmOpen(o => !o)}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: lpmOpen ? 14 : 0,
          }}
        >
          <SectionLabel style={{ margin: 0 }}>LPMAMAB Notes</SectionLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {Object.values(lpmData).some(v => v.trim()) && (
              <span style={{ fontSize: 9, letterSpacing: "0.12em", color: "#c8aa5a", background: "rgba(200,170,90,0.12)", padding: "2px 7px", borderRadius: 99 }}>
                FILLED
              </span>
            )}
            <ChevronDown size={14} style={{ color: "rgba(200,170,90,0.5)", transform: lpmOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
          </div>
        </button>
        {lpmOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {LPMAMAB_FIELDS.map(f => (
              <div key={f.key}>
                <label style={{ display: "block", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: f.color, fontWeight: 700, marginBottom: 5, opacity: 0.8 }}>{f.label}</label>
                <input
                  value={lpmData[f.key] ?? ""}
                  onChange={e => setLpmData(d => ({ ...d, [f.key]: e.target.value }))}
                  placeholder={f.hint}
                  style={{
                    width: "100%",
                    background: "rgba(255,255,255,0.04)",
                    border: `1px solid ${lpmData[f.key]?.trim() ? f.color + "55" : "rgba(255,255,255,0.1)"}`,
                    padding: "9px 12px", borderRadius: 7,
                    color: "#fff", fontSize: 13,
                    fontFamily: "'Switzer','Inter',sans-serif",
                    outline: "none", boxSizing: "border-box" as const,
                    transition: "border-color 0.15s",
                  }}
                />
              </div>
            ))}
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", lineHeight: 1.5, margin: "4px 0 0" }}>
              These are conversational notes — rough ballparks, not confirmed numbers. Real details get locked in at the appointment.
            </p>
          </div>
        )}
      </div>

      <GoldDivider />

      {/* ── Outcome buttons + Recycle (symmetrical 3×2 grid) ── */}
      <div style={{ padding: "0 20px 24px" }}>
        <SectionLabel>Log Outcome</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9 }}>
          {OUTCOMES.map(o => {
            const Icon = o.icon;
            const isHovered = hoveredOutcome === o.key;
            return (
              <button key={o.key} onClick={() => handleOutcome(o.key)} disabled={outcomeMutation.isPending}
                onMouseEnter={() => setHoveredOutcome(o.key)} onMouseLeave={() => setHoveredOutcome(null)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                  padding: "14px 8px",
                  background: isHovered ? o.hoverBg : o.bg,
                  border: `1px solid ${isHovered ? o.text : o.border}`,
                  borderRadius: 10, cursor: "pointer",
                  transition: "all 0.18s ease", minHeight: 70,
                  opacity: outcomeMutation.isPending ? 0.6 : 1,
                }}
              >
                <Icon size={18} style={{ color: o.text }} />
                <span style={{ fontSize: 10, fontWeight: 600, color: o.text, letterSpacing: "0.03em", textAlign: "center", lineHeight: 1.3 }}>{o.label}</span>
              </button>
            );
          })}
          {/* Recycle — 6th cell, completing the 3×2 grid */}
          <RecycleButton lead={lead} inGrid />
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

      {/* Callback modal */}
      {pendingCallback && (
        <CallbackModal
          onClose={() => setPendingCallback(false)}
          onSubmit={handleCallbackSubmit}
          isPending={outcomeMutation.isPending}
        />
      )}
    </div>
  );
}

// ─── Leaderboard Tab ──────────────────────────────────────────────────────────
interface AgentStat {
  agent: { id: number; name: string; email: string };
  appointmentsSet: number;
  totalAttempts: number;
  contactRate: number;
  outcomes: Record<string, number>;
}

function LeaderboardTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [netName, setNetName]   = useState("");
  const [netPhone, setNetPhone] = useState("");
  const [netEmail, setNetEmail] = useState("");
  const [netAddr, setNetAddr]   = useState("");
  const [netNotes, setNetNotes] = useState("");
  const [netSending, setNetSending] = useState(false);

  const { data: stats, isLoading } = useQuery<AgentStat[]>({
    queryKey: ["/api/agent/leaderboard"],
    queryFn: () => apiRequest("GET", "/api/agent/leaderboard").then(r => r.json()),
    refetchInterval: 60000,
  });

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
  const ranked  = stats ? [...stats].sort((a, b) => b.appointmentsSet - a.appointmentsSet || b.totalAttempts - a.totalAttempts) : [];

  return (
    <div style={{ width: "100%", padding: "0 0 20px" }}>

      {/* ── Personal stats ── */}
      {myStats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 28 }}>
          {[
            { label: "Appts Set",   value: myStats.appointmentsSet },
            { label: "Total Calls", value: myStats.totalAttempts },
            { label: "Emails Sent", value: myStats.emailsSent ?? 0 },
            { label: "Contact %",   value: `${myStats.contactRate}%` },
          ].map(s => (
            <div key={s.label} style={{
              padding: "14px 8px", textAlign: "center",
              background: "linear-gradient(135deg, rgba(200,170,90,0.1) 0%, rgba(200,170,90,0.04) 100%)",
              border: "1px solid rgba(200,170,90,0.28)",
              borderRadius: 12,
              boxShadow: "0 2px 12px rgba(200,170,90,0.08)",
            }}>
              <p style={{
                fontSize: 26, fontWeight: 600, color: "#c8aa5a",
                fontFamily: "'Cormorant Garamond','Georgia',serif", lineHeight: 1,
              }}>{s.value}</p>
              <p style={{
                fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase",
                color: "rgba(255,255,255,0.45)", marginTop: 6,
              }}>{s.label}</p>
            </div>
          ))}
        </div>
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
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                      fontSize: 14, fontWeight: isMe ? 700 : 500,
                      color: isMe ? "#c8aa5a" : "#fff",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {s.agent.name}{isMe ? " (you)" : ""}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 14, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ fontSize: 17, fontWeight: 700, color: "#c8aa5a", lineHeight: 1 }}>{s.appointmentsSet}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 2 }}>APPTS</p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ fontSize: 17, fontWeight: 600, color: "rgba(255,255,255,0.7)", lineHeight: 1 }}>{s.totalAttempts}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 2 }}>CALLS</p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ fontSize: 17, fontWeight: 600, color: "rgba(147,197,253,0.85)", lineHeight: 1 }}>{s.emailsSent ?? 0}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 2 }}>EMAILS</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Network lead ── */}
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
    </div>
  );
}


// ─── My Leads Tab ─────────────────────────────────────────────────────────────
interface PipelineLead extends Lead {
  lastNote: string | null;
  activityCount: number;
  emailCount: number;
}

interface PipelineData {
  callbacks: PipelineLead[];
  kitLeads: PipelineLead[];
  appointments: PipelineLead[];
}

const SOURCE_LABEL: Record<string, string> = {
  expired: "Expired", distressed: "Distressed", website_lead: "Website/Network",
  fsbo: "FSBO", land: "Land",
};

function PipelineCard({ lead, type }: { lead: PipelineLead; type: "callback" | "kit" | "appt" }) {
  const isCallback = type === "callback";
  const isAppt = type === "appt";
  const accent = isCallback ? "rgb(103,232,249)" : isAppt ? "rgb(134,239,172)" : "rgb(249,168,212)";
  const accentBg = isCallback ? "rgba(34,211,238,0.08)" : isAppt ? "rgba(34,197,94,0.08)" : "rgba(236,72,153,0.08)";
  const accentBorder = isCallback ? "rgba(34,211,238,0.25)" : isAppt ? "rgba(34,197,94,0.25)" : "rgba(236,72,153,0.25)";

  const callbackDt = lead.callbackDate ? (() => {
    const d = new Date(lead.callbackDate);
    if (isNaN(d.getTime())) return lead.callbackDate;
    return d.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: "America/New_York",
    });
  })() : null;

  const isPast = lead.callbackDate
    ? lead.callbackDate <= new Date().toISOString().slice(0, 10)
    : false;

  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(20,20,20,0.98) 0%, rgba(12,12,12,0.98) 100%)",
      border: `1px solid ${accentBorder}`,
      borderRadius: 14, overflow: "hidden",
      boxShadow: "0 2px 16px rgba(0,0,0,0.4)",
    }}>
      {/* Header bar */}
      <div style={{
        background: accentBg, borderBottom: `1px solid ${accentBorder}`,
        padding: "10px 16px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isCallback
            ? <Clock size={13} style={{ color: accent }} />
            : isAppt
              ? <CheckCircle2 size={13} style={{ color: accent }} />
              : <Star size={13} style={{ color: accent }} />}
          <span style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: accent, fontWeight: 700 }}>
            {isCallback ? "Callback" : isAppt ? "Appointment Set" : "Keep in Touch"}
          </span>
        </div>
        <span style={{
          fontSize: 10, color: "rgba(255,255,255,0.35)",
          background: "rgba(255,255,255,0.05)", borderRadius: 6, padding: "3px 8px",
        }}>
          {SOURCE_LABEL[lead.leadType] || lead.leadType}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: "14px 16px" }}>
        <p style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: 18, fontWeight: 400, color: "#fff", margin: "0 0 2px",
        }}>{lead.ownerName || "Unknown"}</p>
        {lead.address && (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", margin: "0 0 12px", display: "flex", alignItems: "center", gap: 5 }}>
            <MapPin size={11} /> {lead.address}
          </p>
        )}

        {/* Contact row */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {lead.phone && (
            <a href={`tel:${lead.phone}`} style={{
              display: "flex", alignItems: "center", gap: 5, fontSize: 12,
              color: "rgba(255,255,255,0.7)", textDecoration: "none",
              background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8, padding: "6px 10px",
            }}>
              <PhoneCall size={12} style={{ color: "#c8aa5a" }} /> {lead.phone}
            </a>
          )}
          {lead.email && (
            <a href={`mailto:${lead.email}`} style={{
              display: "flex", alignItems: "center", gap: 5, fontSize: 12,
              color: "rgba(255,255,255,0.7)", textDecoration: "none",
              background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8, padding: "6px 10px",
            }}>
              <Mail size={12} style={{ color: "#c8aa5a" }} /> Email
            </a>
          )}
        </div>

        {/* Callback date */}
        {isCallback && callbackDt && (
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "8px 12px", borderRadius: 8, marginBottom: 10,
            background: isPast ? "rgba(239,68,68,0.1)" : "rgba(34,211,238,0.07)",
            border: `1px solid ${isPast ? "rgba(239,68,68,0.3)" : "rgba(34,211,238,0.2)"}`,
          }}>
            <Calendar size={13} style={{ color: isPast ? "#f87171" : accent, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: isPast ? "#f87171" : accent, fontWeight: 600 }}>
              {isPast ? "OVERDUE — " : ""}{callbackDt}
            </span>
          </div>
        )}

        {/* Last note */}
        {lead.lastNote && (
          <div style={{
            padding: "8px 12px", borderRadius: 8, marginBottom: 10,
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
          }}>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", margin: 0, lineHeight: 1.5, fontStyle: "italic" }}>
              "{lead.lastNote}"
            </p>
          </div>
        )}

        {/* Stats row */}
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", display: "flex", alignItems: "center", gap: 4 }}>
            <Phone size={10} /> {lead.activityCount} call{lead.activityCount !== 1 ? "s" : ""}
          </div>
          {lead.emailCount > 0 && (
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", display: "flex", alignItems: "center", gap: 4 }}>
              <Mail size={10} /> {lead.emailCount} email{lead.emailCount !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MyLeadsTab() {
  const { user } = useAuth();

  const { data, isLoading, refetch } = useQuery<PipelineData>({
    queryKey: ["/api/leads/my-pipeline", user?.id],
    queryFn: () => apiRequest("GET", `/api/leads/my-pipeline/${user?.id}`).then(r => r.json()),
    refetchInterval: 60000,
    enabled: !!user?.id,
  });

  const callbacks    = data?.callbacks    || [];
  const kitLeads     = data?.kitLeads     || [];
  const appointments = data?.appointments || [];
  const total = callbacks.length + kitLeads.length + appointments.length;

  if (isLoading) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "8px 0" }}>
      {[1,2,3].map(i => <div key={i} style={{ height: 140, borderRadius: 14, background: "rgba(255,255,255,0.04)" }} />)}
    </div>
  );

  return (
    <div style={{ padding: "0 0 24px" }}>

      {/* ── Summary bar ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 24 }}>
        <div style={{
          padding: "14px 8px", textAlign: "center", borderRadius: 12,
          background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.22)",
        }}>
          <p style={{ fontSize: 26, fontWeight: 600, color: "rgb(134,239,172)", fontFamily: "'Cormorant Garamond','Georgia',serif", lineHeight: 1, margin: 0 }}>
            {appointments.length}
          </p>
          <p style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginTop: 6 }}>
            Appts
          </p>
        </div>
        <div style={{
          padding: "14px 8px", textAlign: "center", borderRadius: 12,
          background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.22)",
        }}>
          <p style={{ fontSize: 26, fontWeight: 600, color: "rgb(103,232,249)", fontFamily: "'Cormorant Garamond','Georgia',serif", lineHeight: 1, margin: 0 }}>
            {callbacks.length}
          </p>
          <p style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginTop: 6 }}>
            Callbacks
          </p>
        </div>
        <div style={{
          padding: "14px 8px", textAlign: "center", borderRadius: 12,
          background: "rgba(236,72,153,0.08)", border: "1px solid rgba(236,72,153,0.22)",
        }}>
          <p style={{ fontSize: 26, fontWeight: 600, color: "rgb(249,168,212)", fontFamily: "'Cormorant Garamond','Georgia',serif", lineHeight: 1, margin: 0 }}>
            {kitLeads.length}
          </p>
          <p style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginTop: 6 }}>
            Connected
          </p>
        </div>
      </div>

      {total === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 24px" }}>
          <Briefcase size={36} style={{ color: "rgba(200,170,90,0.3)", margin: "0 auto 16px" }} />
          <p style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.4rem", fontWeight: 300, color: "rgba(255,255,255,0.6)", marginBottom: 8 }}>
            Your pipeline is empty
          </p>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", lineHeight: 1.6 }}>
            Appointments, callbacks, and keep-in-touch leads appear here for 60 days.
          </p>
        </div>
      ) : (
        <>
          {/* ── Appointments ── */}
          {appointments.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(134,239,172,0.7)", marginBottom: 12, fontWeight: 600 }}>
                Appointments Set
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {appointments.map(l => <PipelineCard key={l.id} lead={l} type="appt" />)}
              </div>
            </div>
          )}

          {/* ── Callbacks ── */}
          {callbacks.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(103,232,249,0.7)", marginBottom: 12, fontWeight: 600 }}>
                Callback Schedule
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {callbacks.map(l => <PipelineCard key={l.id} lead={l} type="callback" />)}
              </div>
            </div>
          )}

          {/* ── Keep in Touch ── */}
          {kitLeads.length > 0 && (
            <div>
              <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(249,168,212,0.7)", marginBottom: 12, fontWeight: 600 }}>
                Connected Leads
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {kitLeads.map(l => <PipelineCard key={l.id} lead={l} type="kit" />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Referral Tab ─────────────────────────────────────────────────────────────
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
type Tab = "leads" | "leaderboard" | "refer" | "my-leads" | "profile";
const NAV: { id: Tab; label: string; icon: typeof Phone }[] = [
  { id: "leaderboard", label: "Dashboard", icon: Trophy },
  { id: "leads",       label: "Dial",      icon: Phone },
  { id: "my-leads",    label: "My Leads",  icon: Briefcase },
  { id: "refer",       label: "Refer",     icon: UserPlus },
  { id: "profile",     label: "Profile",   icon: UserCircle2 },
];

// ─── Main AgentView ───────────────────────────────────────────────────────────
export default function AgentView({ onBackToAdmin, initialTab }: { onBackToAdmin?: () => void; initialTab?: Tab } = {}) {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab ?? "leaderboard");
  const [showTutorial, setShowTutorial] = useState(false);
  useRealtimeUpdates();

  const { data: nextLead, isLoading: leadLoading } = useQuery<Lead | null>({
    queryKey: ["/api/leads/my-next"],
    queryFn: () =>
      apiRequest("GET", `/api/leads/my-next?agentId=${user?.id}`).then(async r => {
        if (r.status === 204) return null;
        return r.json();
      }),
    enabled: !!user?.id,
  });

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
    if (nextLead?.id) {
      mainRef.current?.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [nextLead?.id]);

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
            }}>Lead Depot</p>
            <p style={{ fontSize: 11, color: "rgba(200,170,90,0.7)", letterSpacing: "0.08em", marginTop: 2 }}>{user?.name}</p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

      {/* ── Leads notification banner ── */}
      {hasLeads && tab !== "leads" && (
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
        {tab === "leaderboard" && <LeaderboardTab />}

        {tab === "leads" && (
          <div>
            {leadLoading ? (
              <div>
                <Skeleton className="h-[480px] w-full rounded-2xl" style={{ background: "rgba(200,170,90,0.05)" }} />
              </div>
            ) : !nextLead ? (
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
                }}>{onBackToAdmin ? "No Leads Assigned" : "Queue Complete"}</h2>
                <p style={{ fontSize: 14, color: "rgba(255,255,255,0.45)", lineHeight: 1.65 }}>
                  {onBackToAdmin
                    ? "Your admin account has no leads assigned to it as an agent. Leads are distributed to your agent team."
                    : "You've worked through all your assigned leads. Check back soon for new assignments."}
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
              <LeadCard lead={nextLead} />
            )}
          </div>
        )}

        {tab === "my-leads" && <MyLeadsTab />}
        {tab === "refer" && <ReferralTab />}
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
        {NAV.map(n => {
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
