import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Phone, PhoneOff, PhoneMissed, Calendar, XCircle,
  CheckCircle2, AlertTriangle, MapPin, Mail, LogOut,
  TrendingUp, ChevronLeft, ScrollText, ChevronDown,
  ChevronUp, Trophy, Users, Send, UserPlus,
} from "lucide-react";
import type { Lead } from "@shared/schema";

// ─── Logo ─────────────────────────────────────────────────────────────────────
function LogoIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-label="Lead Depot">
      <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.4"/>
      <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
      <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.2"/>
    </svg>
  );
}

// ─── LPMAMAB phrases ──────────────────────────────────────────────────────────
const LPMAMAB_PHRASES = [
  { key: "listen",      label: "LISTEN", color: "#c8aa5a",              desc: "Let them speak fully without interrupting" },
  { key: "pause",       label: "PAUSE",  color: "rgba(255,255,255,0.7)", desc: "3-second silence after they finish" },
  { key: "mirror",      label: "MIRROR", color: "#7ec8e3",              desc: "Repeat their last 2–3 words as a question" },
  { key: "acknowledge", label: "ACK",    color: "#a8d5a2",              desc: "Validate their feelings without agreeing" },
  { key: "minimum",     label: "MIN",    color: "rgba(255,255,255,0.55)",desc: "Ask for the minimum, not the maximum" },
  { key: "ask",         label: "ASK",    color: "#c8aa5a",              desc: "One open-ended question at a time" },
  { key: "bookmark",    label: "BKMK",   color: "rgba(255,255,255,0.45)",desc: "\"That's important — let me note that\"" },
];

// ─── Outcome configs ───────────────────────────────────────────────────────────
const OUTCOMES = [
  { key: "no_answer",               label: "No Answer",     icon: PhoneMissed,   bg: "rgba(234,179,8,0.08)",   border: "rgba(234,179,8,0.22)",   text: "rgb(253,224,71)",       hoverBg: "rgba(234,179,8,0.15)" },
  { key: "left_voicemail",          label: "Left Voicemail",icon: PhoneOff,      bg: "rgba(167,139,250,0.08)", border: "rgba(167,139,250,0.22)", text: "rgb(196,181,253)",      hoverBg: "rgba(167,139,250,0.15)" },
  { key: "callback_requested",      label: "Callback",      icon: Calendar,      bg: "rgba(34,211,238,0.08)",  border: "rgba(34,211,238,0.22)",  text: "rgb(103,232,249)",      hoverBg: "rgba(34,211,238,0.15)" },
  { key: "contacted_appointment",   label: "Appt Set",      icon: CheckCircle2,  bg: "rgba(34,197,94,0.08)",   border: "rgba(34,197,94,0.22)",   text: "rgb(134,239,172)",      hoverBg: "rgba(34,197,94,0.15)" },
  { key: "contacted_not_interested",label: "Not Interested",icon: XCircle,       bg: "rgba(239,68,68,0.08)",   border: "rgba(239,68,68,0.22)",   text: "rgb(252,165,165)",      hoverBg: "rgba(239,68,68,0.15)" },
  { key: "wrong_number",            label: "Wrong #",       icon: AlertTriangle, bg: "rgba(239,68,68,0.05)",   border: "rgba(239,68,68,0.15)",   text: "rgba(252,165,165,0.7)", hoverBg: "rgba(239,68,68,0.1)" },
] as const;

