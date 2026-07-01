import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Phone, PhoneMissed, Calendar, XCircle,
  CheckCircle2, AlertTriangle, MapPin, Mail, LogOut,
  TrendingUp, ChevronLeft, ScrollText, ChevronDown,
  ChevronUp, Trophy, Users, Send, UserPlus, Heart,
} from "lucide-react";
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

// ─── LPMAMAB phrases ──────────────────────────────────────────────────────────
const LPMAMAB_PHRASES = [
  { key: "location",    label: "L — Location",    color: "#c8aa5a" },
  { key: "price",       label: "P — Price",       color: "#e2d5b0" },
  { key: "motivation",  label: "M — Motivation",  color: "#7ec8e3" },
  { key: "agent",       label: "A — Agent",       color: "#a8d5a2" },
  { key: "mortgage",    label: "M — Mortgage",    color: "#e2d5b0" },
  { key: "appointment", label: "A — Appointment", color: "#c8aa5a" },
  { key: "buyer",       label: "B — Buyer",       color: "#a8d5a2" },
];

// ─── Outcome configs ───────────────────────────────────────────────────────────
const OUTCOMES = [
  { key: "no_answer",               label: "No Answer",     icon: PhoneMissed,   bg: "rgba(234,179,8,0.12)",   border: "rgba(234,179,8,0.4)",    text: "rgb(253,224,71)",       hoverBg: "rgba(234,179,8,0.22)" },
  { key: "keep_in_touch",           label: "Keep in Touch", icon: Heart,         bg: "rgba(236,72,153,0.12)",  border: "rgba(236,72,153,0.4)",   text: "rgb(249,168,212)",      hoverBg: "rgba(236,72,153,0.22)" },
  { key: "callback_requested",      label: "Callback",      icon: Calendar,      bg: "rgba(34,211,238,0.12)",  border: "rgba(34,211,238,0.4)",   text: "rgb(103,232,249)",      hoverBg: "rgba(34,211,238,0.22)" },
  { key: "contacted_appointment",   label: "Appt Set",      icon: CheckCircle2,  bg: "rgba(34,197,94,0.12)",   border: "rgba(34,197,94,0.4)",    text: "rgb(134,239,172)",      hoverBg: "rgba(34,197,94,0.22)" },
  { key: "contacted_not_interested",label: "Not Interested",icon: XCircle,       bg: "rgba(239,68,68,0.12)",   border: "rgba(239,68,68,0.4)",    text: "rgb(252,165,165)",      hoverBg: "rgba(239,68,68,0.22)" },
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
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase",
      color: "rgba(200,170,90,0.6)", marginBottom: 10, fontWeight: 600,
    }}>
      {children}
    </p>
  );
}

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
      background: "linear-gradient(160deg, #141414 0%, #0c0c0c 60%, #0a0a0a 100%)",
      border: "1px solid rgba(200,170,90,0.3)",
      borderRadius: 16, overflow: "hidden",
      width: "100%",
      boxShadow: "0 0 40px rgba(200,170,90,0.06), 0 8px 32px rgba(0,0,0,0.6)",
    }}>

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
          {lead.phone && (
            <a href={`tel:${lead.phone}`} style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "13px 22px",
              background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
              borderRadius: 8, textDecoration: "none",
              fontSize: 15, fontWeight: 700, letterSpacing: "0.03em",
              color: "#080808", flex: "1 1 auto", justifyContent: "center", minHeight: 48,
              boxShadow: "0 4px 16px rgba(200,170,90,0.3)",
            }}>
              <Phone size={15} /> {lead.phone}
            </a>
          )}
          {mailtoLink && (
            <a href={mailtoLink} style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "13px 18px",
              background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 8, textDecoration: "none",
              fontSize: 13, color: "rgba(255,255,255,0.7)", minHeight: 48,
            }}>
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
          </div>
        )}

        {lead.attemptCount > 0 && (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 4 }}>
            {lead.attemptCount} previous attempt{lead.attemptCount !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      <GoldDivider />

      {/* ── LPMAMAB ── */}
      <div style={{ padding: "0 20px 18px" }}>
        <SectionLabel>LPMAMAB Framework</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {LPMAMAB_PHRASES.map(p => (
            <div key={p.key} style={{
              padding: "6px 12px", borderRadius: 6,
              background: "rgba(200,170,90,0.07)",
              border: "1px solid rgba(200,170,90,0.22)",
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: p.color }}>{p.label}</span>
            </div>
          ))}
        </div>
      </div>

      <GoldDivider />

      {/* ── Callback date ── */}
      <div style={{ padding: "0 20px 16px" }}>
        <SectionLabel>Callback Date</SectionLabel>
        <input type="date" value={callbackDate} onChange={e => setCallbackDate(e.target.value)}
          style={{
            width: "100%", background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(200,170,90,0.25)",
            padding: "11px 14px", borderRadius: 8,
            fontFamily: "'Switzer','Inter',sans-serif", fontSize: 14,
            color: "#fff", outline: "none", colorScheme: "dark",
            boxSizing: "border-box",
          }}
        />
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

      <GoldDivider />

      {/* ── Outcome buttons ── */}
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
        </div>
      </div>

      {/* ── Script panel ── */}
      <div style={{ borderTop: "1px solid rgba(200,170,90,0.15)" }}>
        <button onClick={() => setShowScript(s => !s)}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "14px 20px", background: "rgba(200,170,90,0.04)", border: "none", cursor: "pointer",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(200,170,90,0.75)", fontWeight: 600 }}>
            <ScrollText size={13} style={{ color: "#c8aa5a" }} /> Call Script
          </span>
          {showScript
            ? <ChevronUp size={16} style={{ color: "rgba(200,170,90,0.5)" }} />
            : <ChevronDown size={16} style={{ color: "rgba(200,170,90,0.5)" }} />}
        </button>
        {showScript && (
          <div style={{ padding: "0 20px 24px" }}>
            <pre style={{
              fontSize: 13, color: "rgba(255,255,255,0.7)", whiteSpace: "pre-wrap", lineHeight: 1.7,
              fontFamily: "'DM Mono',monospace",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(200,170,90,0.15)", borderRadius: 8, padding: "16px",
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
    <div style={{ width: "100%", padding: "0 0 20px" }}>

      {/* ── Personal stats ── */}
      {myStats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 28 }}>
          {[
            { label: "Appts Set",   value: myStats.appointmentsSet },
            { label: "Total Calls", value: myStats.totalAttempts },
            { label: "Contact %",   value: `${myStats.contactRate}%` },
          ].map(s => (
            <div key={s.label} style={{
              padding: "16px 10px", textAlign: "center",
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
                  <div style={{ display: "flex", gap: 18, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ fontSize: 17, fontWeight: 700, color: "#c8aa5a", lineHeight: 1 }}>{s.appointmentsSet}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 2 }}>APPTS</p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ fontSize: 17, fontWeight: 600, color: "rgba(255,255,255,0.7)", lineHeight: 1 }}>{s.totalAttempts}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", marginTop: 2 }}>CALLS</p>
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
          <p style={{ fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "#c8aa5a", fontWeight: 700 }}>
            Submit a Network Lead
          </p>
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
type Tab = "leads" | "leaderboard" | "refer";
const NAV: { id: Tab; label: string; icon: typeof Phone }[] = [
  { id: "leaderboard", label: "Dashboard",  icon: Trophy },
  { id: "leads",       label: "My Leads",   icon: Phone },
  { id: "refer",       label: "Refer",      icon: UserPlus },
];

// ─── Main AgentView ───────────────────────────────────────────────────────────
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
        <button onClick={logout} style={{
          display: "flex", alignItems: "center", gap: 5,
          fontSize: 11, color: "rgba(255,255,255,0.4)",
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 6, padding: "6px 10px",
          cursor: "pointer",
        }}>
          <LogOut size={13} /> Sign out
        </button>
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
      <main style={{ flex: 1, overflowY: "auto", padding: "16px 12px 90px" }}>
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
                }}>Queue Complete</h2>
                <p style={{ fontSize: 14, color: "rgba(255,255,255,0.45)", lineHeight: 1.65 }}>
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
    </div>
  );
}
