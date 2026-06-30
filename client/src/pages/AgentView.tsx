import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Phone, PhoneOff, PhoneMissed, Calendar, XCircle,
  CheckCircle2, AlertTriangle, MapPin, Mail, LogOut,
  TrendingUp, ChevronLeft, ScrollText, ChevronDown,
  ChevronUp,
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
  { key: "listen",   label: "LISTEN",   color: "#c8aa5a",         desc: "Let them speak fully without interrupting" },
  { key: "pause",    label: "PAUSE",    color: "rgba(255,255,255,0.7)", desc: "3-second silence after they finish" },
  { key: "mirror",   label: "MIRROR",   color: "#7ec8e3",         desc: "Repeat their last 2–3 words as a question" },
  { key: "acknowledge", label: "ACK",  color: "#a8d5a2",         desc: "Validate their feelings without agreeing" },
  { key: "minimum",  label: "MIN",     color: "rgba(255,255,255,0.55)", desc: "Ask for the minimum, not the maximum" },
  { key: "ask",      label: "ASK",     color: "#c8aa5a",         desc: "One open-ended question at a time" },
  { key: "bookmark", label: "BKMK",    color: "rgba(255,255,255,0.45)", desc: "\"That's important — let me note that\"" },
];

// ─── Outcome configs ───────────────────────────────────────────────────────────
const OUTCOMES = [
  {
    key: "no_answer",
    label: "No Answer",
    icon: PhoneMissed,
    bg: "rgba(234,179,8,0.08)",
    border: "rgba(234,179,8,0.22)",
    text: "rgb(253,224,71)",
    hoverBg: "rgba(234,179,8,0.15)",
  },
  {
    key: "left_voicemail",
    label: "Left Voicemail",
    icon: PhoneOff,
    bg: "rgba(167,139,250,0.08)",
    border: "rgba(167,139,250,0.22)",
    text: "rgb(196,181,253)",
    hoverBg: "rgba(167,139,250,0.15)",
  },
  {
    key: "callback_requested",
    label: "Callback",
    icon: Calendar,
    bg: "rgba(34,211,238,0.08)",
    border: "rgba(34,211,238,0.22)",
    text: "rgb(103,232,249)",
    hoverBg: "rgba(34,211,238,0.15)",
  },
  {
    key: "contacted_appointment",
    label: "Appt Set",
    icon: CheckCircle2,
    bg: "rgba(34,197,94,0.08)",
    border: "rgba(34,197,94,0.22)",
    text: "rgb(134,239,172)",
    hoverBg: "rgba(34,197,94,0.15)",
  },
  {
    key: "contacted_not_interested",
    label: "Not Interested",
    icon: XCircle,
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.22)",
    text: "rgb(252,165,165)",
    hoverBg: "rgba(239,68,68,0.15)",
  },
  {
    key: "wrong_number",
    label: "Wrong #",
    icon: AlertTriangle,
    bg: "rgba(239,68,68,0.05)",
    border: "rgba(239,68,68,0.15)",
    text: "rgba(252,165,165,0.7)",
    hoverBg: "rgba(239,68,68,0.1)",
  },
] as const;