// ─── Lead card ────────────────────────────────────────────────────────────────
function LeadCard({ lead }: { lead: Lead }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");
  const [callbackDate, setCallbackDate] = useState(lead.callbackDate || "");
  const [showScript, setShowScript] = useState(false);
  const [hoveredOutcome, setHoveredOutcome] = useState<string | null>(null);

  const extra = (() => { try { return JSON.parse(lead.extraData || "{}"); } catch { return {}; } })();

  const { data: script } = useQuery<{ content: string }>({
    queryKey: ["/api/scripts", lead.leadType],
    queryFn: () => apiRequest("GET", `/api/scripts/${lead.leadType}`).then(r => r.json()),
    staleTime: 60000,
  });

  const outcomeMutation = useMutation({
    mutationFn: (data: { outcome: string; notes?: string; callbackDate?: string }) =>
      apiRequest("POST", `/api/leads/${lead.id}/outcome`, { ...data, agentId: user?.id }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
      qc.invalidateQueries({ queryKey: [`/api/leads/my-count/${user?.id}`] });
      qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
      toast({ title: "Outcome recorded", description: "Next lead loaded." });
    },
    onError: () => toast({ title: "Error saving outcome", variant: "destructive" }),
  });

  const handleOutcome = (key: string) => {
    if (key === "callback_requested" && !callbackDate) {
      toast({ title: "Select callback date", description: "Pick a date before marking Callback.", variant: "destructive" });
      return;
    }
    outcomeMutation.mutate({ outcome: key, notes, callbackDate: key === "callback_requested" ? callbackDate : undefined });
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
      background: "linear-gradient(135deg, #0f0f0f 0%, #0a0a0a 100%)",
      border: "1px solid rgba(200,170,90,0.18)",
      borderRadius: 12, overflow: "hidden",
      maxWidth: 560, width: "100%", margin: "0 auto",
    }}>
      {/* Type bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 20px", borderBottom: "1px solid rgba(255,255,255,0.05)",
        background: "rgba(200,170,90,0.04)",
      }}>
        <span style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,170,90,0.8)" }}>
          {typeLabel[lead.leadType] || lead.leadType}
        </span>
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: "0.06em" }}>
          LEAD #{lead.id}
        </span>
      </div>

      {/* Lead info */}
      <div style={{ padding: "24px 24px 18px" }}>
        <h2 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "clamp(1.5rem,3.5vw,2rem)", fontWeight: 300,
          color: "#fff", letterSpacing: "-0.01em", marginBottom: 4,
        }}>
          {lead.ownerName || "Unknown Owner"}
        </h2>
        {lead.address && (
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", display: "flex", alignItems: "flex-start", gap: 5, marginBottom: 16, lineHeight: 1.4 }}>
            <MapPin size={12} style={{ marginTop: 2, flexShrink: 0, color: "rgba(200,170,90,0.6)" }} />
            {lead.address}
          </p>
        )}

        {/* Contact row */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          {lead.phone && (
            <a href={`tel:${lead.phone}`} style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "11px 20px",
              background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
              borderRadius: 4, textDecoration: "none",
              fontSize: 14, fontWeight: 600, letterSpacing: "0.04em",
              color: "#080808", flex: "1 1 auto", justifyContent: "center", minHeight: 44,
            }}>
              <Phone size={14} /> {lead.phone}
            </a>
          )}
          {mailtoLink && (
            <a href={mailtoLink} style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "11px 16px",
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 4, textDecoration: "none",
              fontSize: 12, color: "rgba(255,255,255,0.55)", minHeight: 44,
            }}>
              <Mail size={13} /> Email
            </a>
          )}
          {zillow && (
            <a href={zillow} target="_blank" rel="noopener noreferrer" style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "11px 16px",
              background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)",
              borderRadius: 4, textDecoration: "none",
              fontSize: 12, color: "rgba(147,197,253,0.8)", minHeight: 44,
            }}>
              <TrendingUp size={12} /> Zillow
            </a>
          )}
        </div>

        {/* Motivation */}
        {lead.motivation && (
          <div style={{
            padding: "10px 14px", marginBottom: 14,
            background: "rgba(234,179,8,0.05)", border: "1px solid rgba(234,179,8,0.12)",
            borderRadius: 6, display: "flex", gap: 8, alignItems: "flex-start",
          }}>
            <AlertTriangle size={12} style={{ color: "rgba(234,179,8,0.7)", marginTop: 1, flexShrink: 0 }} />
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>{lead.motivation}</p>
          </div>
        )}

        {/* Extra details */}
        {(extra.county || extra.propertyType || extra.estimatedValue || extra.timeframe) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", marginBottom: 14 }}>
            {extra.county && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>County: <span style={{ color: "rgba(255,255,255,0.55)" }}>{extra.county}</span></p>}
            {extra.propertyType && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>Type: <span style={{ color: "rgba(255,255,255,0.55)" }}>{extra.propertyType}</span></p>}
            {extra.estimatedValue && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>Est. Value: <span style={{ color: "rgba(200,170,90,0.7)" }}>{extra.estimatedValue}</span></p>}
            {extra.timeframe && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>Timeframe: <span style={{ color: "rgba(255,255,255,0.55)" }}>{extra.timeframe}</span></p>}
          </div>
        )}

        {lead.attemptCount > 0 && (
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginBottom: 14 }}>
            {lead.attemptCount} previous attempt{lead.attemptCount !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {/* LPMAMAB */}
      <div style={{ margin: "0 24px 16px", padding: "12px 16px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8 }}>
        <p style={{ fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 10 }}>LPMAMAB Framework</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {LPMAMAB_PHRASES.map(p => (
            <div key={p.key} title={p.desc} style={{ padding: "4px 10px", borderRadius: 3, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", cursor: "default" }}>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", color: p.color }}>{p.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Callback date */}
      <div style={{ padding: "0 24px 16px" }}>
        <label style={{ display: "block", fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 7 }}>
          Callback Date (required for Callback outcome)
        </label>
        <input type="date" value={callbackDate} onChange={e => setCallbackDate(e.target.value)}
          style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", padding: "10px 14px", borderRadius: 4, fontFamily: "'Switzer','Inter',sans-serif", fontSize: 13, color: "#fff", outline: "none", colorScheme: "dark" }}
        />
      </div>

      {/* Notes */}
      <div style={{ padding: "0 24px 16px" }}>
        <label style={{ display: "block", fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 7 }}>
          Call Notes
        </label>
        <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Enter call notes…"
          className="min-h-[80px] text-xs leading-relaxed resize-none"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.8)", fontFamily: "'Switzer','Inter',sans-serif" }}
        />
      </div>

      {/* Outcome buttons */}
      <div style={{ padding: "0 24px 24px" }}>
        <p style={{ fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 10 }}>Log Outcome</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {OUTCOMES.map(o => {
            const Icon = o.icon;
            const isHovered = hoveredOutcome === o.key;
            return (
              <button key={o.key} onClick={() => handleOutcome(o.key)} disabled={outcomeMutation.isPending}
                onMouseEnter={() => setHoveredOutcome(o.key)} onMouseLeave={() => setHoveredOutcome(null)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "12px 8px",
                  background: isHovered ? o.hoverBg : o.bg, border: `1px solid ${isHovered ? o.text : o.border}`,
                  borderRadius: 6, cursor: "pointer", transition: "all 0.18s ease", minHeight: 64,
                  opacity: outcomeMutation.isPending ? 0.6 : 1,
                }}
              >
                <Icon size={16} style={{ color: o.text }} />
                <span style={{ fontSize: 10, fontWeight: 500, color: o.text, letterSpacing: "0.04em", textAlign: "center" }}>{o.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Script panel */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <button onClick={() => setShowScript(s => !s)}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", background: "transparent", border: "none", cursor: "pointer" }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)" }}>
            <ScrollText size={12} style={{ color: "rgba(200,170,90,0.6)" }} /> Call Script
          </span>
          {showScript ? <ChevronUp size={14} style={{ color: "rgba(255,255,255,0.3)" }} /> : <ChevronDown size={14} style={{ color: "rgba(255,255,255,0.3)" }} />}
        </button>
        {showScript && (
          <div style={{ padding: "0 24px 24px" }}>
            <pre style={{
              fontSize: 12, color: "rgba(255,255,255,0.6)", whiteSpace: "pre-wrap", lineHeight: 1.7,
              fontFamily: "'DM Mono',monospace", background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, padding: "16px",
              maxHeight: 380, overflowY: "auto",
            }}>
              {script?.content || "No script saved for this lead type."}
            </pre>
          </div>
        )}
      </div>
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

  // Network lead form state
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
        ownerName: netName.trim(),
        phone: netPhone.trim(),
        email: netEmail.trim(),
        address: netAddr.trim(),
        notes: netNotes.trim(),
        submittedBy: user?.id,
        submittedByName: user?.name,
      });
      setNetName(""); setNetPhone(""); setNetEmail(""); setNetAddr(""); setNetNotes("");
      qc.invalidateQueries({ queryKey: ["/api/leads/my-count"] });
      toast({ title: "Network lead submitted", description: "Admins have been notified." });
    } catch {
      toast({ title: "Failed to submit lead", variant: "destructive" });
    } finally {
      setNetSending(false);
    }
  };

  const myStats = stats?.find(s => s.agent.id === user?.id);
  const ranked  = stats ? [...stats].sort((a, b) => b.appointmentsSet - a.appointmentsSet || b.totalAttempts - a.totalAttempts) : [];

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "0 0 60px" }}>

      {/* ── Personal stats strip ── */}
      {myStats && (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8,
          marginBottom: 24,
        }}>
          {[
            { label: "Appts Set",   value: myStats.appointmentsSet },
            { label: "Total Calls", value: myStats.totalAttempts },
            { label: "Contact %",   value: `${myStats.contactRate}%` },
          ].map(s => (
            <div key={s.label} style={{
              padding: "14px 12px", textAlign: "center",
              background: "rgba(200,170,90,0.05)", border: "1px solid rgba(200,170,90,0.12)", borderRadius: 8,
            }}>
              <p style={{ fontSize: 22, fontWeight: 600, color: "#c8aa5a", fontFamily: "'Cormorant Garamond','Georgia',serif", lineHeight: 1 }}>{s.value}</p>
              <p style={{ fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginTop: 4 }}>{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Leaderboard ── */}
      <div style={{ marginBottom: 32 }}>
        <p style={{ fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 12 }}>
          Team Leaderboard
        </p>
        {isLoading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[1,2,3].map(i => <div key={i} style={{ height: 52, borderRadius: 8, background: "rgba(255,255,255,0.03)" }} />)}
          </div>
        ) : ranked.length === 0 ? (
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.25)", textAlign: "center", padding: "24px 0" }}>No data yet</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ranked.map((s, i) => {
              const isMe = s.agent.id === user?.id;
              const medal = i === 0 ? "#c8aa5a" : i === 1 ? "#9ca3af" : i === 2 ? "#b45309" : null;
              return (
                <div key={s.agent.id} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 16px",
                  background: isMe ? "rgba(200,170,90,0.07)" : "rgba(255,255,255,0.02)",
                  border: `1px solid ${isMe ? "rgba(200,170,90,0.2)" : "rgba(255,255,255,0.05)"}`,
                  borderRadius: 8,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: medal || "rgba(255,255,255,0.25)", minWidth: 20, textAlign: "center" }}>
                    {medal ? <Trophy size={14} style={{ color: medal }} /> : `#${i+1}`}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13, color: isMe ? "#c8aa5a" : "#fff", fontWeight: isMe ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.agent.name}{isMe ? " (you)" : ""}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 16, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "#c8aa5a", lineHeight: 1 }}>{s.appointmentsSet}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em" }}>APPTS</p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "rgba(255,255,255,0.6)", lineHeight: 1 }}>{s.totalAttempts}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em" }}>CALLS</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Network Lead submission ── */}
      <div style={{
        padding: "20px", background: "rgba(200,170,90,0.04)",
        border: "1px solid rgba(200,170,90,0.14)", borderRadius: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <Users size={14} style={{ color: "rgba(200,170,90,0.7)" }} />
          <p style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(200,170,90,0.8)", fontWeight: 600 }}>
            Submit a Network Lead
          </p>
        </div>
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 16, lineHeight: 1.5 }}>
          Know someone thinking about selling? Drop their info here and we'll take it from there.
        </p>
        <form onSubmit={handleNetworkLead} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            padding: "12px 20px", marginTop: 4,
            background: netSending ? "rgba(200,170,90,0.3)" : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
            border: "none", borderRadius: 6, cursor: netSending ? "not-allowed" : "pointer",
            fontSize: 12, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase",
            color: "#080808",
          }}>
            <Send size={13} /> {netSending ? "Submitting…" : "Submit Lead"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Referral Tab ─────────────────────────────────────────────────────────────
function ReferralTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [name, setName]       = useState("");
  const [phone, setPhone]     = useState("");
  const [email, setEmail]     = useState("");
  const [brokerage, setBrokerage] = useState("");
  const [notes, setNotes]     = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent]       = useState(false);

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
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 0 60px" }}>
      <div style={{
        padding: "24px 20px",
        background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <UserPlus size={16} style={{ color: "rgba(200,170,90,0.8)" }} />
          <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 20, fontWeight: 300, color: "#fff" }}>
            Refer an Agent
          </h3>
        </div>
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 24, lineHeight: 1.6 }}>
          Know someone who would be a great fit for Brothers Group — or who wants to start receiving leads? Send us their info and we'll connect with them directly.
        </p>

        {sent && (
          <div style={{ padding: "14px 16px", marginBottom: 20, background: "rgba(34,197,94,0.07)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 8 }}>
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
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            padding: "14px 20px", marginTop: 4,
            background: sending ? "rgba(200,170,90,0.3)" : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
            border: "none", borderRadius: 6, cursor: sending ? "not-allowed" : "pointer",
            fontSize: 12, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase",
            color: "#080808",
          }}>
            <Send size={13} /> {sending ? "Sending…" : "Send Referral"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 9, letterSpacing: "0.2em",
  textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 6,
};
const inputStyle: React.CSSProperties = {
  width: "100%", background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
  padding: "10px 13px", borderRadius: 5,
  fontFamily: "'Switzer','Inter',sans-serif", fontSize: 13,
  color: "#fff", outline: "none", boxSizing: "border-box",
};

// ─── Nav tabs ─────────────────────────────────────────────────────────────────
type Tab = "leads" | "leaderboard" | "refer";
const NAV: { id: Tab; label: string; icon: typeof Phone }[] = [
  { id: "leaderboard", label: "Dashboard",  icon: Trophy },
  { id: "leads",       label: "My Leads",   icon: Phone },
  { id: "refer",       label: "Refer",      icon: UserPlus },
];

// ─── Main AgentView ──────────────────────────────────────────────────────────
export default function AgentView({ onBackToAdmin }: { onBackToAdmin?: () => void } = {}) {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("leaderboard");

  const { data: nextLead, isLoading: leadLoading } = useQuery<Lead | null>({
    queryKey: ["/api/leads/my-next"],
    queryFn: () =>
      apiRequest("GET", `/api/leads/my-next?agentId=${user?.id}`).then(async r => {
        if (r.status === 204) return null;
        return r.json();
      }),
    refetchInterval: 30000,
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

  return (
    <div style={{ minHeight: "100dvh", background: "#080808", display: "flex", flexDirection: "column" }}>

      {/* ── Header ── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 20,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 18px",
        background: "rgba(8,8,8,0.97)",
        backdropFilter: "blur(16px)",
        borderBottom: "1px solid rgba(200,170,90,0.1)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {onBackToAdmin && (
            <button onClick={onBackToAdmin} style={{
              display: "flex", alignItems: "center", gap: 4,
              fontSize: 11, color: "rgba(255,255,255,0.35)",
              background: "none", border: "none", cursor: "pointer",
              letterSpacing: "0.06em", marginRight: 2,
            }}>
              <ChevronLeft size={13} /> Admin
            </button>
          )}
          <LogoIcon size={24} />
          <div>
            <p style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 13, fontWeight: 400, letterSpacing: "0.16em", color: "#fff", textTransform: "uppercase", lineHeight: 1 }}>Lead Depot</p>
            <p style={{ fontSize: 10, color: "rgba(200,170,90,0.6)", letterSpacing: "0.06em" }}>{user?.name}</p>
          </div>
        </div>
        <button onClick={logout} style={{
          display: "flex", alignItems: "center", gap: 5,
          fontSize: 11, color: "rgba(255,255,255,0.3)",
          background: "none", border: "none", cursor: "pointer",
        }}>
          <LogOut size={13} /> Sign out
        </button>
      </header>

      {/* ── Leads notification banner ── */}
      {hasLeads && tab !== "leads" && (
        <button onClick={() => setTab("leads")} style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          padding: "12px 20px",
          background: "linear-gradient(135deg, rgba(200,170,90,0.15) 0%, rgba(200,170,90,0.08) 100%)",
          border: "none", borderBottom: "1px solid rgba(200,170,90,0.25)",
          cursor: "pointer",
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%", background: "#c8aa5a",
            boxShadow: "0 0 6px rgba(200,170,90,0.7)",
            animation: "pulse 2s infinite",
          }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "#c8aa5a", letterSpacing: "0.1em" }}>
            {queueCount} Lead{queueCount !== 1 ? "s" : ""} Ready — Tap to Work Your Queue
          </span>
          <ChevronLeft size={12} style={{ color: "rgba(200,170,90,0.6)", transform: "rotate(180deg)" }} />
        </button>
      )}

      {/* ── Main ── */}
      <main style={{ flex: 1, overflowY: "auto", padding: "20px 16px 80px" }}>
        {tab === "leaderboard" && <LeaderboardTab />}

        {tab === "leads" && (
          <div>
            {leadLoading ? (
              <div style={{ maxWidth: 560, margin: "0 auto" }}>
                <Skeleton className="h-[480px] w-full rounded-xl" style={{ background: "rgba(255,255,255,0.04)" }} />
              </div>
            ) : !nextLead ? (
              <div style={{ textAlign: "center", paddingTop: 72, maxWidth: 360, margin: "0 auto" }}>
                <div style={{ width: 60, height: 60, border: "1px solid rgba(200,170,90,0.2)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
                  <CheckCircle2 size={26} style={{ color: "rgba(200,170,90,0.5)" }} />
                </div>
                <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.7rem", fontWeight: 300, color: "#fff", marginBottom: 10 }}>Queue Complete</h2>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 }}>
                  You've worked through all your assigned leads. Check back soon for new assignments.
                </p>
              </div>
            ) : (
              <LeadCard lead={nextLead} />
            )}
          </div>
        )}

        {tab === "refer" && <ReferralTab />}
      </main>

      {/* ── Bottom nav ── */}
      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 30,
        display: "flex",
        background: "rgba(10,10,10,0.98)",
        backdropFilter: "blur(20px)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}>
        {NAV.map(n => {
          const Icon = n.icon;
          const active = tab === n.id;
          const showBadge = n.id === "leads" && hasLeads;
          return (
            <button key={n.id} onClick={() => setTab(n.id)} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              gap: 4, padding: "10px 8px 12px",
              background: "transparent", border: "none", cursor: "pointer",
              position: "relative",
            }}>
              {showBadge && (
                <span style={{
                  position: "absolute", top: 7, right: "calc(50% - 16px)",
                  width: 7, height: 7, borderRadius: "50%",
                  background: "#c8aa5a", boxShadow: "0 0 5px rgba(200,170,90,0.8)",
                }} />
              )}
              <Icon size={20} style={{ color: active ? "#c8aa5a" : "rgba(255,255,255,0.3)", transition: "color 0.15s" }} />
              <span style={{ fontSize: 10, letterSpacing: "0.06em", color: active ? "#c8aa5a" : "rgba(255,255,255,0.3)", transition: "color 0.15s" }}>
                {n.label}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Pulse animation */}
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  );
}