// ─── Lead card ────────────────────────────────────────────────────────────────
function LeadCard({ lead, queueCount }: { lead: Lead; queueCount: number }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [notes, setNotes] = useState(lead.notes || "");
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

  const zillow = lead.address
    ? `https://www.zillow.com/homes/${encodeURIComponent(lead.address)}_rb/`
    : null;

  const emailSubject = encodeURIComponent(`Regarding your property at ${lead.address}`);
  const emailBody = encodeURIComponent(`Hi ${lead.ownerName || "there"},\n\nI wanted to reach out about your property at ${lead.address}. I specialize in helping homeowners in your area and I'd love to connect.\n\nWould you be available for a quick call?\n\nBest,\nWatson Brothers Group`);
  const mailtoLink = lead.email ? `mailto:${lead.email}?subject=${emailSubject}&body=${emailBody}` : null;

  const typeLabel: Record<string, string> = {
    expired: "Expired", distressed: "Distressed", website_lead: "Website",
    fsbo: "FSBO", land: "Land",
  };

  return (
    <div
      className="lead-active-glow"
      style={{
        background: "linear-gradient(135deg, #0f0f0f 0%, #0a0a0a 100%)",
        border: "1px solid rgba(200,170,90,0.18)",
        borderRadius: 12,
        overflow: "hidden",
        maxWidth: 560,
        width: "100%",
        margin: "0 auto",
      }}
    >
      {/* ── Top bar: type + queue count ──────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 20px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        background: "rgba(200,170,90,0.04)",
      }}>
        <span style={{
          fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase",
          color: "rgba(200,170,90,0.8)",
          fontFamily: "'Switzer','Inter',sans-serif",
        }}>
          {typeLabel[lead.leadType] || lead.leadType}
        </span>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: "0.05em" }}>
          {queueCount > 1 ? `${queueCount - 1} more in queue` : "Last lead"}
        </span>
      </div>

      {/* ── Lead info ─────────────────────────────────────────────────────── */}
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
            <a
              href={`tel:${lead.phone}`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 7,
                padding: "11px 20px",
                background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                borderRadius: 4, textDecoration: "none",
                fontSize: 14, fontWeight: 600, letterSpacing: "0.04em",
                color: "#080808",
                flex: "1 1 auto", justifyContent: "center",
                minHeight: 44,
              }}
            >
              <Phone size={14} />
              {lead.phone}
            </a>
          )}
          {mailtoLink && (
            <a
              href={mailtoLink}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "11px 16px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 4, textDecoration: "none",
                fontSize: 12, color: "rgba(255,255,255,0.55)",
                minHeight: 44,
              }}
            >
              <Mail size={13} />
              Email
            </a>
          )}
          {zillow && (
            <a
              href={zillow}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "11px 16px",
                background: "rgba(59,130,246,0.08)",
                border: "1px solid rgba(59,130,246,0.2)",
                borderRadius: 4, textDecoration: "none",
                fontSize: 12, color: "rgba(147,197,253,0.8)",
                minHeight: 44,
              }}
            >
              <TrendingUp size={12} />
              Zillow
            </a>
          )}
        </div>

        {/* Motivation */}
        {lead.motivation && (
          <div style={{
            padding: "10px 14px", marginBottom: 14,
            background: "rgba(234,179,8,0.05)",
            border: "1px solid rgba(234,179,8,0.12)",
            borderRadius: 6, display: "flex", gap: 8, alignItems: "flex-start",
          }}>
            <AlertTriangle size={12} style={{ color: "rgba(234,179,8,0.7)", marginTop: 1, flexShrink: 0 }} />
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>{lead.motivation}</p>
          </div>
        )}

        {/* Extra details */}
        {(extra.county || extra.propertyType || extra.estimatedValue || extra.timeframe) && (
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px",
            marginBottom: 14,
          }}>
            {extra.county && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>County: <span style={{ color: "rgba(255,255,255,0.55)" }}>{extra.county}</span></p>}
            {extra.propertyType && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>Type: <span style={{ color: "rgba(255,255,255,0.55)" }}>{extra.propertyType}</span></p>}
            {extra.estimatedValue && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>Est. Value: <span style={{ color: "rgba(200,170,90,0.7)" }}>{extra.estimatedValue}</span></p>}
            {extra.timeframe && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>Timeframe: <span style={{ color: "rgba(255,255,255,0.55)" }}>{extra.timeframe}</span></p>}
          </div>
        )}

        {/* Attempt count */}
        {lead.attemptCount > 0 && (
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginBottom: 14 }}>
            {lead.attemptCount} previous attempt{lead.attemptCount !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {/* ── LPMAMAB ──────────────────────────────────────────────────────────── */}
      <div style={{
        margin: "0 24px 16px",
        padding: "12px 16px",
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
      }}>
        <p style={{ fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 10 }}>
          LPMAMAB Framework
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {LPMAMAB_PHRASES.map(p => (
            <div
              key={p.key}
              title={p.desc}
              style={{
                padding: "4px 10px",
                borderRadius: 3,
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.08)",
                cursor: "default",
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", color: p.color }}>
                {p.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Callback date ─────────────────────────────────────────────────── */}
      <div style={{ padding: "0 24px 16px" }}>
        <label style={{
          display: "block", fontSize: 9, letterSpacing: "0.2em",
          textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 7,
        }}>
          Callback Date (required for Callback outcome)
        </label>
        <input
          type="date"
          value={callbackDate}
          onChange={e => setCallbackDate(e.target.value)}
          style={{
            width: "100%", background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.1)",
            padding: "10px 14px", borderRadius: 4,
            fontFamily: "'Switzer','Inter',sans-serif", fontSize: 13,
            color: "#fff", outline: "none",
            colorScheme: "dark",
          }}
          data-testid="input-callback-date"
        />
      </div>

      {/* ── Notes ────────────────────────────────────────────────────────────── */}
      <div style={{ padding: "0 24px 16px" }}>
        <label style={{
          display: "block", fontSize: 9, letterSpacing: "0.2em",
          textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 7,
        }}>
          Call Notes
        </label>
        <Textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Enter call notes…"
          className="min-h-[80px] text-xs leading-relaxed resize-none"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "rgba(255,255,255,0.8)",
            fontFamily: "'Switzer','Inter',sans-serif",
          }}
          data-testid="textarea-notes"
        />
      </div>

      {/* ── Outcome buttons ───────────────────────────────────────────────── */}
      <div style={{ padding: "0 24px 24px" }}>
        <p style={{
          fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase",
          color: "rgba(255,255,255,0.25)", marginBottom: 10,
        }}>
          Log Outcome
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {OUTCOMES.map(o => {
            const Icon = o.icon;
            const isHovered = hoveredOutcome === o.key;
            return (
              <button
                key={o.key}
                onClick={() => handleOutcome(o.key)}
                disabled={outcomeMutation.isPending}
                onMouseEnter={() => setHoveredOutcome(o.key)}
                onMouseLeave={() => setHoveredOutcome(null)}
                data-testid={`button-outcome-${o.key}`}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center",
                  gap: 5, padding: "12px 8px",
                  background: isHovered ? o.hoverBg : o.bg,
                  border: `1px solid ${isHovered ? o.text : o.border}`,
                  borderRadius: 6, cursor: "pointer",
                  transition: "all 0.18s ease",
                  minHeight: 64,
                  opacity: outcomeMutation.isPending ? 0.6 : 1,
                }}
              >
                <Icon size={16} style={{ color: o.text }} />
                <span style={{ fontSize: 10, fontWeight: 500, color: o.text, letterSpacing: "0.04em", textAlign: "center" }}>
                  {o.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Script panel ──────────────────────────────────────────────────── */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <button
          onClick={() => setShowScript(s => !s)}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 24px", background: "transparent", border: "none",
            cursor: "pointer",
          }}
          data-testid="button-toggle-script"
        >
          <span style={{
            display: "flex", alignItems: "center", gap: 7,
            fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase",
            color: "rgba(255,255,255,0.35)",
          }}>
            <ScrollText size={12} style={{ color: "rgba(200,170,90,0.6)" }} />
            Call Script
          </span>
          {showScript
            ? <ChevronUp size={14} style={{ color: "rgba(255,255,255,0.3)" }} />
            : <ChevronDown size={14} style={{ color: "rgba(255,255,255,0.3)" }} />
          }
        </button>
        {showScript && (
          <div style={{ padding: "0 24px 24px" }}>
            <pre style={{
              fontSize: 12, color: "rgba(255,255,255,0.6)",
              whiteSpace: "pre-wrap", lineHeight: 1.7,
              fontFamily: "'DM Mono',monospace",
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 6, padding: "16px",
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

// ─── Main AgentView ──────────────────────────────────────────────────────────
export default function AgentView({ onBackToAdmin }: { onBackToAdmin?: () => void } = {}) {
  const { user, logout } = useAuth();

  const { data: nextLead, isLoading } = useQuery<Lead | null>({
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

  return (
    <div style={{
      minHeight: "100dvh",
      background: "#080808",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 20,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 20px",
        background: "rgba(8,8,8,0.95)",
        backdropFilter: "blur(16px)",
        borderBottom: "1px solid rgba(200,170,90,0.1)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {onBackToAdmin && (
            <button
              onClick={onBackToAdmin}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                fontSize: 11, color: "rgba(255,255,255,0.35)",
                background: "none", border: "none", cursor: "pointer",
                letterSpacing: "0.06em",
                marginRight: 4,
              }}
            >
              <ChevronLeft size={13} />
              Admin
            </button>
          )}
          <LogoIcon size={26} />
          <div>
            <p style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: 14, fontWeight: 400, letterSpacing: "0.16em",
              color: "#fff", textTransform: "uppercase", lineHeight: 1,
            }}>
              Lead Depot
            </p>
            <p style={{ fontSize: 10, color: "rgba(200,170,90,0.6)", letterSpacing: "0.06em" }}>
              {user?.name}
            </p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {queueCount > 0 && (
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "flex-end",
            }}>
              <span style={{ fontSize: 16, fontWeight: 600, color: "#c8aa5a", lineHeight: 1 }}>
                {queueCount}
              </span>
              <span style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)" }}>
                in queue
              </span>
            </div>
          )}
          <button
            onClick={logout}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              fontSize: 11, color: "rgba(255,255,255,0.3)",
              background: "none", border: "none", cursor: "pointer",
              letterSpacing: "0.04em",
            }}
          >
            <LogOut size={13} />
            Sign out
          </button>
        </div>
      </header>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "flex-start",
        padding: "24px 16px 48px",
        overflowY: "auto",
      }}>
        {isLoading ? (
          <div style={{ width: "100%", maxWidth: 560 }}>
            <Skeleton className="h-12 w-48 mb-6 rounded" style={{ background: "rgba(255,255,255,0.06)" }} />
            <Skeleton className="h-[480px] w-full rounded-xl" style={{ background: "rgba(255,255,255,0.04)" }} />
          </div>
        ) : !nextLead ? (
          <div style={{
            textAlign: "center", paddingTop: 80,
            maxWidth: 360,
          }}>
            <div style={{
              width: 64, height: 64,
              border: "1px solid rgba(200,170,90,0.2)",
              borderRadius: "50%",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 24px",
            }}>
              <CheckCircle2 size={28} style={{ color: "rgba(200,170,90,0.5)" }} />
            </div>
            <h2 style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: "1.8rem", fontWeight: 300, color: "#fff",
              marginBottom: 10,
            }}>
              Queue Complete
            </h2>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 }}>
              You've worked through all your assigned leads. Check back soon for new assignments.
            </p>
          </div>
        ) : (
          <LeadCard lead={nextLead} queueCount={queueCount} />
        )}
      </main>
    </div>
  );
}
