import { useState, useRef, useCallback, useEffect } from "react";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import ActivityFeed from "../components/ld/ActivityFeed";
import ProfilePage from "./ProfilePage";
import ScriptEditor from "../components/ScriptEditor";
import MapView from "./MapView";
import AnimatedNumber from "../components/AnimatedNumber";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LogOut, Upload, Download, Users, BarChart2, List, Plus, Trash2,
  Phone, PhoneCall, Mail, MapPin, RefreshCw, Trophy, TrendingUp,
  PhoneMissed, Calendar, XCircle, CheckCircle2,
  AlertTriangle, ChevronRight, X, Layers, ScrollText, Power, Trash, Heart, Map as MapIcon,
  Clock, ChevronDown, ChevronUp, Activity, Star, Wifi, WifiOff, Shield, Settings, Snowflake,
  UserPlus, UserCircle2
} from "lucide-react";
import type { Lead, Agent } from "@shared/schema";
// v14.49 — reuse the agent's "Who called me?" modal on the admin dashboard.
import { CallbackLookupModal } from "./AgentView";

// ── Logo ─────────────────────────────────────────────────────────────────────
function LogoIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-label="Lead Depot">
      <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.4"/>
      <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
      <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.2"/>
    </svg>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    assigned: "Assigned", no_answer: "No Answer", keep_in_touch: "Keep in Touch",
    callback_requested: "Callback", contacted_appointment: "Appt Set",
    contacted_not_interested: "Not Interested", wrong_number: "Wrong #",
    unassigned: "Unassigned", retired: "Retired",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium status-${status}`}>{labels[status] || status}</span>;
}

function TypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    expired: "Expired", network: "Network",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium type-${type}`}>{labels[type] || type}</span>;
}

// v14.39 — Recycle cooldown pill. Renders when lead is under active 14d on-ice timer.
// Shows release date (e.g. "On ice — Jul 23"). Click to Thaw (admin override).
function CooldownPill({ until, onThaw, compact = false }: { until?: number | null; onThaw?: () => void; compact?: boolean }) {
  if (!until || until <= Date.now()) return null;
  const releaseDate = new Date(until).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "America/New_York",
  });
  const label = compact ? `❄ ${releaseDate}` : `On ice — ${releaseDate}`;
  const style: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 4,
    fontSize: compact ? 10 : 11, padding: compact ? "1px 6px" : "2px 8px",
    borderRadius: 999, fontWeight: 600,
    background: "rgba(103,232,249,0.08)", border: "1px solid rgba(103,232,249,0.25)",
    color: "#67e8f9", cursor: onThaw ? "pointer" : "default",
    whiteSpace: "nowrap",
  };
  const handleClick = (e: React.MouseEvent) => {
    if (!onThaw) return;
    e.stopPropagation();
    if (confirm("Thaw this lead? It will be eligible for pull immediately.")) onThaw();
  };
  return (
    <span style={style} onClick={handleClick} title={onThaw ? "Click to Thaw (clear cooldown now)" : label}>
      <Snowflake size={compact ? 10 : 11} strokeWidth={2.5} />
      {label}
    </span>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: number | string; sub?: string; accent?: string }) {
  // v14.81.2 — Tier 2 aliveness: numeric values tween 0→n over 600ms on mount/change.
  return (
    <div style={{
      background: "linear-gradient(135deg, #0f0f0f 0%, #0a0a0a 100%)",
      border: "1px solid rgba(200,170,90,0.1)",
      borderRadius: 10, padding: "16px",
    }}>
      <div style={{ fontSize: 28, fontWeight: 300, lineHeight: 1, marginBottom: 4 }}
        className={accent || "text-foreground"}
      >
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </div>
      <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase" }}
        className="text-muted-foreground"
      >
        {label}
      </div>
      {sub && <div style={{ fontSize: 10 }} className="text-muted-foreground/40 mt-1">{sub}</div>}
    </div>
  );
}

// RFC-4180 compliant CSV parser — handles quoted fields with commas and newlines
function parseCSV(text: string): Record<string, string>[] {
  // Tokenize: returns array of rows, each row is array of field strings
  function tokenize(raw: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const n = raw.length;
    while (i < n) {
      const ch = raw[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < n && raw[i + 1] === '"') { field += '"'; i += 2; } // escaped quote
          else { inQuotes = false; i++; }
        } else {
          field += ch; i++;
        }
      } else {
        if (ch === '"') { inQuotes = true; i++; }
        else if (ch === ',') { row.push(field.trim()); field = ""; i++; }
        else if (ch === '\r' && i + 1 < n && raw[i + 1] === '\n') {
          row.push(field.trim()); rows.push(row); row = []; field = ""; i += 2;
        } else if (ch === '\n') {
          row.push(field.trim()); rows.push(row); row = []; field = ""; i++;
        } else { field += ch; i++; }
      }
    }
    if (field || row.length) { row.push(field.trim()); rows.push(row); }
    return rows;
  }

  const rows = tokenize(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const results: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    // Skip completely empty rows
    if (vals.every(v => !v)) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
    results.push(obj);
  }
  return results;
}

// Official 7 territories — agent can be assigned to one (or null = receives all)
const TERRITORY_OPTIONS = [
  { value: "",                             label: "All Territories" },
  { value: "north_jax_nassau",             label: "North Jax & Nassau" },
  { value: "jacksonville_west",            label: "Jacksonville West" },
  { value: "jacksonville_east",            label: "Jacksonville East" },
  { value: "intracoastal_beaches",         label: "Intracoastal / Beaches" },
  { value: "ponte_vedra_nocatee_st_aug",   label: "Ponte Vedra / Nocatee / St. Aug" },
  { value: "st_johns_county",              label: "St. Johns County" },
  // v14.0 — Clay County removed.
];

const OUTCOME_ICONS: Record<string, any> = {
  contacted_appointment: CheckCircle2,
  contacted_not_interested: XCircle,
  no_answer: PhoneMissed,
  keep_in_touch: Heart,
  callback_requested: Calendar,
  wrong_number: AlertTriangle,
};

const OUTCOME_COLORS: Record<string, string> = {
  contacted_appointment: "text-green-400",
  contacted_not_interested: "text-red-400",
  no_answer: "text-yellow-400",
  keep_in_touch: "text-pink-400",
  callback_requested: "text-cyan-400",
  wrong_number: "text-red-600",
};

const OUTCOME_LABELS: Record<string, string> = {
  contacted_appointment: "Appts",
  contacted_not_interested: "Not Int.",
  no_answer: "No Ans.",
  keep_in_touch: "KIT",
  callback_requested: "Callback",
  wrong_number: "Wrong #",
};

// ── Luxury Confirm Modal ─────────────────────────────────────────────────────
interface LuxConfirmProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmColor?: string;
  onConfirm: () => void;
  onCancel: () => void;
}
function LuxConfirmModal({ open, title, message, confirmLabel = "Confirm", confirmColor = "#c8aa5a", onConfirm, onCancel }: LuxConfirmProps) {
  if (!open) return null;
  const isDanger = confirmColor === "#ef4444";
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "0 20px",
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#0e0d0b",
        border: `1px solid ${isDanger ? "rgba(239,68,68,0.35)" : "rgba(200,170,90,0.35)"}`,
        borderRadius: 16, padding: "28px 24px", maxWidth: 380, width: "100%",
        boxShadow: `0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px ${isDanger ? "rgba(239,68,68,0.08)" : "rgba(200,170,90,0.08)"}`,
      }}>
        <p style={{ fontSize: 16, fontWeight: 700, color: isDanger ? "#fca5a5" : "#c8aa5a", marginBottom: 10, letterSpacing: "0.02em" }}>{title}</p>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", lineHeight: 1.6, marginBottom: 24 }}>{message}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{
            flex: 1, padding: "11px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.6)",
            fontSize: 13, fontWeight: 600, cursor: "pointer", letterSpacing: "0.04em",
          }}>Cancel</button>
          <button onClick={onConfirm} style={{
            flex: 1, padding: "11px", borderRadius: 8, border: "none",
            background: isDanger
              ? "linear-gradient(135deg,#ef4444 0%,#b91c1c 100%)"
              : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
            color: isDanger ? "#fff" : "#080808",
            fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: "0.06em",
            boxShadow: isDanger ? "0 4px 16px rgba(239,68,68,0.3)" : "0 4px 16px rgba(200,170,90,0.3)",
          }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ── Agent Drilldown Modal ─────────────────────────────────────────────────────

function AgentDrilldown({ agentId, agentName, onClose }: { agentId: number; agentName: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/agent", agentId, "leads"],
    queryFn: () => apiRequest("GET", `/api/admin/agent/${agentId}/leads`).then(r => r.json()),
  });

  const leads: Lead[] = data?.leads || [];
  const activities = data?.activities || [];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
      padding: 16,
    }}>
      <div style={{
        background: "linear-gradient(135deg,#0f0f0f 0%,#0a0a0a 100%)",
        border: "1px solid rgba(200,170,90,0.15)",
        borderRadius: 16, width: "100%", maxWidth: 640,
        maxHeight: "85vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}>
          <div>
            <h2 style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: "1.2rem", fontWeight: 300, color: "#fff",
            }}>
              {agentName}
            </h2>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
              {leads.length} total leads assigned
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "rgba(255,255,255,0.4)", padding: 4,
            }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20 }} className="space-y-5">
          {isLoading ? (
            <div className="space-y-2">
              {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
            </div>
          ) : (
            <>
              {activities.length > 0 && (
                <div>
                  <p style={{ fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 10 }}>
                    Recent Activity
                  </p>
                  <div className="space-y-1.5">
                    {activities.slice(0, 10).map((act: any) => {
                      const Icon = OUTCOME_ICONS[act.outcome] || ChevronRight;
                      return (
                        <div key={act.id} style={{
                          display: "flex", alignItems: "flex-start", gap: 10,
                          background: "rgba(255,255,255,0.03)",
                          border: "1px solid rgba(255,255,255,0.07)",
                          borderRadius: 8, padding: "10px 14px",
                        }}>
                          <Icon size={13} className={`mt-0.5 shrink-0 ${OUTCOME_COLORS[act.outcome] || "text-muted-foreground"}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-xs font-semibold ${OUTCOME_COLORS[act.outcome] || "text-foreground"}`}>
                                {OUTCOME_LABELS[act.outcome] || act.outcome}
                              </span>
                              <span className="text-xs text-muted-foreground truncate">{act.leadAddress}</span>
                            </div>
                            {act.notes && <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">{act.notes}</p>}
                            <p className="text-xs text-muted-foreground/40 mt-0.5">{new Date(act.createdAt).toLocaleString()}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div>
                <p style={{ fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 10 }}>
                  All Assigned Leads
                </p>
                {leads.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No leads assigned yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {leads.map((lead: Lead) => (
                      <div key={lead.id} style={{
                        display: "flex", alignItems: "center", gap: 10,
                        background: "rgba(255,255,255,0.02)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        borderRadius: 8, padding: "10px 14px",
                      }}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                            <TypeBadge type={lead.leadType} />
                            <StatusBadge status={lead.status} />
                            <CooldownPill until={lead.recycleCooldownUntil} compact />
                            {lead.attemptCount > 0 && (
                              <span className="text-xs text-muted-foreground">{lead.attemptCount} attempt{lead.attemptCount !== 1 ? "s" : ""}</span>
                            )}
                          </div>
                          <p className="text-sm font-medium text-foreground truncate">{lead.ownerName || "—"}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin size={9}/>{lead.address}</p>
                        </div>
                        {lead.phone && (
                          <a href={`tel:${lead.phone}`} className="text-xs text-white/60 hover:text-white/90 shrink-0 flex items-center gap-1">
                            <Phone size={11}/>{lead.phone}
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


// ── ActivityHistory ────────────────────────────────────────────────────────────
function ActivityHistory({ leadId }: { leadId: number }) {
  const { data, isLoading } = useQuery<any[]>({
    queryKey: ["/api/leads", leadId, "activity"],
    queryFn: async () => {
      const res = await fetch(`/api/leads/${leadId}/activity`);
      if (!res.ok) throw new Error("Failed to load activity");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const outcomeLabel: Record<string, string> = {
    contacted_appointment: "Appt Set",
    keep_in_touch: "Keep in Touch",
    callback_requested: "Callback",
    no_answer: "No Answer",
    contacted_not_interested: "Not Interested",
    wrong_number: "Wrong #",
    recycled: "Recycled",
    email_sent: "Email Sent",
  };

  const outcomeColor: Record<string, string> = {
    contacted_appointment: "rgba(134,239,172,0.85)",
    keep_in_touch: "rgba(200,170,90,0.85)",
    callback_requested: "rgba(147,197,253,0.85)",
    no_answer: "rgba(255,255,255,0.35)",
    contacted_not_interested: "rgba(252,165,165,0.75)",
    wrong_number: "rgba(252,165,165,0.5)",
    recycled: "rgba(255,255,255,0.35)",
    email_sent: "rgba(167,139,250,0.75)",
  };

  function fmt(iso: string) {
    try {
      return new Date(iso).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
      });
    } catch { return iso; }
  }

  return (
    <div style={{ marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <Clock size={12} style={{ color: "rgba(200,170,90,0.7)" }} />
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase" }}>
          Activity History
        </span>
      </div>

      {isLoading && (
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.25)", padding: "8px 0" }}>Loading…</div>
      )}

      {!isLoading && (!data || data.length === 0) && (
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.2)", fontStyle: "italic", padding: "6px 0" }}>
          No activity recorded yet.
        </div>
      )}

      {!isLoading && data && data.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 280, overflowY: "auto" }}>
          {data.map((act: any) => {
            let snapshot: any = {};
            try { snapshot = JSON.parse(act.lpmamabSnapshot || act.lpmamab_snapshot || "{}"); } catch {}
            return (
              <div key={act.id} style={{
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 8, padding: "10px 12px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: act.notes ? 6 : 0 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700,
                    color: outcomeColor[act.outcome] || "rgba(255,255,255,0.55)",
                    background: "rgba(255,255,255,0.05)",
                    borderRadius: 4, padding: "2px 7px",
                  }}>
                    {outcomeLabel[act.outcome] || act.outcome}
                  </span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>
                    {act.agentName} · {fmt(act.createdAt || act.created_at)}
                  </span>
                </div>
                {act.notes && (
                  <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.5 }}>
                    {act.notes}
                  </p>
                )}
                {snapshot.apptDate && (
                  <p style={{ margin: "4px 0 0", fontSize: 11, color: "rgba(134,239,172,0.7)" }}>
                    Appt: {snapshot.apptDate} {snapshot.apptTime || ""}
                    {snapshot.stage ? ` · ${snapshot.stage}` : ""}
                    {snapshot.intention ? ` · ${snapshot.intention}` : ""}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── OutcomeReport ─────────────────────────────────────────────────────────────
function OutcomeReport() {
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery<any>({
    queryKey: ["/api/reports/outcomes"],
    queryFn: async () => {
      const res = await fetch("/api/reports/outcomes");
      if (!res.ok) throw new Error("Failed to load report");
      return res.json();
    },
  });

  const outcomeColor: Record<string, string> = {
    "Appointment Set": "rgba(134,239,172,0.85)",
    "Keep in Touch": "rgba(200,170,90,0.85)",
    "Callback": "rgba(147,197,253,0.85)",
    "No Answer": "rgba(255,255,255,0.45)",
    "Not Interested": "rgba(252,165,165,0.75)",
    "Wrong Number": "rgba(252,165,165,0.5)",
    "Recycled": "rgba(255,255,255,0.35)",
    "Email Sent": "rgba(167,139,250,0.75)",
  };

  function fmt(iso: string) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      });
    } catch { return iso; }
  }

  return (
    <div style={{ maxWidth: 700 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h2 style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            fontSize: "1.3rem", fontWeight: 300, color: "#fff", marginBottom: 2,
          }}>Outcome Report</h2>
          {data?.generatedAt && (
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", margin: 0 }}>
              Generated {fmt(data.generatedAt)}
            </p>
          )}
        </div>
        <button
          onClick={() => refetch()}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            fontSize: 11, padding: "7px 14px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 7, color: "rgba(255,255,255,0.5)", cursor: "pointer",
          }}
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>

      {isLoading && (
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", padding: "20px 0" }}>Loading report…</div>
      )}

      {!isLoading && data?.summary?.length === 0 && (
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>No activity recorded yet.</div>
      )}

      {!isLoading && data?.summary && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {data.summary.map((group: any) => {
            const isOpen = expanded === group.outcome;
            const accentColor = outcomeColor[group.outcome] || "rgba(255,255,255,0.4)";
            return (
              <div key={group.outcome} style={{
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12, overflow: "hidden",
              }}>
                {/* Header row */}
                <button
                  onClick={() => setExpanded(isOpen ? null : group.outcome)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center",
                    justifyContent: "space-between", padding: "14px 16px",
                    background: "rgba(255,255,255,0.03)",
                    border: "none", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{
                      width: 9, height: 9, borderRadius: "50%",
                      background: accentColor, display: "inline-block", flexShrink: 0,
                    }} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{group.outcome}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{
                      fontSize: 13, fontWeight: 700, color: accentColor,
                      background: "rgba(255,255,255,0.05)",
                      borderRadius: 6, padding: "2px 10px",
                    }}>{group.count}</span>
                    {isOpen ? <ChevronUp size={14} style={{ color: "rgba(255,255,255,0.3)" }} /> : <ChevronDown size={14} style={{ color: "rgba(255,255,255,0.3)" }} />}
                  </div>
                </button>

                {/* Expanded entries */}
                {isOpen && (
                  <div style={{ padding: "4px 0 8px" }}>
                    {group.entries.map((entry: any) => (
                      <div key={entry.activityId} style={{
                        padding: "10px 16px",
                        borderTop: "1px solid rgba(255,255,255,0.05)",
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>
                              {entry.ownerName}
                            </div>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                              {entry.address}
                            </div>
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <div style={{ fontSize: 11, color: "rgba(200,170,90,0.8)" }}>{entry.agent}</div>
                            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>{fmt(entry.date)}</div>
                          </div>
                        </div>

                        {entry.notes && entry.notes !== "—" && (
                          <div style={{
                            marginTop: 8, fontSize: 12, color: "rgba(255,255,255,0.6)",
                            background: "rgba(255,255,255,0.03)", borderRadius: 6,
                            padding: "7px 10px", lineHeight: 1.5,
                          }}>
                            {entry.notes}
                          </div>
                        )}

                        {(entry.apptDate || entry.callbackDate) && (
                          <div style={{
                            marginTop: 7, fontSize: 11, display: "flex", flexWrap: "wrap", gap: 8,
                          }}>
                            {entry.apptDate && (
                              <span style={{
                                background: "rgba(134,239,172,0.08)",
                                border: "1px solid rgba(134,239,172,0.2)",
                                borderRadius: 5, padding: "3px 8px",
                                color: "rgba(134,239,172,0.8)",
                              }}>
                                Appt: {entry.apptDate} {entry.apptTime || ""}
                              </span>
                            )}
                            {entry.stage && (
                              <span style={{
                                background: "rgba(147,197,253,0.08)",
                                border: "1px solid rgba(147,197,253,0.2)",
                                borderRadius: 5, padding: "3px 8px",
                                color: "rgba(147,197,253,0.7)",
                              }}>{entry.stage}</span>
                            )}
                            {entry.intention && (
                              <span style={{
                                background: "rgba(200,170,90,0.08)",
                                border: "1px solid rgba(200,170,90,0.2)",
                                borderRadius: 5, padding: "3px 8px",
                                color: "rgba(200,170,90,0.7)",
                              }}>{entry.intention}</span>
                            )}
                            {entry.callbackDate && !entry.apptDate && (
                              <span style={{
                                background: "rgba(147,197,253,0.08)",
                                border: "1px solid rgba(147,197,253,0.2)",
                                borderRadius: 5, padding: "3px 8px",
                                color: "rgba(147,197,253,0.7)",
                              }}>
                                Callback: {entry.callbackDate}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

/** Returns a color and label for the agent activity dot based on last activity timestamp */
function activityDot(lastActivityAt: string | null): { color: string; label: string } {
  if (!lastActivityAt) return { color: "#6b7280", label: "No activity recorded" };
  const diffHours = (Date.now() - new Date(lastActivityAt).getTime()) / (1000 * 60 * 60);
  if (diffHours <= 6)  return { color: "#22c55e", label: "Active within 6h" };
  if (diffHours <= 12) return { color: "#eab308", label: "Active within 12h" };
  if (diffHours <= 24) return { color: "#f97316", label: "Active within 24h" };
  if (diffHours <= 48) return { color: "#ef4444", label: "Active within 48h" };
  return { color: "#6b7280", label: "No activity in 48h+" };
}

// ─── CONNECTIVITY HEALTH WIDGET (v11.70) ────────────────────────────────────────
type HealthService = { ok: boolean; latencyMs?: number; detail?: string };
type HealthData = {
  status: "healthy" | "degraded" | "critical";
  version: string;
  services: {
    database: HealthService;
    resend: HealthService;
    follow_up_boss: HealthService;
    app_url: HealthService;
    websocket: HealthService;
    [key: string]: HealthService;
  };
};

const SERVICE_LABELS: Record<string, string> = {
  database:       "Database",
  resend:         "Email (Resend)",
  follow_up_boss: "Follow Up Boss",
  batchleads:     "BatchLeads API",
  app_url:        "App URL",
  websocket:      "WebSocket",
};

function HealthWidget() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, refetch } = useQuery<HealthData>({
    queryKey: ["/api/health"],
    queryFn: () => fetch("/api/health").then(r => r.json()),
    refetchInterval: 60_000, // poll every 60 seconds
    staleTime: 50_000,
  });

  const status = data?.status ?? (isLoading ? "loading" : "unknown");
  const allOk = status === "healthy";
  const degraded = status === "degraded";
  const critical = status === "critical";

  const dotColor = allOk ? "#22c55e" : degraded ? "#f59e0b" : critical ? "#ef4444" : "#6b7280";
  const dotLabel = allOk ? "All systems healthy" : degraded ? "Some services degraded" : critical ? "Critical failure" : "Checking...";

  return (
    <div style={{ position: "relative" }}>
      {/* Trigger button — small dot in header */}
      <button
        onClick={() => setOpen(o => !o)}
        title={dotLabel}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          background: open ? "rgba(255,255,255,0.07)" : "none",
          border: open ? "1px solid rgba(255,255,255,0.1)" : "1px solid transparent",
          borderRadius: 8, padding: "5px 8px", cursor: "pointer",
        }}
      >
        <Shield size={13} style={{ color: dotColor }} />
        <span style={{
          width: 7, height: 7, borderRadius: "50%",
          background: dotColor,
          boxShadow: allOk ? `0 0 6px ${dotColor}` : critical ? `0 0 8px ${dotColor}` : "none",
          animation: (degraded || critical) ? "healthPulse 1.5s ease infinite" : "none",
          display: "inline-block",
        }} />
        <style>{`@keyframes healthPulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0,
          width: 280, zIndex: 200,
          background: "#0f0e0c",
          border: "1px solid rgba(200,170,90,0.2)",
          borderRadius: 12,
          boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
          overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{
            padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            background: "rgba(200,170,90,0.06)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Shield size={13} style={{ color: "#c8aa5a" }} />
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#c8aa5a" }}>
                System Health
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>{data?.version}</span>
              <button
                onClick={() => refetch()}
                style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.3)", padding: 0, display: "flex" }}
                title="Refresh"
              >
                <RefreshCw size={11} />
              </button>
            </div>
          </div>

          {/* Service rows */}
          <div style={{ padding: "8px 0" }}>
            {data ? Object.entries(data.services).map(([key, svc]) => (
              <div key={key} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "7px 16px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: svc.ok ? "#22c55e" : "#ef4444",
                    boxShadow: svc.ok ? "0 0 5px #22c55e" : "0 0 5px #ef4444",
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 12, color: svc.ok ? "rgba(255,255,255,0.75)" : "#f87171" }}>
                    {SERVICE_LABELS[key] ?? key}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {svc.latencyMs !== undefined && (
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>{svc.latencyMs}ms</span>
                  )}
                  {svc.ok
                    ? <Wifi size={11} style={{ color: "#22c55e" }} />
                    : <WifiOff size={11} style={{ color: "#ef4444" }} />}
                </div>
              </div>
            )) : (
              <div style={{ padding: "12px 16px", fontSize: 12, color: "rgba(255,255,255,0.3)" }}>Checking services...</div>
            )}
          </div>

          {/* Footer */}
          {data && !allOk && (
            <div style={{
              padding: "10px 16px",
              borderTop: "1px solid rgba(255,255,255,0.06)",
              background: critical ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
            }}>
              <p style={{ fontSize: 11, color: critical ? "#f87171" : "#fbbf24", margin: 0 }}>
                {critical ? "⚠️ Critical issue detected — check Railway logs" : "⚠️ One or more services degraded"}
              </p>
            </div>
          )}
          {data && allOk && (
            <div style={{ padding: "8px 16px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", margin: 0 }}>All systems operational · Auto-refreshes every 60s</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminDashboard({
  onWorkMyLeads,
  onOpenAgentTab,
}: {
  onWorkMyLeads?: () => void;
  // v14.51 — admin bottom nav jumps into AgentView on a specific tab.
  onOpenAgentTab?: (tab: "leads" | "refer" | "leaderboard" | "profile" | "pipeline") => void;
} = {}) {
  const { user, logout } = useAuth();
  useRealtimeUpdates();
  const { toast } = useToast();
  const qc = useQueryClient();
  // v14.50 — pull-to-refresh site-wide.
  // v14.53 — destructure indicator so the pull gesture has visible feedback (gold chip at top)
  const { indicator: ptrIndicator } = usePullToRefresh(() => qc.invalidateQueries());
  const fileRef = useRef<HTMLInputElement>(null);
  // Activity Feed
  const [feedOpen, setFeedOpen] = useState(false);
  // v14.51 — Admin tabs now controlled so the bottom nav can activate them.
  const [adminTab, setAdminTab] = useState<string>("leaderboard");
  // v14.49 — admin "Who called me?" modal state.
  const [adminLookupOpen, setAdminLookupOpen] = useState(false);

  // v14.54 — red notification badge on the Dial bottom-nav button (admin uses AgentView
  // routing under the hood via onWorkMyLeads). Fetch this admin's own queue count so the
  // badge lights up when leads are ready for THEM to work, not the whole pool.
  const { data: adminQueueCountData } = useQuery<{ count: number }>({
    queryKey: [`/api/leads/my-count/${user?.id}`],
    queryFn: () => fetch(`/api/leads/my-count/${user?.id}`).then(r => r.json()),
    enabled: !!user?.id,
    refetchInterval: 30_000,
  });
  const adminQueueCount = adminQueueCountData?.count ?? 0;
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;
      ws.onclose = () => { setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => { wsRef.current?.close(); };
  }, []);
  const [uploading, setUploading] = useState(false);
  const [uploadRowCount, setUploadRowCount] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadType, setUploadType] = useState<"expired">("expired");
  // Agent recruiting state
  const agentLeadFileRef = useRef<HTMLInputElement>(null);
  const [agentLeadDragOver, setAgentLeadDragOver] = useState(false);
  const [agentLeadUploading, setAgentLeadUploading] = useState(false);
  const [agentLeadRowCount, setAgentLeadRowCount] = useState<number | null>(null);
  const [quickAddForm, setQuickAddForm] = useState({ firstName: "", lastName: "", phone: "", email: "", currentBrokerage: "", licenseStatus: "", territory: "", notes: "" });
  const [quickAddSubmitting, setQuickAddSubmitting] = useState(false);
  const [recruitingSubTab, setRecruitingSubTab] = useState<"pipeline" | "leaderboard" | "quick" | "bulk">("pipeline");
  const [recruitingStatusFilter, setRecruitingStatusFilter] = useState<string>("all");
  const [recruitingDeleteConfirm, setRecruitingDeleteConfirm] = useState<number | null>(null);
  const [recruitingDncConfirm, setRecruitingDncConfirm] = useState<number | null>(null);
  const [recruitingLbPeriod, setRecruitingLbPeriod] = useState<"today" | "week" | "allTime">("week");
  const [dbprRunning, setDbprRunning] = useState(false);
  const [dbprResult, setDbprResult] = useState<any>(null);
  // v14.46 — LandVoice OAuth state + handlers removed. LandVoice CSVs come in via /api/admin/import-batchleads-csv.
  const dbprStatsQuery = useQuery({
    queryKey: ["/api/admin/dbpr-stats"],
    queryFn: () => apiRequest("GET", "/api/admin/dbpr-stats").then(r => r.json()),
    staleTime: 60_000,
  });
  const recruitingPipelineQuery = useQuery({
    queryKey: ["/api/admin/recruiting/pipeline", recruitingStatusFilter],
    queryFn: () => apiRequest("GET", `/api/admin/recruiting/pipeline?status=${recruitingStatusFilter}`).then(r => r.json()),
    staleTime: 30_000,
    enabled: recruitingSubTab === "pipeline",
  });
  const recruitingLeaderboardQuery = useQuery({
    queryKey: ["/api/admin/recruiting/leaderboard"],
    queryFn: () => apiRequest("GET", "/api/admin/recruiting/leaderboard").then(r => r.json()),
    staleTime: 30_000,
    enabled: recruitingSubTab === "leaderboard",
  });
  const [newAgent, setNewAgent] = useState({ name: "", email: "", role: "agent" });
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<any | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [drilldownAgent, setDrilldownAgent] = useState<{ id: number; name: string } | null>(null);

  // Paginated leads state (v11.70)
  const [leadsPage, setLeadsPage] = useState(0);
  const LEADS_PAGE_SIZE = 50;
  const [lbHistoryOpen, setLbHistoryOpen] = useState(false);

  // Data queries
  const { data: stats } = useQuery({
    queryKey: ["/api/leads/stats"],
    queryFn: () => apiRequest("GET", "/api/leads/stats").then(r => r.json()),
    refetchInterval: 20000,
  });

  const { data: agentStats = [], isLoading: agentStatsLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/agent-stats"],
    queryFn: () => apiRequest("GET", "/api/admin/agent-stats").then(r => r.json()),
    refetchInterval: 15000,
  });

  const [lbTab, setLbTab] = useState<"today" | "weekly">("today");

  // ── Confirmation dialog state ──────────────────────────────────────────────
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    confirmColor: string;
    onConfirm: () => void;
  }>({
    open: false, title: "", message: "", confirmLabel: "Confirm", confirmColor: "#c8aa5a", onConfirm: () => {},
  });
  const closeConfirm = useCallback(() => setConfirmDialog(d => ({ ...d, open: false })), []);
  const openConfirm = useCallback((opts: { title: string; message: string; confirmLabel?: string; confirmColor?: string; onConfirm: () => void }) => {
    setConfirmDialog({ open: true, confirmLabel: "Confirm", confirmColor: "#c8aa5a", ...opts });
  }, []);
  const { data: dualLb = [], isLoading: dualLbLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/leaderboard"],
    queryFn: () => apiRequest("GET", "/api/admin/leaderboard").then(r => r.json()),
    refetchInterval: 60000,
  });

  // v14.49 — myQueueData removed. Pull-only model: no per-agent queues to display.

  const { data: pipeline, isLoading: pipelineLoading } = useQuery<any>({
    queryKey: ["/api/admin/pipeline"],
    queryFn: () => apiRequest("GET", "/api/admin/pipeline").then(r => r.json()),
    refetchInterval: 15000,
  });

  // Paginated lead list query (v11.70) — replaces full pipeline load for Lead Pool tab
  const paginatedLeadsQuery = useQuery<any>({
    queryKey: ["/api/leads/paginated", statusFilter, searchTerm, leadsPage],
    queryFn: () => {
      const params = new URLSearchParams({
        limit: String(LEADS_PAGE_SIZE),
        offset: String(leadsPage * LEADS_PAGE_SIZE),
        status: statusFilter,
        ...(searchTerm ? { search: searchTerm } : {}),
      });
      return apiRequest("GET", `/api/leads/paginated?${params}`).then(r => r.json());
    },
    placeholderData: keepPreviousData,
  });

  // Reset to page 0 when filters change
  const prevStatusFilter = useRef(statusFilter);
  const prevSearchTerm = useRef(searchTerm);
  useEffect(() => {
    if (prevStatusFilter.current !== statusFilter || prevSearchTerm.current !== searchTerm) {
      setLeadsPage(0);
      prevStatusFilter.current = statusFilter;
      prevSearchTerm.current = searchTerm;
    }
  }, [statusFilter, searchTerm]);

  // Leaderboard history (v11.70)
  const { data: lbHistory = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/leaderboard-history"],
    queryFn: () => apiRequest("GET", "/api/admin/leaderboard-history").then(r => r.json()),
    enabled: lbHistoryOpen,
  });

  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
    queryFn: () => apiRequest("GET", "/api/agents").then(r => r.json()),
  });

  // v12.5 — Territories with open/closed state. Drives the two-slot picker
  // (disable closed options) and the Territory Management panel below.
  // v12.5 — /api/territories returns a plain array (not { territories: [...] })
  const { data: territoriesData } = useQuery<{ key: string; name: string; isOpen: boolean; leadCount: number }[]>({
    queryKey: ["/api/territories"],
    queryFn: () => apiRequest("GET", "/api/territories").then(r => r.json()),
    refetchInterval: 60000,
  });
  const allTerritories = Array.isArray(territoriesData) ? territoriesData : [];
  // v13.1 — Use .key here (matches TERRITORY_OPTIONS.value like "clay_county").
  // Prior v12.5 used .name which never matched, so every option showed as (closed).
  const openTerritoryNames = allTerritories.filter(t => t.isOpen).map(t => t.key);

  // v12.5 — Get Leads Now / Hard Reset helpers
  const [hardResetOpen, setHardResetOpen] = useState<null | "seller" | "recruiting">(null);
  const [hardResetBusy, setHardResetBusy] = useState(false);
  const [hardResetInput, setHardResetInput] = useState("");
  // v13.2 — Reactivate Retired Leads (go-live helper)
  const [busyReactivate, setBusyReactivate] = useState(false);
  const reactivateRetiredLeads = async () => {
    if (!confirm("Reactivate ALL retired leads and round-robin them across active agents? This puts them back in the queue as fresh, unassigned leads.")) return;
    setBusyReactivate(true);
    try {
      const r = await apiRequest("POST", "/api/admin/reactivate-retired-leads", {});
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        alert(`Reactivated ${j.reactivated ?? 0} leads. Assigned ${j.assigned ?? 0} to agents.`);
        qc.invalidateQueries({ queryKey: ["stats"] });
        qc.invalidateQueries({ queryKey: ["/api/leads/paginated"] });
      } else {
        alert("Reactivate failed: " + (j.error || r.statusText));
      }
    } catch (e: any) {
      alert("Reactivate failed: " + e.message);
    } finally {
      setBusyReactivate(false);
    }
  };
  const [busyGetLeads, setBusyGetLeads] = useState<null | "recruiting">(null);
  const [busyCsvImport, setBusyCsvImport] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const runCsvImport = async (file: File) => {
    setBusyCsvImport(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const agentId = (window as any).localStorage?.getItem("agentId") || "1";
      const r = await fetch("/api/admin/import-batchleads-csv", {
        method: "POST", body: fd, headers: { "x-agent-id": agentId },
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        const byC = Object.entries(j.byCounty || {}).map(([k,v]) => `${k}: ${v}`).join(", ");
        const byT = Object.entries(j.byType || {}).map(([k,v]) => `${k}: ${v}`).join(", ");
        const mergedNote = j.merged ? ` · refreshed ${j.merged} existing (new phones/MLS intel)` : "";
        const identicalNote = j.skippedIdentical ? ` · ${j.skippedIdentical} identical skipped` : "";
        toast({ title: `Imported ${j.inserted} new leads`, description: `By type: ${byT}. Counties: ${byC}.${mergedNote}${identicalNote}` });
        qc.invalidateQueries();
      } else {
        toast({ title: "Import failed", description: j.error || r.statusText, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Import failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setBusyCsvImport(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  };
  // v14.46 — Seller pipeline removed. Only recruiting DBPR fetch remains.
  const runGetLeadsNow = async (which: "recruiting") => {
    setBusyGetLeads(which);
    try {
      const r = await apiRequest("POST", "/api/admin/dbpr-run", {});
      const j = await r.json().catch(() => ({}));
      toast({ title: "Recruiting pipeline started", description: j.message || "Running now." });
    } catch (err: any) {
      toast({ title: "Failed to start pipeline", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setBusyGetLeads(null);
    }
  };
  const runHardReset = async () => {
    if (!hardResetOpen || hardResetInput !== "RESET" || hardResetBusy) return;
    setHardResetBusy(true);
    const side = hardResetOpen;
    try {
      const url = side === "seller" ? "/api/admin/seller-hard-reset" : "/api/admin/recruiting-hard-reset";
      const r = await apiRequest("POST", url, { confirm: "RESET" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      // Close modal first so user sees the change immediately.
      setHardResetOpen(null);
      setHardResetInput("");
      // Force-refresh every query so numbers snap to zero on-screen.
      await qc.invalidateQueries();
      await qc.refetchQueries({ type: "active" });
      const cleared = body?.cleared || {};
      const n = cleared.leads ?? 0;
      toast({
        title: `${side === "seller" ? "Seller" : "Recruiting"} depot cleared`,
        description: `${n} lead${n === 1 ? "" : "s"} deleted. Ready for a fresh upload.`,
      });
    } catch (err: any) {
      toast({ title: "Reset failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setHardResetBusy(false);
    }
  };
  const closeTerritoryMutation = useMutation({
    mutationFn: async ({ name, close }: { name: string; close: boolean }) => {
      const path = close ? "close" : "open";
      const r = await apiRequest("POST", `/api/admin/territories/${name}/${path}`, {});
      return r.json();
    },
    onSuccess: (_d, v) => {
      toast({ title: `Territory ${v.close ? "closed" : "reopened"}` });
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
    },
    onError: (e: any) => toast({ title: "Failed to update territory", description: e?.message || String(e), variant: "destructive" }),
  });

  const createAgentMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/agents/invite", data).then(async r => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "Failed to invite agent");
      return body;
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      setAgentDialogOpen(false);
      setNewAgent({ name: "", email: "", role: "agent" });
      toast({ title: "Invitation sent", description: "The agent will receive an email to complete their account setup." });
    },
    onError: (e: any) => toast({ title: e.message || "Email already exists", variant: "destructive" }),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to deactivate agent");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      toast({ title: "Agent moved to Inactive" });
    },
    onError: (err: any) => {
      toast({ title: "Cannot deactivate agent", description: err.message, variant: "destructive" });
    },
  });

  const reactivateAgentMutation = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/agents/${id}/reactivate`, {}).then(async r => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to reactivate");
      return j;
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      toast({ title: "Agent reactivated" });
    },
    onError: (err: any) => {
      toast({ title: "Reactivation failed", description: err?.message || "Could not reactivate agent", variant: "destructive" });
    },
  });

  // v14.81.2 — Hard-delete an inactive agent. Permanent, orphans historical
  // activity rows to NULL agent_id, unassigns leads, deletes locks, removes
  // the agent row entirely. Requires a confirmation dialog before firing.
  const hardDeleteAgentMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/agents/${id}/hard-delete`, {}).then(async r => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to delete");
      return j;
    }),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      toast({ title: "Agent deleted", description: `${data.deletedName} permanently removed. Historical activity preserved as anonymous.` });
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err?.message || "Could not delete agent", variant: "destructive" });
    },
  });

  // v14.62 Phase D — admin-triggered password reset. Server thin-wraps forgot-password
  // flow so admin gets real success/failure feedback (unlike public endpoint which
  // always 200s to prevent email enumeration).
  const resetPasswordMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/agents/${id}/reset-password`, {}).then(async r => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to send reset email");
      return j;
    }),
    onSuccess: (data: any) => {
      toast({ title: "Reset email sent", description: `Password reset link delivered to ${data.email}. Expires in 1 hour.` });
    },
    onError: (err: any) => {
      toast({ title: "Reset failed", description: err?.message || "Could not send reset email", variant: "destructive" });
    },
  });

  // v14.62 Phase D — merge two agents. Source becomes a tombstone pointing at target;
  // all leads / activities re-parent to target. Uses existing POST /api/admin/agents/merge
  // (Phase B shared function — admin path and self-service path stay identical).
  const mergeAgentMutation = useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: number; targetId: number }) =>
      apiRequest("POST", "/api/admin/agents/merge", { sourceId, targetId }).then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Merge failed");
        return j;
      }),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      toast({ title: "Agents merged", description: `Source is now a tombstone. ${data.remappedLeads ?? 0} leads re-parented.` });
    },
    onError: (err: any) => {
      toast({ title: "Merge failed", description: err?.message || "Could not merge agents", variant: "destructive" });
    },
  });

  // v14.62 Phase D — audit log drawer state
  const [auditLogAgentId, setAuditLogAgentId] = useState<number | null>(null);
  const auditLogQuery = useQuery<{ agentId: number; count: number; entries: any[] }>({
    queryKey: ["/api/admin/agents", auditLogAgentId, "audit-log"],
    queryFn: () => apiRequest("GET", `/api/admin/agents/${auditLogAgentId}/audit-log?limit=200`).then(r => r.json()),
    enabled: auditLogAgentId !== null,
  });

  // v14.62 Phase D — merge dialog state
  const [mergeSourceAgent, setMergeSourceAgent] = useState<Agent | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);

  const { data: prospectingData, refetch: refetchProspecting } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/settings/agent-prospecting-mode"],
    queryFn: () => apiRequest("GET", "/api/settings/agent-prospecting-mode").then(r => r.json()),
    refetchInterval: 10000,
  });
  const prospectingMode = prospectingData?.enabled ?? false;

  const toggleProspectingMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("POST", "/api/settings/agent-prospecting-mode", { enabled }).then(r => r.json()),
    onSuccess: () => refetchProspecting(),
  });

  const leaderboardResetMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/leaderboard-reset", {}).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      toast({ title: "Leaderboard reset", description: "Stats now count from this moment forward." });
    },
  });

  const toggleReceiveLeadsMutation = useMutation({
    mutationFn: ({ id, receiveLeads }: { id: number; receiveLeads: boolean }) =>
      apiRequest("PATCH", `/api/agents/${id}/receive-leads`, { receiveLeads }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/agents"] }),
  });

  const toggleLeadFlowMutation = useMutation({
    mutationFn: async ({ id, leadFlowOn }: { id: number; leadFlowOn: boolean }) => {
      const res = await fetch(`/api/agents/${id}/lead-flow`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadFlowOn }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update lead flow");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
    },
    onError: (err: any) => {
      toast({ title: "Cannot turn off lead flow", description: err.message, variant: "destructive" });
    },
  });

  // v14.47 — admin can edit any agent's email inline. Uses existing PATCH /api/agents/:id
  // allowlist (already includes "email"). Simple prompt-based UX — no modal needed for a
  // rarely-used admin fix. Lowercase-normalizes on submit to match login lookup.
  const handleEditAgentEmail = useCallback((agent: { id: number; name: string; email: string }) => {
    const next = window.prompt(`Edit email for ${agent.name}:`, agent.email || "");
    if (next === null) return; // cancelled
    const trimmed = next.trim().toLowerCase();
    if (!trimmed) {
      toast({ title: "Email required", description: "Email cannot be blank.", variant: "destructive" });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toast({ title: "Invalid email", description: `"${trimmed}" is not a valid email address.`, variant: "destructive" });
      return;
    }
    if (trimmed === (agent.email || "").toLowerCase()) return; // no-op
    apiRequest("PATCH", `/api/agents/${agent.id}`, { email: trimmed })
      .then(r => r.json())
      .then(() => {
        toast({ title: "Email updated", description: `${agent.name} → ${trimmed}` });
        qc.invalidateQueries({ queryKey: ["/api/agents"] });
      })
      .catch((err: any) => {
        toast({ title: "Update failed", description: err?.message || "Could not update email", variant: "destructive" });
      });
  }, [qc, toast]);

  const redistributeUnseenMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/redistribute-unseen").then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/my-next"] });
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/leads/my-count") });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      const skippedNote = data.skipped > 0 ? ` ${data.skipped} could not be assigned (no eligible agent for that lead type).` : "";
      if (data.reassigned === 0 && data.total === 0) {
        toast({ title: "No unseen leads", description: "All leads have already been contacted or are in a closed state." });
      } else if (data.reassigned === 0) {
        toast({ title: "No leads redistributed", description: `${data.total} unseen lead${data.total === 1 ? "" : "s"} found but none could be assigned — check that at least one agent is active and receiving leads.` });
      } else {
        toast({ title: "Unseen leads redistributed", description: `${data.reassigned} lead${data.reassigned === 1 ? "" : "s"} re-assigned across active agents.${skippedNote}` });
      }
    },
    onError: (err: any) => toast({ title: "Error", description: err?.message || "Failed to redistribute unseen leads.", variant: "destructive" }),
  });

  const clearQueueMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/leads/clear-queue", { clearedBy: user?.id }).then(r => r.json()),
    onSuccess: (data) => {
      toast({ title: "Queue cleared", description: data.message });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/stats"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/pipeline"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
    },
    onError: () => toast({ title: "Error clearing queue", variant: "destructive" }),
  });

  // v14.81.2 — Upload CSV tab now routes to the SAME smart server-side parser used
  // by "Import BatchLeads CSV": /api/admin/import-batchleads-csv. That parser
  // auto-detects LandVoice SkipTraced listing, LandVoice Expired listing, and
  // BatchLeads xlsx exports; extracts all phones (with per-phone DNC + rank),
  // MLS number, DOM, remarks, list agent, and mailing address; and infers
  // county from zip. The old client-side parseCSV + /api/leads/upload path
  // silently dropped LandVoice rows whose top-level Primary Phone was empty.
  const processFile = async (file: File) => {
    if (!file) return;
    setUploading(true);
    setUploadRowCount(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const agentId = (window as any).localStorage?.getItem("agentId") || String(user?.id || "1");
      const res = await fetch("/api/admin/import-batchleads-csv", {
        method: "POST", body: fd, headers: { "x-agent-id": agentId },
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || res.statusText || "Upload failed");
      setUploadRowCount(data.rowsInFile ?? null);
      const byC = Object.entries(data.byCounty || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
      const byT = Object.entries(data.byType || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
      const mergedNote2 = data.merged ? ` · refreshed ${data.merged} existing` : "";
      const identicalNote2 = data.skippedIdentical ? ` · ${data.skippedIdentical} identical skipped` : "";
      const dupNote = `${mergedNote2}${identicalNote2}`;
      toast({
        title: `Imported ${data.inserted} of ${data.rowsInFile} leads`,
        description: `${byT ? `Types: ${byT}. ` : ""}${byC ? `Counties: ${byC}. ` : ""}Leads are in the shared pool — agents pull via Work My Leads.${dupNote}`,
      });
      setTimeout(() => setUploadRowCount(null), 8000);
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/stats"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/pipeline"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
    } catch (err: any) {
      toast({ title: "Upload error", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // ── Agent Lead Handlers ────────────────────────────────────────────────────
  const handleSubmitQuickAdd = async () => {
    const { firstName, lastName, phone } = quickAddForm;
    if (!firstName || !lastName || !phone) {
      toast({ title: "Missing fields", description: "First name, last name, and phone are required.", variant: "destructive" });
      return;
    }
    setQuickAddSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/agent-leads/manual-add", quickAddForm);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add agent lead");
      toast({ title: "Agent lead added", description: `${firstName} ${lastName} added to recruiting queue.` });
      setQuickAddForm({ firstName: "", lastName: "", phone: "", email: "", currentBrokerage: "", licenseStatus: "", territory: "", notes: "" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setQuickAddSubmitting(false);
    }
  };

  const processAgentLeadFile = async (file: File) => {
    if (!file) return;
    setAgentLeadUploading(true);
    setAgentLeadRowCount(null);
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (!rows.length) throw new Error("No valid rows found in CSV");
      setAgentLeadRowCount(rows.length);
      const res = await apiRequest("POST", "/api/agent-leads/bulk-upload", { leads: rows });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      const skipNote = data.skipped > 0 ? ` ${data.skipped} skipped (missing name or phone).` : "";
      toast({ title: `${data.created} agent prospects imported`, description: `Added to recruiting queue.${skipNote}` });
      setAgentLeadRowCount(null);
    } catch (err: any) {
      toast({ title: "Upload error", description: err.message, variant: "destructive" });
    } finally {
      setAgentLeadUploading(false);
      if (agentLeadFileRef.current) agentLeadFileRef.current.value = "";
    }
  };

  const handleAgentLeadUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processAgentLeadFile(file);
  };

  const handleAgentLeadDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setAgentLeadDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.endsWith(".csv")) {
      processAgentLeadFile(file);
    } else {
      toast({ title: "Please drop a .csv file", variant: "destructive" });
    }
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    // v14.81.2 — accept .csv, .xlsx, and .xls (BatchLeads Excel exports).
    if (file && /\.(csv|xlsx|xls)$/i.test(file.name)) {
      processFile(file);
    } else {
      toast({ title: "Please drop a .csv, .xlsx, or .xls file", variant: "destructive" });
    }
  };


  // Weekly dials snapshot (v14 — motivation over shaming)
  const { data: weeklyDialsData } = useQuery<{
    agents: Array<{ id: number; name: string; email: string; headshotUrl: string | null; thisWeekDials: number }>;
    weekStart: string;
  }>({
    queryKey: ["/api/admin/agent-inactivity"],
    queryFn: () => apiRequest("GET", "/api/admin/agent-inactivity").then(r => r.json()),
    refetchInterval: 5 * 60 * 1000, // refresh every 5min
  });
  const weeklyDials = weeklyDialsData?.agents ?? [];
  const weeklyDialsTotal = weeklyDials.reduce((sum, a) => sum + (a.thisWeekDials ?? 0), 0);

  const handleExportCSV = () => {
    window.open("/api/export/leads", "_blank");
  };

  const handleExportActivity = () => {
    window.open("/api/export/activity", "_blank");
  };


  const allLeads: any[] = pipeline?.leads || [];
  const filteredLeads = allLeads.filter(l => {
    const matchSearch = !searchTerm ||
      l.address?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      l.ownerName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      l.phone?.includes(searchTerm);
    const matchStatus = statusFilter === "all" || l.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const byStatus = pipeline?.byStatus || {};
  const pipelineStages = [
    { key: "unassigned",              label: "Unassigned",    color: "rgba(255,255,255,0.4)",  bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.08)" },
    { key: "assigned",                label: "Assigned",      color: "rgb(147,197,253)",        bg: "rgba(59,130,246,0.06)",  border: "rgba(59,130,246,0.15)" },
    { key: "no_answer",               label: "No Answer",     color: "rgb(253,224,71)",          bg: "rgba(234,179,8,0.06)",   border: "rgba(234,179,8,0.15)" },
    { key: "keep_in_touch",           label: "Keep in Touch", color: "rgb(249,168,212)",        bg: "rgba(236,72,153,0.06)",  border: "rgba(236,72,153,0.15)" },
    { key: "callback_requested",      label: "Callback",      color: "rgb(103,232,249)",        bg: "rgba(34,211,238,0.06)",  border: "rgba(34,211,238,0.15)" },
    { key: "contacted_appointment",   label: "Appt Set ✓",   color: "rgb(134,239,172)",        bg: "rgba(34,197,94,0.06)",   border: "rgba(34,197,94,0.15)" },
    { key: "contacted_not_interested",label: "Not Interested",color: "rgb(252,165,165)",        bg: "rgba(239,68,68,0.06)",   border: "rgba(239,68,68,0.15)" },
    { key: "wrong_number",            label: "Wrong #",       color: "rgba(252,165,165,0.6)",   bg: "rgba(239,68,68,0.03)",   border: "rgba(239,68,68,0.1)" },
  ];

  // ── Luxury toggle component ──────────────────────────────────────────────────
  const LuxToggle = ({ on, onToggle, disabled, testId, activeColor = "rgba(34,197,94,0.25)", activeDot = "#86efac" }: {
    on: boolean; onToggle: () => void; disabled?: boolean;
    testId?: string; activeColor?: string; activeDot?: string;
  }) => (
    <button
      onClick={onToggle}
      disabled={disabled}
      data-testid={testId}
      style={{
        position: "relative", display: "inline-flex",
        height: 22, width: 40,
        alignItems: "center", borderRadius: 11,
        background: on ? activeColor : "rgba(255,255,255,0.08)",
        border: `1px solid ${on ? activeDot + "60" : "rgba(255,255,255,0.12)"}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.35 : 1,
        transition: "all 0.2s",
        padding: 0,
      }}
    >
      <span style={{
        position: "absolute",
        width: 14, height: 14, borderRadius: "50%",
        background: on ? activeDot : "rgba(255,255,255,0.4)",
        left: on ? 23 : 3,
        transition: "left 0.2s, background 0.2s",
      }} />
    </button>
  );

  return (
    <div className="ld-bg-wrap" style={{ minHeight: "100dvh", background: "#080808" }}>
      {/* v14.53 — Pull-to-refresh visible indicator */}
      {ptrIndicator}
      {/* Luxury ambient glows */}
      <div className="ld-glow" />
      <div className="ld-glow-corner" />

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 20,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 20px",
        background: "rgba(8,8,8,0.95)",
        backdropFilter: "blur(16px)",
        borderBottom: "1px solid rgba(200,170,90,0.1)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
              {user?.name} — Admin
            </p>
            <p style={{ fontSize: 9, color: "rgba(200,170,90,0.45)", letterSpacing: "0.14em", textTransform: "uppercase", lineHeight: 1, marginTop: 3, fontWeight: 600 }}>
              v14.81.2
            </p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Connectivity Health Widget */}
          <HealthWidget />
          {/* Activity Feed toggle */}
          <button
            onClick={() => setFeedOpen(o => !o)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 34, height: 34, borderRadius: 8,
              background: feedOpen ? "rgba(200,170,90,0.15)" : "rgba(255,255,255,0.05)",
              border: feedOpen ? "1px solid rgba(200,170,90,0.4)" : "1px solid rgba(255,255,255,0.1)",
              cursor: "pointer", position: "relative",
              animation: "feedPulseBtn 3s ease infinite",
            }}
            title="Live Activity Feed"
          >
            <Activity size={15} style={{ color: feedOpen ? "#c8aa5a" : "rgba(255,255,255,0.5)" }} />
          </button>
          <style>{`@keyframes feedPulseBtn { 0%,100%{box-shadow:0 0 0 0 rgba(200,170,90,0.3)} 50%{box-shadow:0 0 0 4px rgba(200,170,90,0)} }`}</style>
          {/* Prospecting Mode Toggle removed — Recruiting tab handles this separately */}
          {/* v14.49 — Admin always sees Work My Leads + Who called me? (receiveLeads gate removed). */}
          {user?.role === "admin" && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs"
                style={{ borderColor: "rgba(200,170,90,0.3)", color: "#c8aa5a" }}
                onClick={() => onWorkMyLeads?.()}
              >
                <Phone size={11}/> Work My Leads
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs"
                style={{ borderColor: "rgba(200,170,90,0.3)", color: "#c8aa5a" }}
                onClick={() => setAdminLookupOpen(true)}
              >
                <PhoneCall size={11}/> Who called me?
              </Button>
            </>
          )}
          <button
            onClick={logout}
            title="Sign out"
            className="ld-signout-btn"
            style={{
              display: "flex", alignItems: "center", gap: 5,
              fontSize: 11, color: "rgba(255,255,255,0.3)",
              background: "none", border: "none", cursor: "pointer",
              letterSpacing: "0.04em", flexShrink: 0, whiteSpace: "nowrap",
            }}
          >
            <LogOut size={13}/> <span className="ld-signout-label">Sign out</span>
          </button>
          <style>{`
            @media (max-width: 480px){.ld-signout-label{display:none}.ld-signout-btn{padding:4px}}
            /* v14.54 — Admin Leaderboard density fix. On phones we HIDE the supporting columns
               (KIT / Conv% / Emails / Refs) so agent names get room to breathe. IMG_9237 showed
               names truncating to a single letter ("B..", "A..", "N..") because 6 stat columns
               were fighting for space. Only Appts + Pts + Dials remain on mobile — the actual
               podium metrics. Full column set still visible on tablets+ (≥641px). */
            @media (max-width: 640px){
              .ld-lb-cols{gap:12px !important}
              .ld-lb-cols>div{width:auto !important; min-width:36px}
              .ld-lb-supporting{display:none !important}
            }
          `}</style>
        </div>
      </header>

      <main style={{ padding: "20px 16px", maxWidth: 1200, margin: "0 auto" }}>
        {/* v14.19 — Admin default landing = Leaderboard (leftmost). Leaderboard sub-tab defaults to Today (see lbTab state). */}
        <Tabs value={adminTab} onValueChange={(v) => setAdminTab(v)}>
          {/* ── Tab bar ──────────────────────────────────────────────────────── */}
          <TabsList style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(200,170,90,0.12)",
            borderRadius: 8, padding: 4, height: "auto",
            display: "flex", flexWrap: "wrap", gap: 2,
          }}>
            {[
              { value: "leaderboard", icon: Trophy,     label: "Leaderboard" },
              { value: "admin",       icon: Shield,      label: "Admin" },
              { value: "leads",       icon: List,        label: "Lead Pool" },
              { value: "map",         icon: MapIcon,     label: "Map View" },
              { value: "reports",     icon: BarChart2,   label: "Reports" },
              { value: "upload",      icon: Upload,      label: "Upload CSV" },
              { value: "recruiting",  icon: Users,       label: "Recruiting" },
              { value: "agents",      icon: Users,       label: "Agents" },
              { value: "scripts",     icon: ScrollText,  label: "Scripts" },
              { value: "profile",     icon: Settings,    label: "My Profile" },
            ].map(tab => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="gap-1.5 text-xs"
                style={{ borderRadius: 6 }}
              >
                <tab.icon size={12}/>{tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* ── ADMIN (v13.1) — Consolidated admin controls: Toolbar, Territories, Queue Mgmt, Inactivity Alert ── */}
          <TabsContent value="admin" className="mt-5 space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {/* v14.49 — Pull-only model: no per-agent queues. Removed "My Lead Queue". Renamed "Active in Queue" → "Active in Pool". */}
              <StatCard label="Total Leads" value={stats?.totalLeads ?? 0} />
              <StatCard label="Active in Pool" value={stats?.activeLeads ?? 0} accent="text-white" />
              <StatCard label="Appointments Set" value={stats?.appointmentsSet ?? 0} accent="text-green-400" />
            </div>

            {/* Seller Depot admin toolbar: Get Leads Now, Hard Reset, Territory management, Recruiting link */}
            <div style={{
              display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, alignItems: "center",
              padding: 12, background: "rgba(200,170,90,0.04)",
              border: "1px solid rgba(200,170,90,0.15)", borderRadius: 10,
            }}>
              {/* v14.46 — Seller "Get Leads Now" button removed. Use "Import BatchLeads CSV" instead. */}
              <input
                ref={csvInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) runCsvImport(f); }}
              />
              <button
                onClick={() => csvInputRef.current?.click()}
                disabled={busyCsvImport}
                style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                  padding: "7px 14px", borderRadius: 6, border: "1px solid rgba(200,170,90,0.4)",
                  cursor: busyCsvImport ? "wait" : "pointer",
                  background: "rgba(200,170,90,0.08)", color: "#c8aa5a",
                }}
              >{busyCsvImport ? "Importing…" : "⇧ Import BatchLeads CSV"}</button>
              <button
                onClick={reactivateRetiredLeads}
                disabled={busyReactivate}
                style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                  padding: "7px 14px", borderRadius: 6, border: "1px solid rgba(200,170,90,0.4)",
                  cursor: busyReactivate ? "wait" : "pointer",
                  background: "rgba(200,170,90,0.08)", color: "#c8aa5a",
                }}
              >{busyReactivate ? "Reactivating…" : "♻ Reactivate Retired Leads"}</button>
              <a
                href="#/recruiting"
                style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                  padding: "7px 14px", borderRadius: 6, textDecoration: "none",
                  background: "rgba(79,184,163,0.1)", color: "#4fb8a3",
                  border: "1px solid rgba(79,184,163,0.3)",
                }}
              >Recruiting Depot →</a>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => setHardResetOpen("seller")}
                style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                  padding: "7px 14px", borderRadius: 6, cursor: "pointer",
                  background: "rgba(239,68,68,0.1)", color: "#ef4444",
                  border: "1px solid rgba(239,68,68,0.4)",
                }}
              >⚠ Hard Reset Seller</button>
            </div>

            {/* v14.46 — LandVoice OAuth Connect card removed. CSV upload only. */}

            {/* v14.0 — Territory Management panel removed. Leads flow county-first via Home County. */}

            {/* Queue Management (moved from Agents tab) */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 16 }}>
              <p style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,170,90,0.55)", fontWeight: 600, marginBottom: 14 }}>Queue Management</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {/* Redistribute Unseen */}
                <div style={{ background: "rgba(200,170,90,0.04)", border: "1px solid rgba(200,170,90,0.15)", borderRadius: 10, padding: 14 }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Users size={12} style={{ color: "rgba(200,170,90,0.8)" }}/>
                    <p className="text-xs font-semibold" style={{ color: "rgba(200,170,90,0.9)" }}>Redistribute Unseen</p>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3" style={{ lineHeight: 1.5 }}>Re-assigns every untouched lead evenly across active agents.</p>
                  <Button variant="outline" size="sm"
                    style={{ borderColor: "rgba(200,170,90,0.3)", color: "rgba(200,170,90,0.85)", fontSize: 11, width: "100%" }}
                    className="gap-1.5 hover:bg-yellow-900/20"
                    onClick={() => openConfirm({
                      title: "Redistribute Unseen Leads?",
                      message: "This will re-assign every lead no agent has interacted with yet — including already-assigned leads that haven't been touched. All agents get a fresh even share. This cannot be undone.",
                      confirmLabel: "Redistribute",
                      onConfirm: () => { closeConfirm(); redistributeUnseenMutation.mutate(); },
                    })}
                    disabled={redistributeUnseenMutation.isPending}
                  >
                    <Users size={10}/>{redistributeUnseenMutation.isPending ? "Redistributing…" : "Redistribute"}
                  </Button>
                </div>
                {/* Clear Queue */}
                <div style={{ background: "rgba(239,68,68,0.04)", border: "1px solid rgba(239,68,68,0.12)", borderRadius: 10, padding: 14 }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Trash size={12} className="text-red-400"/>
                    <p className="text-xs font-semibold text-red-300">Clear Active Queue</p>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3" style={{ lineHeight: 1.5 }}>Retires all active leads. History is preserved — no data deleted.</p>
                  <Button variant="outline" size="sm"
                    className="border-red-900/40 text-red-400 hover:bg-red-900/20 hover:text-red-300 text-xs gap-1.5"
                    style={{ width: "100%", fontSize: 11 }}
                    onClick={() => openConfirm({
                      title: "Clear Active Queue?",
                      message: "All in-progress leads will be marked Retired. Master records and full history are preserved — no data is deleted. Only the active queue is cleared.",
                      confirmLabel: "Clear Queue",
                      confirmColor: "#ef4444",
                      onConfirm: () => { closeConfirm(); clearQueueMutation.mutate(); },
                    })}
                    disabled={clearQueueMutation.isPending}
                    data-testid="button-clear-queue"
                  >
                    <Trash size={10}/>{clearQueueMutation.isPending ? "Clearing…" : "Clear Queue"}
                  </Button>
                </div>
              </div>
            </div>

            {/* v14.0 — Dials This Week snapshot (motivation over shaming) */}
            <div
              style={{
                background: "rgba(20,20,20,0.7)",
                border: "1px solid rgba(200,170,90,0.35)",
                borderRadius: 14,
                padding: 18,
                marginTop: 18,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
                <p
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    color: "rgba(200,170,90,0.55)",
                    fontWeight: 600,
                  }}
                >
                  Dials This Week
                </p>
                <p style={{ fontSize: 12, color: "#c8aa5a", fontWeight: 600 }}>
                  Team total: {weeklyDialsTotal}
                </p>
              </div>
              {weeklyDials.length === 0 ? (
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>No active agents yet.</p>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                    gap: 10,
                  }}
                >
                  {weeklyDials
                    .slice()
                    .sort((a, b) => (b.thisWeekDials ?? 0) - (a.thisWeekDials ?? 0))
                    .map((agent) => (
                      <div
                        key={agent.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 12px",
                          background: "rgba(0,0,0,0.35)",
                          border: "1px solid rgba(200,170,90,0.15)",
                          borderRadius: 10,
                        }}
                      >
                        {agent.headshotUrl ? (
                          <img
                            src={agent.headshotUrl}
                            alt={agent.name}
                            style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover" }}
                          />
                        ) : (
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: "50%",
                              background: "rgba(200,170,90,0.15)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 12,
                              color: "#c8aa5a",
                              fontWeight: 600,
                            }}
                          >
                            {agent.name?.charAt(0) ?? "?"}
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p
                            style={{
                              fontSize: 13,
                              color: "#fff",
                              fontWeight: 500,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {agent.name}
                          </p>
                          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                            {agent.thisWeekDials} {agent.thisWeekDials === 1 ? "dial" : "dials"}
                          </p>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* ── LEADERBOARD ─────────────────────────────────────────────────── */}
          <TabsContent value="leaderboard" className="mt-5 space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {/* v14.49 — Pull-only model: no per-agent queues. Removed "My Lead Queue". Renamed "Active in Queue" → "Active in Pool". */}
              <StatCard label="Total Leads" value={stats?.totalLeads ?? 0} />
              <StatCard label="Active in Pool" value={stats?.activeLeads ?? 0} accent="text-white" />
              <StatCard label="Appointments Set" value={stats?.appointmentsSet ?? 0} accent="text-green-400" />
            </div>

            <div>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <h2 style={{
                  fontFamily: "'Cormorant Garamond','Georgia',serif",
                  fontSize: "1.3rem", fontWeight: 300, color: "#fff",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <Trophy size={16} style={{ color: "rgba(200,170,90,0.7)" }} />
                  Agent Leaderboard
                </h2>
                <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["/api/admin/leaderboard"] })} className="gap-1 text-xs text-muted-foreground">
                  <RefreshCw size={11}/>Refresh
                </Button>
              </div>

              {/* Today / This Week switcher */}
              <div style={{ display: "flex", gap: 0, marginBottom: 16, borderRadius: 10, overflow: "hidden", border: "1px solid rgba(200,170,90,0.2)", width: "fit-content" }}>
                {(["today", "weekly"] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setLbTab(t)}
                    style={{
                      padding: "6px 18px",
                      fontSize: 12, fontWeight: 500, letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      background: lbTab === t ? "rgba(200,170,90,0.15)" : "transparent",
                      color: lbTab === t ? "#c8aa5a" : "rgba(255,255,255,0.4)",
                      border: "none", cursor: "pointer",
                      borderBottom: lbTab === t ? "2px solid #c8aa5a" : "2px solid transparent",
                      transition: "all 0.15s",
                    }}
                  >
                    {t === "today" ? "Today" : "This Week"}
                  </button>
                ))}
              </div>

              {/* Activity dot legend */}
              <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 4px 10px", flexWrap: "wrap" }}>
                {([
                  { color: "#22c55e", label: "Active \u22646h" },
                  { color: "#eab308", label: "Active \u226412h" },
                  { color: "#f97316", label: "Active \u226424h" },
                  { color: "#ef4444", label: "Active \u226448h" },
                  { color: "#6b7280", label: "48h+" },
                ] as const).map(({ color, label }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", boxShadow: `0 0 4px ${color}88` }} />
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", letterSpacing: "0.05em" }}>{label}</span>
                  </div>
                ))}
              </div>

              {/* Column headers */}
              <div style={{
                display: "flex", alignItems: "center",
                padding: "0 16px 6px",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                marginBottom: 6,
              }}>
                <div style={{ flex: 1, minWidth: 0 }} />
                <div className="ld-lb-cols" style={{ display: "flex", gap: 20, textAlign: "center", alignItems: "center", flexShrink: 0 }}>
                  {/* v14.29 — Unified column order: APPTS first & bold gold (the #1 goal), Points second, Dials third. Then supporting metrics. */}
                  {lbTab === "today" ? (
                    <>
                      {/* v14.55 — Alex: "points should be the main indicator of first place. From left to
                          right: points, appts, dials, email." Emails is now a PRIMARY column (not
                          supporting). KIT/Refs are demoted to .ld-lb-supporting (hidden on phones,
                          shown on tablets+). Pts is the hero cell — gold pill, biggest number. */}
                      <div style={{ width: 48, fontSize: 10, color: "#c8aa5a", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 3 }}><Star size={8} style={{ color: "#c8aa5a" }} />Pts</div>
                      <div style={{ width: 44, fontSize: 10, color: "#c8aa5a", letterSpacing: "0.09em", textTransform: "uppercase", fontWeight: 700 }}>Appts</div>
                      <div style={{ width: 40, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Dials</div>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Emails</div>
                      <div className="ld-lb-supporting" style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>KIT</div>
                      <div className="ld-lb-supporting" style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Refs</div>
                    </>
                  ) : (
                    <>
                      <div style={{ width: 48, fontSize: 10, color: "#c8aa5a", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 3 }}><Star size={8} style={{ color: "#c8aa5a" }} />Pts</div>
                      <div style={{ width: 44, fontSize: 10, color: "#c8aa5a", letterSpacing: "0.09em", textTransform: "uppercase", fontWeight: 700 }}>Appts</div>
                      <div style={{ width: 40, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Dials</div>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Emails</div>
                      <div className="ld-lb-supporting" style={{ width: 52, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Conv%</div>
                      <div className="ld-lb-supporting" style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Refs</div>
                    </>
                  )}
                </div>
              </div>

              {dualLbLoading ? (
                <div className="space-y-2">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
              ) : dualLb.length === 0 ? (
                <div style={{
                  padding: "40px 20px", textAlign: "center",
                  border: "1px dashed rgba(200,170,90,0.15)",
                  borderRadius: 12, color: "rgba(255,255,255,0.3)",
                  fontSize: 13,
                }}>
                  No agents yet. Add agents in the Agents tab.
                </div>
              ) : (() => {
                // v14.29 — UNIFIED SORT across Today + Weekly + Agent leaderboard:
                // Appts → Points → Dials. Appts are the #1 goal; points break ties
                // (points already weight appts 10× a dial), dials are the final tiebreaker.
                const sorted = [...dualLb].sort((a, b) => {
                  const sa = lbTab === "today" ? a.today : a.weekly;
                  const sb = lbTab === "today" ? b.today : b.weekly;
                  return (sb.appts - sa.appts) ||
                         ((b.points || 0) - (a.points || 0)) ||
                         (sb.dials - sa.dials);
                });
                return (
                  <div className="space-y-2">
                    {sorted.map((stat: any, idx: number) => {
                      const isTop = idx === 0;
                      const s = lbTab === "today" ? stat.today : stat.weekly;
                      const dot = activityDot(stat.lastActivityAt ?? null);
                      return (
                        <div
                          key={stat.agent.id}
                          style={{
                            background: isTop
                              ? "linear-gradient(135deg, rgba(200,170,90,0.06) 0%, rgba(10,10,10,1) 60%)"
                              : "linear-gradient(135deg, #0f0f0f 0%, #0a0a0a 100%)",
                            border: `1px solid ${isTop ? "rgba(200,170,90,0.2)" : "rgba(255,255,255,0.07)"}`,
                            borderRadius: 12, padding: "12px 16px",
                            // v14.43 — row no longer clickable per Alex; no drilldown modal, no chevron.
                            cursor: "default", transition: "border-color 0.2s",
                            display: "flex", alignItems: "center", gap: 12,
                          }}
                          className="group"
                        >
                          {/* Rank badge — headshot or initials (v11.70) */}
                          <div style={{ position: "relative", flexShrink: 0 }}>
{(() => {
                              const initials = stat.agent.name.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2);
                              const avatarStyle = {
                                width: 36, height: 36, borderRadius: "50%", objectFit: "cover" as const,
                                border: `2px solid ${isTop ? "rgba(200,170,90,0.6)" : "rgba(255,255,255,0.15)"}`,
                                boxShadow: isTop ? "0 0 10px rgba(200,170,90,0.3)" : "none",
                              };
                              const initialsStyle = {
                                width: 36, height: 36, borderRadius: "50%",
                                display: "flex", alignItems: "center", justifyContent: "center",
                                border: `2px solid ${isTop ? "rgba(200,170,90,0.4)" : "rgba(255,255,255,0.1)"}`,
                                background: isTop ? "rgba(200,170,90,0.1)" : "rgba(255,255,255,0.04)",
                                fontSize: 12, fontWeight: 700,
                                color: isTop ? "#c8aa5a" : "rgba(255,255,255,0.4)",
                                fontFamily: "'Cormorant Garamond','Georgia',serif",
                              };
                              if (!stat.agent.headshotUrl) return <div style={initialsStyle}>{initials}</div>;
                              return (
                                <img
                                  src={stat.agent.headshotUrl}
                                  alt={stat.agent.name}
                                  style={avatarStyle}
                                  onError={(e) => {
                                    const el = e.currentTarget;
                                    el.style.display = 'none';
                                    const fallback = document.createElement('div');
                                    Object.assign(fallback.style, { ...initialsStyle, display: 'flex' });
                                    fallback.textContent = initials;
                                    el.parentNode?.insertBefore(fallback, el);
                                  }}
                                />
                              );
                            })()}
                            {/* Rank number badge */}
                            <div style={{
                              position: "absolute", bottom: -2, right: -2,
                              width: 16, height: 16, borderRadius: "50%",
                              background: isTop ? "#c8aa5a" : "rgba(30,30,30,1)",
                              border: "1.5px solid #080808",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 8, fontWeight: 800,
                              color: isTop ? "#080808" : "rgba(255,255,255,0.5)",
                            }}>
                              {idx + 1}
                            </div>
                          </div>

                          {/* Name + dot */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span title={dot.label} style={{
                                width: 7, height: 7, borderRadius: "50%",
                                background: dot.color, flexShrink: 0, display: "inline-block",
                                boxShadow: `0 0 5px ${dot.color}88`,
                              }} />
                              <span style={{ fontSize: 13, fontWeight: 500, color: "#fff", fontFamily: "'Switzer','Inter',sans-serif", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>
                                {stat.agent.name}
                              </span>
                              <ChevronRight size={11} className="text-muted-foreground group-hover:text-gold transition-colors" />
                            </div>
                          </div>

                          {/* Stats columns — v14.29: Appts hero (large gold), Points second, Dials third */}
                          <div className="ld-lb-cols" style={{ display: "flex", gap: 20, textAlign: "center", alignItems: "center", flexShrink: 0 }}>
                            {/* v14.55 — Column order matches Alex's spec: PTS (hero) → APPTS → DIALS → EMAILS.
                                 Emails is now a primary column (not supporting). KIT/Conv%/Refs demoted to
                                 .ld-lb-supporting (hidden on phones, shown on tablets+). */}
                            {lbTab === "today" ? (
                              <>
                                <div style={{ width: 48 }}>
                                  <div style={{
                                    fontSize: 22, fontWeight: 700, color: "#c8aa5a", lineHeight: 1,
                                    fontFamily: "'Cormorant Garamond','Georgia',serif",
                                    background: "rgba(200,170,90,0.12)", borderRadius: 8,
                                    padding: "2px 8px", display: "inline-block",
                                  }}>{stat.points || 0}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 20, fontWeight: 700, color: "#c8aa5a", lineHeight: 1, fontFamily: "'Cormorant Garamond','Georgia',serif" }}>{s.appts}</div>
                                </div>
                                <div style={{ width: 40 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "rgba(255,255,255,0.8)" }}>{s.dials}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#fbcfe8" }}>{s.emails}</div>
                                </div>
                                <div className="ld-lb-supporting" style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#c4b5fd" }}>{s.kit}</div>
                                </div>
                                <div className="ld-lb-supporting" style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#fde68a" }}>{s.referrals}</div>
                                </div>
                              </>
                            ) : (
                              <>
                                <div style={{ width: 48 }}>
                                  <div style={{
                                    fontSize: 22, fontWeight: 700, color: "#c8aa5a", lineHeight: 1,
                                    fontFamily: "'Cormorant Garamond','Georgia',serif",
                                    background: "rgba(200,170,90,0.12)", borderRadius: 8,
                                    padding: "2px 8px", display: "inline-block",
                                  }}>{stat.points || 0}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 20, fontWeight: 700, color: "#c8aa5a", lineHeight: 1, fontFamily: "'Cormorant Garamond','Georgia',serif" }}>{s.appts}</div>
                                </div>
                                <div style={{ width: 40 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "rgba(255,255,255,0.8)" }}>{s.dials}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#fbcfe8" }}>{s.emails}</div>
                                </div>
                                <div className="ld-lb-supporting" style={{ width: 52 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#67e8f9" }}>{s.convRate}%</div>
                                </div>
                                <div className="ld-lb-supporting" style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#fde68a" }}>{s.referrals}</div>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* ── Reset + Past Periods ─────────────────────────────────────── */}
            <div style={{ marginTop: 28, borderTop: "1px solid rgba(200,170,90,0.1)", paddingTop: 20 }}>

              {/* Reset button */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)" }}>Period Reset</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 2 }}>Snapshots scores before zeroing — visible in Past Periods below</div>
                </div>
                <button
                  onClick={() => openConfirm({
                    title: "Reset Leaderboard?",
                    message: "Current scores will be saved as a historical snapshot, then all stats reset to zero. This cannot be undone.",
                    confirmLabel: "Reset & Archive",
                    confirmColor: "#ef4444",
                    onConfirm: () => { closeConfirm(); leaderboardResetMutation.mutate(); },
                  })}
                  disabled={leaderboardResetMutation.isPending}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "8px 16px",
                    background: "transparent",
                    border: "1px solid rgba(239,68,68,0.35)",
                    borderRadius: 6,
                    fontSize: 11, fontWeight: 600, letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "#ef4444", cursor: "pointer",
                    opacity: leaderboardResetMutation.isPending ? 0.5 : 1,
                    transition: "all 0.15s",
                  }}
                >
                  <RefreshCw size={11} />
                  {leaderboardResetMutation.isPending ? "Resetting…" : "Reset Period"}
                </button>
              </div>

              {/* Past Periods collapsible */}
              <button
                onClick={() => setLbHistoryOpen(o => !o)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "10px 14px",
                  background: "rgba(200,170,90,0.05)",
                  border: "1px solid rgba(200,170,90,0.15)",
                  borderRadius: 8,
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Clock size={13} style={{ color: "rgba(200,170,90,0.6)" }} />
                  <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(200,170,90,0.8)" }}>
                    Past Periods
                  </span>
                  {lbHistory.length > 0 && (
                    <span style={{
                      fontSize: 10, padding: "1px 7px", borderRadius: 10,
                      background: "rgba(200,170,90,0.15)", color: "#c8aa5a",
                    }}>{lbHistory.length}</span>
                  )}
                </div>
                {lbHistoryOpen ? <ChevronUp size={14} style={{ color: "rgba(200,170,90,0.5)" }} /> : <ChevronDown size={14} style={{ color: "rgba(200,170,90,0.5)" }} />}
              </button>

              {lbHistoryOpen && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                  {lbHistory.length === 0 ? (
                    <div style={{
                      padding: "24px 16px", textAlign: "center",
                      border: "1px dashed rgba(200,170,90,0.1)",
                      borderRadius: 8, color: "rgba(255,255,255,0.25)", fontSize: 12,
                    }}>
                      No archived periods yet. Reset the leaderboard to create your first snapshot.
                    </div>
                  ) : lbHistory.map((snap: any) => {
                    let parsed: any[] = [];
                    try { parsed = JSON.parse(snap.snapshot_json); } catch {}
                    const sorted = [...parsed].sort((a, b) => (b.points || 0) - (a.points || 0));
                    return (
                      <div key={snap.id} style={{
                        borderRadius: 10,
                        border: "1px solid rgba(200,170,90,0.12)",
                        background: "rgba(200,170,90,0.03)",
                        overflow: "hidden",
                      }}>
                        {/* Period header */}
                        <div style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "10px 14px",
                          borderBottom: "1px solid rgba(200,170,90,0.08)",
                          background: "rgba(200,170,90,0.06)",
                        }}>
                          <span style={{
                            fontFamily: "'Cormorant Garamond','Georgia',serif",
                            fontSize: 14, fontWeight: 400, color: "#c8aa5a",
                          }}>
                            {snap.period_label}
                          </span>
                          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: "0.05em" }}>
                            {new Date(snap.reset_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                          </span>
                        </div>
                        {/* Agent rows */}
                        <div style={{ padding: "8px 0" }}>
                          {sorted.map((entry: any, i: number) => (
                            <div key={entry.agentId ?? i} style={{
                              display: "flex", alignItems: "center", justifyContent: "space-between",
                              padding: "6px 14px",
                            }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{
                                  width: 18, textAlign: "center",
                                  fontSize: 10, fontWeight: 700,
                                  color: i === 0 ? "#c8aa5a" : "rgba(255,255,255,0.2)",
                                }}>{i + 1}</span>
                                <span style={{ fontSize: 13, color: i === 0 ? "#fff" : "rgba(255,255,255,0.6)" }}>
                                  {entry.agentName || "Unknown"}
                                </span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", minWidth: 50, textAlign: "right" }}>
                                  {entry.dials ?? 0} dials
                                </span>
                                <span style={{ fontSize: 10, color: "#86efac", minWidth: 44, textAlign: "right" }}>
                                  {entry.appts ?? 0} appts
                                </span>
                                <span style={{
                                  fontSize: 13, fontWeight: 700, color: "#c8aa5a",
                                  background: i === 0 ? "rgba(200,170,90,0.15)" : "transparent",
                                  borderRadius: 5, padding: "1px 7px", minWidth: 44, textAlign: "right",
                                }}>
                                  {entry.points ?? 0} pts
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </TabsContent>

          {/* ── ALL LEADS ───────────────────────────────────────────────────── */}
          <TabsContent value="leads" className="mt-5 space-y-3">
            {/* v14.81.2 — Pipeline tab deleted; its 8 stage tiles now live here at the
               top of Lead Pool, plus an "All" tile as a 9th at the front. Tapping a
               tile drives the SAME statusFilter state used by the paginated table
               below (and by the Status dropdown), so the two stay in sync either way. */}
            <div className="flex items-center gap-2 mb-1">
              <Layers size={13} style={{ color: "rgba(200,170,90,0.7)" }} />
              <p style={{
                fontFamily: "'Cormorant Garamond','Georgia',serif",
                fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase",
                color: "rgba(200,170,90,0.6)", fontWeight: 600,
              }}>
                Pipeline Funnel
              </p>
            </div>
            {pipelineLoading ? (
              <div className="grid gap-2 grid-cols-3 md:grid-cols-9">
                {Array(9).fill(0).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
              </div>
            ) : (
              <div className="grid gap-2 grid-cols-3 md:grid-cols-9">
                <button
                  onClick={() => setStatusFilter("all")}
                  data-testid="tile-status-all"
                  style={{
                    borderRadius: 10, cursor: "pointer", textAlign: "left",
                    border: `1px solid ${statusFilter === "all" ? "rgba(200,170,90,0.65)" : "rgba(200,170,90,0.18)"}`,
                    background: statusFilter === "all" ? "rgba(200,170,90,0.12)" : "rgba(200,170,90,0.04)",
                    padding: "10px 12px",
                    boxShadow: statusFilter === "all" ? "0 0 0 1px rgba(200,170,90,0.35), 0 2px 10px rgba(200,170,90,0.15)" : "none",
                    transition: "all 0.15s ease",
                  }}
                >
                  <div style={{ fontSize: 22, fontWeight: 300, color: "#c8aa5a", lineHeight: 1 }}>
                    {(pipeline?.leads || []).length ?? 0}
                  </div>
                  <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", marginTop: 4, fontWeight: 700 }}>
                    All
                  </div>
                </button>
                {pipelineStages.map(stage => {
                  const active = statusFilter === stage.key;
                  return (
                    <button
                      key={stage.key}
                      onClick={() => setStatusFilter(stage.key)}
                      data-testid={`tile-status-${stage.key}`}
                      style={{
                        borderRadius: 10, cursor: "pointer", textAlign: "left",
                        border: `1px solid ${active ? stage.color : stage.border}`,
                        background: active ? stage.bg.replace(/0\.0[0-9]\)/, "0.14)") : stage.bg,
                        padding: "10px 12px",
                        boxShadow: active ? `0 0 0 1px ${stage.color}, 0 2px 10px ${stage.border}` : "none",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <div style={{ fontSize: 22, fontWeight: 300, color: stage.color, lineHeight: 1 }}>
                        {byStatus[stage.key] ?? 0}
                      </div>
                      <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginTop: 4 }}>
                        {stage.label}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* ── Paginated All Leads (v11.70) ── */}
            {(() => {
              const plData = paginatedLeadsQuery.data as any;
              const plLeads: any[] = plData?.leads || [];
              const plTotal: number = plData?.total || 0;
              const plHasMore: boolean = plData?.hasMore || false;
              const plLoading = paginatedLeadsQuery.isLoading;
              const totalPages = Math.ceil(plTotal / LEADS_PAGE_SIZE);
              return (
                <>
                  <div className="flex gap-2 flex-wrap items-center">
                    <Input
                      placeholder="Search address, name, phone…"
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      className="max-w-xs bg-secondary border-border text-sm"
                      data-testid="input-search"
                    />
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger className="w-44 bg-secondary border-border text-sm" data-testid="select-status-filter">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Statuses</SelectItem>
                        <SelectItem value="unassigned">Unassigned</SelectItem>
                        <SelectItem value="assigned">Assigned</SelectItem>
                        <SelectItem value="no_answer">No Answer</SelectItem>
                        <SelectItem value="keep_in_touch">Keep in Touch</SelectItem>
                        <SelectItem value="callback_requested">Callback</SelectItem>
                        <SelectItem value="contacted_appointment">Appt Set</SelectItem>
                        <SelectItem value="contacted_not_interested">Not Interested</SelectItem>
                        <SelectItem value="wrong_number">Wrong #</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm"
                      onClick={() => qc.invalidateQueries({ queryKey: ["/api/leads/paginated"] })}
                      className="gap-1 text-xs border-border">
                      <RefreshCw size={11}/> Refresh
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {plTotal > 0 ? `${plTotal.toLocaleString()} total` : "0 leads"}
                      {totalPages > 1 ? ` · page ${leadsPage + 1} of ${totalPages}` : ""}
                    </span>
                  </div>

                  {plLoading ? (
                    <div className="space-y-2">{Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
                  ) : plLeads.length === 0 ? (
                    <div style={{
                      padding: "48px 20px", textAlign: "center",
                      border: "1px dashed rgba(200,170,90,0.1)",
                      borderRadius: 12, color: "rgba(255,255,255,0.3)", fontSize: 13,
                    }}>
                      No leads found.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {plLeads.map((lead: any) => (
                        <div
                          key={lead.id}
                          style={{
                            background: "rgba(255,255,255,0.02)",
                            border: "1px solid rgba(255,255,255,0.07)",
                            borderRadius: 8, padding: "12px 16px",
                            display: "flex", alignItems: "center", gap: 12,
                            cursor: "pointer", transition: "border-color 0.15s",
                          }}
                          onClick={() => setSelectedLead(lead)}
                          data-testid={`row-lead-${lead.id}`}
                          onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(200,170,90,0.2)")}
                          onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)")}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap mb-1">
                              <TypeBadge type={lead.leadType} />
                              <StatusBadge status={lead.status} />
                              <CooldownPill until={lead.recycleCooldownUntil} compact />
                              {lead.attemptCount > 0 && <span className="text-xs text-muted-foreground">{lead.attemptCount} attempt{lead.attemptCount !== 1 ? "s" : ""}</span>}
                              {lead.score > 0 && (
                                <span title={`Lead score: ${lead.score}`} style={{
                                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                                  minWidth: 20, height: 16, padding: "0 5px",
                                  borderRadius: 8, fontSize: 9, fontWeight: 800,
                                  background: lead.score >= 12
                                    ? "linear-gradient(135deg,#c8aa5a,#a8893a)"
                                    : lead.score >= 7 ? "rgba(200,170,90,0.2)" : "rgba(255,255,255,0.08)",
                                  color: lead.score >= 12 ? "#080808" : "#c8aa5a",
                                  border: lead.score >= 12 ? "none" : "1px solid rgba(200,170,90,0.35)",
                                }}>{lead.score}</span>
                              )}
                              {lead.territory && (
                                <span style={{ fontSize: 8, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(200,170,90,0.5)", fontWeight: 600 }}>
                                  {String(lead.territory).replace(/_/g, " ")}
                                </span>
                              )}
                            </div>
                            <p className="text-sm font-medium text-foreground truncate">{lead.ownerName || "—"}</p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin size={10}/>{lead.address}</p>
                          </div>
                          <div className="hidden md:flex flex-col items-end gap-1 text-xs text-muted-foreground shrink-0">
                            {lead.phone && <span className="flex items-center gap-1"><Phone size={10}/>{lead.phone}</span>}
                            {lead.assignedAgentName && <span className="text-foreground/60">{lead.assignedAgentName}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Pagination controls */}
                  {totalPages > 1 && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, paddingTop: 8 }}>
                      <button
                        onClick={() => setLeadsPage(p => Math.max(0, p - 1))}
                        disabled={leadsPage === 0}
                        style={{
                          padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                          background: leadsPage === 0 ? "rgba(255,255,255,0.04)" : "rgba(200,170,90,0.12)",
                          border: "1px solid rgba(200,170,90,0.2)", color: leadsPage === 0 ? "rgba(255,255,255,0.2)" : "#c8aa5a",
                          cursor: leadsPage === 0 ? "not-allowed" : "pointer",
                        }}
                      >‹ Prev</button>
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>{leadsPage + 1} / {totalPages}</span>
                      <button
                        onClick={() => setLeadsPage(p => p + 1)}
                        disabled={!plHasMore}
                        style={{
                          padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                          background: !plHasMore ? "rgba(255,255,255,0.04)" : "rgba(200,170,90,0.12)",
                          border: "1px solid rgba(200,170,90,0.2)", color: !plHasMore ? "rgba(255,255,255,0.2)" : "#c8aa5a",
                          cursor: !plHasMore ? "not-allowed" : "pointer",
                        }}
                      >Next ›</button>
                    </div>
                  )}
                </>
              );
            })()}
          </TabsContent>

          {/* ── LEAD MODAL ──────────────────────────────────────────────────── */}
          {selectedLead && (() => {
            const lead = selectedLead;
            const extra = (() => { try { return JSON.parse(lead.extraData || "{}"); } catch { return {}; } })();
            const leadCity = lead.city || extra.city || "";
            const zillow = lead.address
              ? `https://www.zillow.com/homes/${encodeURIComponent(lead.address + (leadCity ? ", " + leadCity : ""))}_rb/`
              : null;
            const subject = encodeURIComponent(`Regarding your property at ${lead.address}`);
            const body = encodeURIComponent(`Hi ${lead.ownerName || "there"},\n\nI wanted to reach out about your property at ${lead.address}. I specialize in helping homeowners in your area and I'd love to connect.\n\nWould you be available for a quick call?\n\nBest,\nBrothers Group Real Estate Team at Momentum Realty`);
            const mailtoLink = lead.email ? `mailto:${lead.email}?subject=${subject}&body=${body}` : null;
            return (
              <div style={{
                position: "fixed", inset: 0, zIndex: 50,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
                padding: 16,
              }} onClick={() => setSelectedLead(null)}>
                <div style={{
                  background: "linear-gradient(135deg,#0f0f0f 0%,#0a0a0a 100%)",
                  border: "1px solid rgba(200,170,90,0.15)",
                  borderRadius: 16, width: "100%", maxWidth: 440,
                  padding: 20, boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
                }} onClick={e => e.stopPropagation()}>
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                        <TypeBadge type={lead.leadType} />
                        <StatusBadge status={lead.status} />
                        <CooldownPill until={lead.recycleCooldownUntil} onThaw={async () => {
                          try {
                            await apiRequest("POST", `/api/admin/leads/${lead.id}/clear-cooldown`, {});
                            toast({ title: "Thawed", description: "Lead is eligible again." });
                            qc.invalidateQueries({ queryKey: ["/api/leads"] });
                            setSelectedLead(null);
                          } catch (err: any) {
                            toast({ title: "Failed to thaw", description: String(err?.message || err), variant: "destructive" });
                          }
                        }} />
                      </div>
                      <p style={{
                        fontFamily: "'Cormorant Garamond','Georgia',serif",
                        fontSize: "1.2rem", fontWeight: 300, color: "#fff",
                      }}>
                        {lead.ownerName || "—"}
                      </p>
                    </div>
                    <button onClick={() => setSelectedLead(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.4)" }}>
                      <X size={16}/>
                    </button>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, marginBottom: 16 }}>
                    {lead.address && <div className="flex items-start gap-2"><MapPin size={13} className="text-muted-foreground mt-0.5 shrink-0"/><span className="text-foreground">{lead.address}</span></div>}
                    {(() => {
                      // v14.40 — render all phones with per-line no-answer counters (· 3/10, · struck)
                      // v14.65 — cap raised 6 → 10
                      const phones: string[] = (() => { try { return lead.phones ? JSON.parse(lead.phones) : (lead.phone ? [lead.phone] : []); } catch { return lead.phone ? [lead.phone] : []; } })();
                      const states: Record<string, string> = (() => { try { return lead.phoneStates ? JSON.parse(lead.phoneStates) : {}; } catch { return {}; } })();
                      const attempts: Record<string, number> = (() => { try { return lead.phoneAttempts ? JSON.parse(lead.phoneAttempts) : {}; } catch { return {}; } })();
                      if (phones.length === 0) return null;
                      return phones.map((p, i) => {
                        const n = attempts[p] || 0;
                        const struck = states[p] === "struck";
                        return (
                          <div key={p + i} className="flex items-center gap-2">
                            <Phone size={13} className="text-muted-foreground"/>
                            <span className="text-foreground" style={{ textDecoration: struck ? "line-through" : "none", opacity: struck ? 0.5 : 1 }}>{p}</span>
                            {struck ? (
                              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>· struck</span>
                            ) : n > 0 ? (
                              <span style={{ fontSize: 10, color: n >= 8 ? "#f87171" : "rgba(255,255,255,0.4)" }}>· {n}/10</span>
                            ) : null}
                          </div>
                        );
                      });
                    })()}
                    {lead.email && <div className="flex items-center gap-2"><Mail size={13} className="text-muted-foreground"/><span className="text-foreground">{lead.email}</span></div>}
                    {lead.motivation && <div className="flex items-start gap-2"><AlertTriangle size={13} style={{ color: "rgba(234,179,8,0.7)" }} className="mt-0.5 shrink-0"/><span className="text-muted-foreground">{lead.motivation}</span></div>}
                    {extra.county && <div className="text-xs text-muted-foreground">County: {extra.county}</div>}
                    {extra.propertyType && <div className="text-xs text-muted-foreground">Type: {extra.propertyType}</div>}
                    {extra.estimatedValue && <div className="text-xs text-muted-foreground">Est. Value: <span style={{ color: "#c8aa5a" }}>{extra.estimatedValue}</span></div>}
                    {extra.timeframe && <div className="text-xs text-muted-foreground">Timeframe: {extra.timeframe}</div>}
                    {extra.source === "network" && extra.submittedByName && (
                      <div style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "6px 10px", borderRadius: 8, marginTop: 2,
                        background: "rgba(200,170,90,0.1)", border: "1px solid rgba(200,170,90,0.25)",
                      }}>
                        <Users size={11} style={{ color: "#c8aa5a", flexShrink: 0 }} />
                        <span style={{ fontSize: 12, color: "#c8aa5a", fontWeight: 600 }}>
                          Network Lead — referred by {extra.submittedByName}
                        </span>
                      </div>
                    )}
                    {extra.source === "network" && extra.networkNotes && (
                      <div className="text-xs text-muted-foreground" style={{ paddingLeft: 2 }}>
                        Referral notes: <span style={{ color: "rgba(255,255,255,0.6)" }}>{extra.networkNotes}</span>
                      </div>
                    )}
                    {lead.assignedAgentName && (
                      <div style={{ paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.06)", fontSize: 12, color: "rgba(255,255,255,0.35)" }}>
                        Assigned to: <span className="text-foreground">{lead.assignedAgentName}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2">
                    {zillow && (
                      <a href={zillow} target="_blank" rel="noopener noreferrer"
                        style={{
                          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                          gap: 6, fontSize: 12, padding: "10px 0",
                          background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)",
                          borderRadius: 6, color: "rgba(147,197,253,0.85)", textDecoration: "none",
                        }}>
                        <TrendingUp size={12}/> View on Zillow
                      </a>
                    )}
                    {mailtoLink && (
                      <a href={mailtoLink}
                        style={{
                          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                          gap: 6, fontSize: 12, padding: "10px 0",
                          background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)",
                          borderRadius: 6, color: "rgba(134,239,172,0.85)", textDecoration: "none",
                        }}>
                        <Mail size={12}/> Email Lead
                      </a>
                    )}
                  </div>

                  {/* Activity History */}
                  <ActivityHistory leadId={lead.id} />

                  <p style={{ marginTop: 14, fontSize: 10, color: "rgba(255,255,255,0.18)", textAlign: "center", letterSpacing: "0.04em", fontStyle: "italic" }}>
                    Read-only view — outcome selection available to assigned agent only
                  </p>
                </div>
              </div>
            );
          })()}

          {/* ── UPLOAD ──────────────────────────────────────────────────────── */}
          <TabsContent value="reports" className="mt-5">
            <OutcomeReport />
          </TabsContent>

          <TabsContent value="upload" className="mt-5">
            <div className="max-w-lg space-y-6">
              <div>
                <h2 style={{
                  fontFamily: "'Cormorant Garamond','Georgia',serif",
                  fontSize: "1.3rem", fontWeight: 300, color: "#fff", marginBottom: 4,
                }}>Upload Lead CSV</h2>
                <p className="text-sm text-muted-foreground">Leads auto-distribute to agents via round-robin the moment they're uploaded.</p>
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-sm text-foreground/80">Lead Type</Label>
                  <div className="flex flex-wrap gap-2">
                    {([
                      { key: "expired", label: "Expired" },
                    ] as const).map(({ key, label }) => (
                      <button key={key} onClick={() => setUploadType(key)}
                        style={{
                          padding: "9px 16px", borderRadius: 6,
                          fontSize: 12, fontWeight: 500, letterSpacing: "0.04em",
                          border: "1px solid",
                          borderColor: uploadType === key ? "rgba(200,170,90,0.5)" : "rgba(255,255,255,0.1)",
                          background: uploadType === key ? "rgba(200,170,90,0.1)" : "rgba(255,255,255,0.03)",
                          color: uploadType === key ? "#c8aa5a" : "rgba(255,255,255,0.5)",
                          cursor: "pointer",
                          transition: "all 0.15s",
                        }}
                        data-testid={`button-type-${key}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm text-foreground/80">CSV File</Label>
                        <Button size="sm" variant="outline" className="gap-1.5 text-xs border-border text-muted-foreground" onClick={handleExportCSV}>
                          <Download size={12}/> Export DB
                        </Button>
                      </div>
                      <div
                        style={{
                          border: `2px dashed ${dragOver ? "rgba(200,170,90,0.5)" : "rgba(255,255,255,0.1)"}`,
                          borderRadius: 10, padding: "40px 20px", textAlign: "center",
                          cursor: "pointer",
                          background: dragOver ? "rgba(200,170,90,0.04)" : "transparent",
                          transition: "all 0.15s",
                        }}
                        onClick={() => fileRef.current?.click()}
                        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={handleDrop}
                      >
                        <Upload style={{ margin: "0 auto 8px", color: dragOver ? "#c8aa5a" : "rgba(255,255,255,0.3)" }} size={24} />
                        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>
                          {uploading
                            ? (uploadRowCount ? `Uploading ${uploadRowCount.toLocaleString()} rows…` : "Uploading…")
                            : dragOver ? "Drop CSV here" : "Click or drag a CSV file here"}
                        </p>
                        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 4 }}>
                          Expected columns: Address, Owner Name, Phone, Email, Motivation
                        </p>
                      </div>
                      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleUpload} data-testid="input-csv-file" />
                    </div>
                    <div style={{
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(255,255,255,0.07)",
                      borderRadius: 10, padding: 16,
                    }}>
                      <p className="text-xs font-semibold text-foreground/50 uppercase tracking-wider mb-2">Recognized Column Names</p>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                        <span><span className="text-white/40">address</span> / Address / Property Address</span>
                        <span><span className="text-white/40">ownerName</span> / Owner Name / name</span>
                        <span><span className="text-white/40">phone</span> / Phone / Phone Number</span>
                        <span><span className="text-white/40">email</span> / Email</span>
                        <span><span className="text-white/40">motivation</span> / Motivation</span>
                        <span className="text-muted-foreground/40">All other columns preserved</span>
                      </div>
                    </div>

              </div>
            </div>
          </TabsContent>

          {/* ── AGENTS ──────────────────────────────────────────────────────── */}
          {/* ── RECRUITING ──────────────────────────────────────────────────── */}
          <TabsContent value="recruiting" className="mt-5">
            <div style={{ maxWidth: 900 }}>
              {/* v12.5 — Recruiting admin toolbar */}
              <div style={{
                display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, alignItems: "center",
                padding: 12, background: "rgba(79,184,163,0.04)",
                border: "1px solid rgba(79,184,163,0.2)", borderRadius: 10,
              }}>
                <button
                  onClick={() => runGetLeadsNow("recruiting")}
                  disabled={busyGetLeads === "recruiting"}
                  style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                    padding: "7px 14px", borderRadius: 6, border: "none",
                    cursor: busyGetLeads === "recruiting" ? "wait" : "pointer",
                    background: "linear-gradient(135deg,#4fb8a3 0%,#2d8a75 100%)", color: "#080808",
                  }}
                >{busyGetLeads === "recruiting" ? "Running…" : "⚡ Get Agent Leads Now"}</button>
                <a
                  href="#/recruiting"
                  style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                    padding: "7px 14px", borderRadius: 6, textDecoration: "none",
                    background: "rgba(79,184,163,0.1)", color: "#4fb8a3",
                    border: "1px solid rgba(79,184,163,0.3)",
                  }}
                >Open Recruiting Depot →</a>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => setHardResetOpen("recruiting")}
                  style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                    padding: "7px 14px", borderRadius: 6, cursor: "pointer",
                    background: "rgba(239,68,68,0.1)", color: "#ef4444",
                    border: "1px solid rgba(239,68,68,0.4)",
                  }}
                >⚠ Hard Reset Recruiting</button>
              </div>

              {/* Sub-tab switcher */}
              <div style={{ display: "flex", gap: 6, marginBottom: 20, overflowX: "auto", paddingBottom: 2 }}>
                {([
                  { k: "pipeline",    label: "Pipeline" },
                  { k: "leaderboard", label: "Leaderboard" },
                  { k: "quick",       label: "Quick Add" },
                  { k: "bulk",        label: "Bulk Import" },
                ] as const).map(({ k, label }) => (
                  <button key={k} onClick={() => setRecruitingSubTab(k)} style={{
                    padding: "8px 16px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                    letterSpacing: "0.06em", textTransform: "uppercase", border: "1px solid", whiteSpace: "nowrap",
                    borderColor: recruitingSubTab === k ? "rgba(79,184,163,0.5)" : "rgba(255,255,255,0.1)",
                    background: recruitingSubTab === k ? "rgba(79,184,163,0.1)" : "rgba(255,255,255,0.03)",
                    color: recruitingSubTab === k ? "#4fb8a3" : "rgba(255,255,255,0.4)",
                    cursor: "pointer", transition: "all 0.15s",
                  }}>{label}</button>
                ))}
              </div>

              {/* ── PIPELINE TAB ── */}
              {recruitingSubTab === "pipeline" && (() => {
                const pData = recruitingPipelineQuery.data;
                const leads = pData?.leads ?? [];
                const counts = pData?.counts ?? [];
                const totalActive = counts.filter((c: any) => !['joined','not_interested','do_not_contact'].includes(c.status)).reduce((s: number, c: any) => s + c.count, 0);
                const statusColors: Record<string, string> = {
                  new: "rgba(255,255,255,0.5)",
                  contacted: "#4fb8a3",
                  hot_prospect: "#f97316",
                  appointment: "#c8aa5a",
                  callback_requested: "#a78bfa",
                  not_now: "rgba(255,255,255,0.3)",
                  just_signed: "rgba(255,255,255,0.3)",
                  joined: "#22c55e",
                  not_interested: "rgba(239,68,68,0.6)",
                  do_not_contact: "rgba(239,68,68,0.4)",
                };
                const statusLabels: Record<string, string> = {
                  new: "New", contacted: "Contacted", hot_prospect: "🔥 Hot",
                  appointment: "Appt", callback_requested: "Callback",
                  not_now: "❄ Not Now", just_signed: "❄ Just Signed",
                  joined: "✓ Joined", not_interested: "Not Interested", do_not_contact: "⛔ DNC",
                };
                const filterOptions = [
                  { v: "all", label: "All Active" },
                  { v: "new", label: "New" },
                  { v: "contacted", label: "Contacted" },
                  { v: "hot_prospect", label: "Hot" },
                  { v: "appointment", label: "Appt" },
                  { v: "callback_requested", label: "Callback" },
                  { v: "not_now", label: "Not Now" },
                  { v: "just_signed", label: "Just Signed" },
                  { v: "joined", label: "Joined" },
                  { v: "not_interested", label: "Not Interested" },
                ];
                return (
                  <div>
                    {/* Stats row */}
                    <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                      {counts.filter((c: any) => c.count > 0).map((c: any) => (
                        <div key={c.status} style={{
                          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
                          borderRadius: 8, padding: "8px 14px", textAlign: "center",
                        }}>
                          <div style={{ fontSize: 18, fontWeight: 300, color: statusColors[c.status] || "#fff" }}>{c.count}</div>
                          <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginTop: 2 }}>
                            {statusLabels[c.status] || c.status}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Filter bar */}
                    <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 2 }}>
                      {filterOptions.map(({ v, label }) => (
                        <button key={v} onClick={() => setRecruitingStatusFilter(v)} style={{
                          padding: "5px 12px", borderRadius: 20, fontSize: 10, fontWeight: 600,
                          letterSpacing: "0.05em", border: "1px solid", whiteSpace: "nowrap",
                          borderColor: recruitingStatusFilter === v ? "rgba(79,184,163,0.5)" : "rgba(255,255,255,0.08)",
                          background: recruitingStatusFilter === v ? "rgba(79,184,163,0.1)" : "transparent",
                          color: recruitingStatusFilter === v ? "#4fb8a3" : "rgba(255,255,255,0.35)",
                          cursor: "pointer",
                        }}>{label}</button>
                      ))}
                    </div>

                    {/* Lead rows */}
                    {recruitingPipelineQuery.isLoading ? (
                      <div style={{ padding: "40px 0", textAlign: "center", color: "rgba(255,255,255,0.3)", fontSize: 13 }}>Loading pipeline…</div>
                    ) : leads.length === 0 ? (
                      <div style={{ padding: "40px 0", textAlign: "center", color: "rgba(255,255,255,0.3)", fontSize: 13 }}>No recruits in this category.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {leads.map((lead: any) => {
                          const activity = lead.recent_activity || [];
                          const statusColor = statusColors[lead.status] || "rgba(255,255,255,0.4)";
                          const frozen = lead.status === "not_now" || lead.status === "just_signed";
                          return (
                            <div key={lead.id} style={{
                              background: frozen ? "rgba(255,255,255,0.01)" : "rgba(255,255,255,0.02)",
                              border: `1px solid ${frozen ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.08)"}`,
                              borderRadius: 10, padding: "14px 16px",
                              opacity: frozen ? 0.6 : 1,
                            }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                    <span style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 16, fontWeight: 500, color: "#fff" }}>
                                      {lead.first_name} {lead.last_name}
                                    </span>
                                    <span style={{
                                      fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                                      color: statusColor, border: `1px solid ${statusColor}40`,
                                      borderRadius: 10, padding: "2px 8px",
                                    }}>{statusLabels[lead.status] || lead.status}</span>
                                    {lead.attempt_count > 0 && (
                                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>{lead.attempt_count} dials</span>
                                    )}
                                  </div>
                                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>
                                    {[lead.current_brokerage, lead.territory || lead.matched_territory, lead.phone].filter(Boolean).join(" · ")}
                                  </div>
                                  {frozen && lead.reactivate_at && (
                                    <div style={{ fontSize: 10, color: "rgba(200,170,90,0.6)", marginTop: 4 }}>
                                      ❄ Re-enters queue {new Date(lead.reactivate_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                    </div>
                                  )}
                                  {activity.length > 0 && (
                                    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                                      {activity.slice(0, 2).map((a: any, i: number) => (
                                        <div key={i} style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>
                                          <span style={{ color: "rgba(255,255,255,0.5)" }}>{a.callerName || "Unknown"}</span>
                                          {" · "}{statusLabels[a.outcome] || a.outcome}
                                          {a.notes ? <span style={{ color: "rgba(255,255,255,0.2)" }}> — {a.notes.slice(0, 60)}{a.notes.length > 60 ? "…" : ""}</span> : null}
                                          <span style={{ color: "rgba(255,255,255,0.2)", marginLeft: 6 }}>
                                            {new Date(a.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                {/* Actions */}
                                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                                  {lead.status !== "do_not_contact" && (
                                    <button
                                      onClick={() => {
                                        if (recruitingDncConfirm === lead.id) {
                                          apiRequest("POST", `/api/agent-leads/${lead.id}/outcome`, { outcome: "do_not_contact", callerId: user?.id })
                                            .then(() => { setRecruitingDncConfirm(null); recruitingPipelineQuery.refetch(); });
                                        } else { setRecruitingDncConfirm(lead.id); setRecruitingDeleteConfirm(null); }
                                      }}
                                      style={{
                                        padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600,
                                        border: "1px solid rgba(239,68,68,0.25)",
                                        background: recruitingDncConfirm === lead.id ? "rgba(239,68,68,0.2)" : "transparent",
                                        color: recruitingDncConfirm === lead.id ? "#ef4444" : "rgba(239,68,68,0.5)",
                                        cursor: "pointer",
                                      }}
                                    >{recruitingDncConfirm === lead.id ? "Confirm DNC" : "DNC"}</button>
                                  )}
                                  <button
                                    onClick={() => {
                                      if (recruitingDeleteConfirm === lead.id) {
                                        apiRequest("DELETE", `/api/agent-leads/${lead.id}`)
                                          .then(() => { setRecruitingDeleteConfirm(null); recruitingPipelineQuery.refetch(); });
                                      } else { setRecruitingDeleteConfirm(lead.id); setRecruitingDncConfirm(null); }
                                    }}
                                    style={{
                                      padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600,
                                      border: "1px solid rgba(239,68,68,0.15)",
                                      background: recruitingDeleteConfirm === lead.id ? "rgba(239,68,68,0.15)" : "transparent",
                                      color: recruitingDeleteConfirm === lead.id ? "#ef4444" : "rgba(239,68,68,0.3)",
                                      cursor: "pointer",
                                    }}
                                  >{recruitingDeleteConfirm === lead.id ? "Confirm Delete" : "Delete"}</button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── LEADERBOARD TAB ── */}
              {recruitingSubTab === "leaderboard" && (() => {
                const rows: any[] = recruitingLeaderboardQuery.data ?? [];
                const periods = [{ v: "today", label: "Today" }, { v: "week", label: "This Week" }, { v: "allTime", label: "All Time" }] as const;
                return (
                  <div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
                      {periods.map(({ v, label }) => (
                        <button key={v} onClick={() => setRecruitingLbPeriod(v)} style={{
                          padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                          letterSpacing: "0.05em", border: "1px solid",
                          borderColor: recruitingLbPeriod === v ? "rgba(79,184,163,0.5)" : "rgba(255,255,255,0.08)",
                          background: recruitingLbPeriod === v ? "rgba(79,184,163,0.1)" : "transparent",
                          color: recruitingLbPeriod === v ? "#4fb8a3" : "rgba(255,255,255,0.35)",
                          cursor: "pointer",
                        }}>{label}</button>
                      ))}
                    </div>
                    {recruitingLeaderboardQuery.isLoading ? (
                      <div style={{ padding: "40px 0", textAlign: "center", color: "rgba(255,255,255,0.3)", fontSize: 13 }}>Loading leaderboard…</div>
                    ) : rows.length === 0 ? (
                      <div style={{ padding: "40px 0", textAlign: "center", color: "rgba(255,255,255,0.3)", fontSize: 13 }}>No recruiting activity yet.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {/* Header */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 60px 60px 60px", gap: 8, padding: "0 12px", marginBottom: 4 }}>
                          {["Agent","Dials","KIT","Hot","Appt","Joined"].map(h => (
                            <div key={h} style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", textAlign: h === "Agent" ? "left" : "center" }}>{h}</div>
                          ))}
                        </div>
                        {rows.map((row: any, idx: number) => {
                          const dials = recruitingLbPeriod === "today" ? row.today_dials : recruitingLbPeriod === "week" ? row.week_dials : row.total_dials;
                          const kit   = recruitingLbPeriod === "today" ? row.today_kit   : recruitingLbPeriod === "week" ? row.week_kit   : row.kit;
                          const hot   = recruitingLbPeriod === "today" ? row.today_hot   : recruitingLbPeriod === "week" ? row.week_hot   : row.hot_prospects;
                          const appt  = 0; // future
                          const joined = recruitingLbPeriod === "today" ? row.today_joined : recruitingLbPeriod === "week" ? row.week_joined : row.joined;
                          return (
                            <div key={row.caller_id} style={{
                              display: "grid", gridTemplateColumns: "1fr 60px 60px 60px 60px 60px",
                              gap: 8, alignItems: "center",
                              background: idx === 0 ? "rgba(200,170,90,0.06)" : "rgba(255,255,255,0.02)",
                              border: `1px solid ${idx === 0 ? "rgba(200,170,90,0.2)" : "rgba(255,255,255,0.06)"}`,
                              borderRadius: 10, padding: "12px 12px",
                            }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ fontSize: 11, fontWeight: 700, color: idx === 0 ? "rgba(200,170,90,0.8)" : "rgba(255,255,255,0.3)", width: 16 }}>#{idx + 1}</span>
                                {row.headshot_url ? (
                                  <img src={row.headshot_url} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} />
                                ) : (
                                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(79,184,163,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#4fb8a3", fontWeight: 700 }}>
                                    {(row.agent_name || "?")[0]}
                                  </div>
                                )}
                                <span style={{ fontSize: 13, color: "#fff", fontWeight: 500 }}>{row.agent_name || "Unknown"}</span>
                              </div>
                              {[dials, kit, hot, appt, joined].map((val, i) => (
                                <div key={i} style={{ textAlign: "center", fontSize: 16, fontWeight: 300, color: i === 4 && val > 0 ? "#22c55e" : i === 2 && val > 0 ? "#f97316" : "rgba(255,255,255,0.7)" }}>
                                  {val || 0}
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── QUICK ADD TAB ── */}
              {recruitingSubTab === "quick" && (
                <div className="max-w-lg space-y-4">
                  <p className="text-sm text-muted-foreground">Fast entry for events, open houses, or cold outreach. Name and phone are required.</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-foreground/70">First Name *</Label>
                      <Input value={quickAddForm.firstName} onChange={e => setQuickAddForm(p => ({...p, firstName: e.target.value}))}
                        className="bg-secondary border-border" placeholder="Sarah" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-foreground/70">Last Name *</Label>
                      <Input value={quickAddForm.lastName} onChange={e => setQuickAddForm(p => ({...p, lastName: e.target.value}))}
                        className="bg-secondary border-border" placeholder="Martinez" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-foreground/70">Phone *</Label>
                      <Input value={quickAddForm.phone} onChange={e => setQuickAddForm(p => ({...p, phone: e.target.value}))}
                        className="bg-secondary border-border" placeholder="9045550123" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-foreground/70">Email</Label>
                      <Input value={quickAddForm.email} onChange={e => setQuickAddForm(p => ({...p, email: e.target.value}))}
                        className="bg-secondary border-border" placeholder="sarah@realty.com" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-foreground/70">Current Brokerage</Label>
                      <Input value={quickAddForm.currentBrokerage} onChange={e => setQuickAddForm(p => ({...p, currentBrokerage: e.target.value}))}
                        className="bg-secondary border-border" placeholder="Keller Williams" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-foreground/70">License Status</Label>
                      <Input value={quickAddForm.licenseStatus} onChange={e => setQuickAddForm(p => ({...p, licenseStatus: e.target.value}))}
                        className="bg-secondary border-border" placeholder="Active FL" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-foreground/70">Territory Interest</Label>
                    <Input value={quickAddForm.territory} onChange={e => setQuickAddForm(p => ({...p, territory: e.target.value}))}
                      className="bg-secondary border-border" placeholder="e.g. Ponte Vedra / Nocatee" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-foreground/70">Notes</Label>
                    <Input value={quickAddForm.notes} onChange={e => setQuickAddForm(p => ({...p, notes: e.target.value}))}
                      className="bg-secondary border-border" placeholder="Met at open house on Coastal Hwy..." />
                  </div>
                  <button onClick={handleSubmitQuickAdd} disabled={quickAddSubmitting} style={{
                    width: "100%", padding: "14px",
                    background: quickAddSubmitting ? "rgba(79,184,163,0.3)" : "linear-gradient(135deg, rgba(79,184,163,0.8), rgba(79,184,163,0.5))",
                    border: "none", borderRadius: 6,
                    fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                    color: quickAddSubmitting ? "rgba(255,255,255,0.4)" : "#080808",
                    cursor: quickAddSubmitting ? "not-allowed" : "pointer",
                  }}>{quickAddSubmitting ? "Adding..." : "Add to Recruiting Queue"}</button>
                </div>
              )}

              {/* ── BULK IMPORT TAB ── */}
              {recruitingSubTab === "bulk" && (
                <div className="max-w-lg space-y-4">
                  <p className="text-sm text-muted-foreground">Import a list of agent prospects via CSV. Supports up to 1,000 rows. Must include: First Name, Last Name, Phone.</p>
                  <div
                    style={{
                      border: `2px dashed ${agentLeadDragOver ? "rgba(79,184,163,0.5)" : "rgba(255,255,255,0.1)"}`,
                      borderRadius: 10, padding: "40px 20px", textAlign: "center",
                      cursor: "pointer",
                      background: agentLeadDragOver ? "rgba(79,184,163,0.04)" : "transparent",
                      transition: "all 0.15s",
                    }}
                    onClick={() => agentLeadFileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setAgentLeadDragOver(true); }}
                    onDragLeave={() => setAgentLeadDragOver(false)}
                    onDrop={handleAgentLeadDrop}
                  >
                    <Upload style={{ margin: "0 auto 8px", color: agentLeadDragOver ? "#4fb8a3" : "rgba(255,255,255,0.3)" }} size={24} />
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>
                      {agentLeadUploading
                        ? (agentLeadRowCount ? `Importing ${agentLeadRowCount.toLocaleString()} prospects...` : "Importing...")
                        : agentLeadDragOver ? "Drop CSV here" : "Click or drag a CSV file here"}
                    </p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 4 }}>
                      Columns: First Name, Last Name, Phone, Email, Current Brokerage, License Status, Territory, Notes
                    </p>
                  </div>
                  <input ref={agentLeadFileRef} type="file" accept=".csv" className="hidden" onChange={handleAgentLeadUpload} />

                  {/* DBPR Scraper Tile */}
                  <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 20, marginTop: 4 }}>
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div>
                        <p style={{ fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,170,90,0.7)", fontWeight: 600, marginBottom: 4 }}>DBPR Auto-Scraper</p>
                        <p className="text-xs text-muted-foreground" style={{ lineHeight: 1.5 }}>
                          Pulls active licensed agents from the Florida DBPR weekly extract across Nassau, Duval, and St. Johns counties. Runs automatically every Sunday at 2am.
                        </p>
                      </div>
                      {dbprStatsQuery.data && (
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 22, fontWeight: 300, color: "rgba(200,170,90,0.9)", lineHeight: 1 }}>{(dbprStatsQuery.data.total || 0).toLocaleString()}</div>
                          <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginTop: 2 }}>DBPR agents</div>
                        </div>
                      )}
                    </div>
                    {dbprResult && (
                      <div style={{
                        background: dbprResult.error ? "rgba(161,44,123,0.08)" : "rgba(79,184,163,0.07)",
                        border: `1px solid ${dbprResult.error ? "rgba(161,44,123,0.25)" : "rgba(79,184,163,0.2)"}`,
                        borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 12,
                      }}>
                        {dbprResult.error ? (
                          <p style={{ color: "rgba(209,99,167,0.9)" }}>{dbprResult.error}</p>
                        ) : (
                          <div className="space-y-0.5" style={{ color: "rgba(255,255,255,0.7)" }}>
                            <p>{dbprResult.message}</p>
                            {dbprResult.inserted > 0 && (
                              <p style={{ color: "rgba(79,184,163,0.8)", fontSize: 11 }}>
                                +{dbprResult.inserted} new · {dbprResult.updated} refreshed · {dbprResult.filtered} filtered
                                {dbprResult.runDurationMs ? ` · ${(dbprResult.runDurationMs / 1000 / 60).toFixed(1)} min` : ""}
                              </p>
                            )}
                            {dbprResult.warning && <p style={{ color: "rgba(200,170,90,0.8)", fontSize: 11 }}>⚠ {dbprResult.warning}</p>}
                          </div>
                        )}
                      </div>
                    )}
                    {dbprStatsQuery.data?.lastRun && (
                      <p className="text-xs text-muted-foreground mb-3">
                        Last run: {new Date(dbprStatsQuery.data.lastRun).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    )}
                    <Button size="sm" variant="outline" disabled={dbprRunning}
                      style={{ borderColor: "rgba(200,170,90,0.35)", color: "rgba(200,170,90,0.9)", fontSize: 11, fontWeight: 600, letterSpacing: "0.04em" }}
                      className="gap-1.5 hover:bg-yellow-900/20"
                      onClick={async () => {
                        setDbprRunning(true); setDbprResult(null);
                        try {
                          const res = await apiRequest("POST", "/api/admin/dbpr-run", {});
                          const data = await res.json();
                          setDbprResult(data);
                          dbprStatsQuery.refetch();
                        } catch (e: any) {
                          setDbprResult({ error: e.message || "DBPR run failed" });
                        } finally { setDbprRunning(false); }
                      }}
                    >
                      {dbprRunning ? <><RefreshCw size={11} className="animate-spin" /> Scraping DBPR… (may take 10–30 min)</> : <><RefreshCw size={11} /> Run DBPR Scrape Now</>}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </TabsContent>

                    <TabsContent value="agents"
 className="mt-5 space-y-5">

            {/* v13.1 — Queue Management moved to Admin tab */}

            {/* v14.48 — One unified list. Flow toggle is the ONLY control for lead flow.
                Soft-deleted agents (isActive=false) vanish completely. No Inactive section. */}
            {(() => {
              const allUsers = agents.filter(a => a.isActive);
              // Sort: Flow ON first (round-robin order preserved), Flow OFF last.
              const sortedActive = [...allUsers].sort((a, b) => {
                const aOn = a.leadFlowOn !== false ? 1 : 0;
                const bOn = b.leadFlowOn !== false ? 1 : 0;
                if (aOn !== bOn) return bOn - aOn;
                return 0;
              });
              // v14.62 Phase D — Inactive Agents section: deactivated within last 7 days.
              // Server enforces the 7d reactivate window (returns 410 Gone past that). Client
              // filters to only show deactivated agents that are still within-window OR were
              // deactivated but have no timestamp (legacy pre-v14.61 rows) so admin can still
              // see them and take action. Merge tombstones (email starts with 'tombstone:')
              // are excluded — they represent a merged-away row, not a genuine inactive agent.
              const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
              const inactiveAgents = agents
                .filter(a => !a.isActive)
                .filter(a => !(a.email || "").startsWith("tombstone:"))
                .sort((a, b) => (b.deactivatedAt ?? 0) - (a.deactivatedAt ?? 0));
              return (
                <>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 style={{
                          fontFamily: "'Cormorant Garamond','Georgia',serif",
                          fontSize: "1.2rem", fontWeight: 300, color: "#fff",
                        }}>
                          Agents
                        </h2>
                        <p className="text-xs text-muted-foreground mt-0.5">Flow on = receives leads. Flow off = paused. Trash = remove from team.</p>
                        {/* Activity Export button */}
                        <button
                          onClick={handleExportActivity}
                          style={{
                            marginTop: 6, fontSize: 10, letterSpacing: "0.1em",
                            textTransform: "uppercase", color: "rgba(200,170,90,0.7)",
                            background: "rgba(200,170,90,0.06)", border: "1px solid rgba(200,170,90,0.2)",
                            borderRadius: 6, padding: "3px 10px", cursor: "pointer",
                          }}
                        >⬇ Export Activity CSV</button>
                      </div>
                      <Dialog open={agentDialogOpen} onOpenChange={setAgentDialogOpen}>
                        <DialogTrigger asChild>
                          <button
                            style={{
                              display: "flex", alignItems: "center", gap: 6,
                              padding: "8px 16px",
                              background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                              border: "none", borderRadius: 6,
                              fontSize: 12, fontWeight: 600, letterSpacing: "0.08em",
                              color: "#080808", cursor: "pointer",
                            }}
                            data-testid="button-add-agent"
                          >
                            <Plus size={12}/>Add Agent
                          </button>
                        </DialogTrigger>
                        <DialogContent style={{
                          background: "#0f0f0f",
                          border: "1px solid rgba(200,170,90,0.15)",
                        }}>
                          <DialogHeader>
                            <DialogTitle style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 300, fontSize: "1.3rem", color: "#fff" }}>
                              Add Agent
                            </DialogTitle>
                          </DialogHeader>
                          <div className="space-y-3 mt-2">
                            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", lineHeight: 1.6, margin: "0 0 8px" }}>
                              Enter the agent's name and email. They'll receive a secure invitation link to set their own password and complete their profile.
                            </p>
                            <div className="space-y-1">
                              <Label className="text-xs text-foreground/60">Full Name</Label>
                              <Input value={newAgent.name} onChange={e => setNewAgent(p => ({...p, name: e.target.value}))} className="bg-secondary border-border" placeholder="Jane Smith" data-testid="input-agent-name"/>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs text-foreground/60">Email Address</Label>
                              <Input type="email" value={newAgent.email} onChange={e => setNewAgent(p => ({...p, email: e.target.value}))} className="bg-secondary border-border" placeholder="jane@momentum.com" data-testid="input-agent-email"/>
                              <div>
                                <Label className="text-xs text-muted-foreground">Role</Label>
                                <select
                                  value={newAgent.role}
                                  onChange={e => setNewAgent(p => ({...p, role: e.target.value}))}
                                  style={{
                                    width: "100%", padding: "8px 10px", marginTop: 4,
                                    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                                    borderRadius: 6, color: "#e5e5e5", fontSize: 13, cursor: "pointer",
                                  }}
                                >
                                  <option value="agent" style={{ background: "#111" }}>Agent — works seller leads</option>
                                  <option value="admin" style={{ background: "#111" }}>Admin — full access (incl. Recruiting Depot)</option>
                                </select>
                              </div>
                            </div>
                            <button
                              style={{
                                width: "100%", padding: "12px",
                                background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                                border: "none", borderRadius: 6,
                                fontSize: 12, fontWeight: 600, letterSpacing: "0.08em",
                                color: "#080808", cursor: "pointer",
                                opacity: (createAgentMutation.isPending || !newAgent.name || !newAgent.email) ? 0.5 : 1,
                              }}
                              onClick={() => createAgentMutation.mutate({ name: newAgent.name, email: newAgent.email, role: newAgent.role })}
                              disabled={createAgentMutation.isPending || !newAgent.name || !newAgent.email}
                              data-testid="button-save-agent"
                            >
                              {createAgentMutation.isPending ? "Sending invite…" : "Send Invitation"}
                            </button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>

                    {/* v13.1 — Agent Inactivity Alert moved to Admin tab */}
                    <div className="space-y-2">
                      {sortedActive.map((agent, idx) => {
                        // v14.48 — Flow is the only control. Same rule for admins and agents.
                        const flowActive = agent.leadFlowOn !== false;
                        return (
                          <div
                            key={agent.id}
                            style={{
                              background: flowActive
                                ? "linear-gradient(135deg,#0f0f0f 0%,#0a0a0a 100%)"
                                : "rgba(255,255,255,0.015)",
                              border: `1px solid ${flowActive ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)"}`,
                              borderRadius: 10, padding: "12px 16px",
                              display: "flex", alignItems: "center", gap: 12,
                              opacity: flowActive ? 1 : 0.6,
                              transition: "all 0.2s",
                            }}
                            data-testid={`row-agent-${agent.id}`}
                          >
                            {(() => {
                              const initials = agent.name.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2);
                              if (agent.headshotUrl) return (
                                <img src={agent.headshotUrl} alt={agent.name}
                                  style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover",
                                    border: "2px solid rgba(200,170,90,0.4)", flexShrink: 0 }}
                                  onError={(e) => { e.currentTarget.style.display='none'; }}
                                />
                              );
                              return (
                                <div style={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  border: "1px solid rgba(200,170,90,0.25)", background: "rgba(200,170,90,0.06)",
                                  fontSize: 11, fontWeight: 700, color: "#c8aa5a",
                                  fontFamily: "'Cormorant Garamond','Georgia',serif" }}>
                                  {initials}
                                </div>
                              );
                            })()}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground">{agent.name}</p>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <p className="text-xs text-muted-foreground" style={{ margin: 0 }}>{agent.email}</p>
                                <button
                                  type="button"
                                  onClick={() => handleEditAgentEmail({ id: agent.id, name: agent.name, email: agent.email })}
                                  title="Edit email"
                                  data-testid={`button-edit-email-${agent.id}`}
                                  style={{
                                    background: "transparent", border: "none", padding: 0,
                                    cursor: "pointer", color: "rgba(200,170,90,0.55)",
                                    fontSize: 11, lineHeight: 1,
                                  }}
                                >✎</button>
                              </div>
                              {/* v14.0 — Territory pickers removed. Home County is the only location control. */}
                              <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                                {/* v13.9 — Home County picker (drives lead-serving order) */}
                                <select
                                  value={(agent as any).homeCounty || ""}
                                  title="Home county — lead flow serves this county first, then overflows"
                                  onChange={e => {
                                    const val = e.target.value || null;
                                    apiRequest("PATCH", `/api/admin/agents/${agent.id}/home-county`, { homeCounty: val })
                                      .then(() => qc.invalidateQueries({ queryKey: ["/api/agents"] }))
                                      .catch(() => {});
                                  }}
                                  style={{
                                    fontSize: 10, letterSpacing: "0.06em",
                                    background: "rgba(56,189,248,0.07)",
                                    border: "1px solid rgba(56,189,248,0.28)",
                                    borderRadius: 5, color: "#38bdf8",
                                    padding: "2px 6px", cursor: "pointer", maxWidth: 190,
                                    textTransform: "uppercase",
                                  }}
                                >
                                  <option value="" style={{ background: "#111", color: "#38bdf8" }}>Home — all counties</option>
                                  <option value="Nassau" style={{ background: "#111", color: "#38bdf8" }}>Nassau</option>
                                  <option value="Duval" style={{ background: "#111", color: "#38bdf8" }}>Duval</option>
                                  <option value="St Johns" style={{ background: "#111", color: "#38bdf8" }}>St Johns</option>
                                </select>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="flex flex-col items-center gap-0.5">
                                <span className="text-[10px] text-muted-foreground">Flow</span>
                                <LuxToggle
                                  on={flowActive}
                                  onToggle={() => toggleLeadFlowMutation.mutate({ id: agent.id, leadFlowOn: !flowActive })}
                                  testId={`toggle-lead-flow-${agent.id}`}
                                />
                              </div>
                              <Badge variant="outline" className={`text-xs ${flowActive ? "text-green-400 border-green-400/30" : "text-muted-foreground border-white/10"}`}>
                                {flowActive ? "Flow On" : "Flow Off"}
                              </Badge>
                              {/* v14.0 — Min Dials/Wk gate removed. Motivation over shaming. */}
                              {/* v14.62 Phase D — Lifecycle actions: reset password, merge, audit log */}
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-amber-400"
                                onClick={() => openConfirm({
                                  title: `Send password reset to ${agent.name}?`,
                                  message: `An email with a secure reset link will be sent to ${agent.email}. The link expires in 1 hour. Any active sessions will be revoked when they use it.`,
                                  confirmLabel: "Send reset email",
                                  confirmColor: "#c8aa5a",
                                  onConfirm: () => { closeConfirm(); resetPasswordMutation.mutate(agent.id); },
                                })}
                                title="Send password reset email"
                                data-testid={`button-reset-password-${agent.id}`}
                                disabled={resetPasswordMutation.isPending}
                              >
                                <Mail size={13}/>
                              </Button>
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-blue-400"
                                onClick={() => { setMergeSourceAgent(agent); setMergeTargetId(null); }}
                                title="Merge into another agent"
                                data-testid={`button-merge-agent-${agent.id}`}
                              >
                                <Users size={13}/>
                              </Button>
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-purple-400"
                                onClick={() => setAuditLogAgentId(agent.id)}
                                title="View audit log"
                                data-testid={`button-audit-log-${agent.id}`}
                              >
                                <ScrollText size={13}/>
                              </Button>
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={() => openConfirm({
                                  title: `Deactivate ${agent.name}?`,
                                  message: `${agent.name} will be moved to Inactive Agents. All leads in their queue return to the pool. They can be reactivated within 7 days.`,
                                  confirmLabel: "Deactivate",
                                  confirmColor: "#ef4444",
                                  onConfirm: () => { closeConfirm(); deleteAgentMutation.mutate(agent.id); },
                                })}
                                title="Deactivate agent"
                                data-testid={`button-delete-agent-${agent.id}`}
                              >
                                <Trash2 size={13}/>
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                      {sortedActive.length === 0 && (
                        <div style={{
                          padding: "40px 20px", textAlign: "center",
                          border: "1px dashed rgba(200,170,90,0.1)",
                          borderRadius: 12, color: "rgba(255,255,255,0.3)", fontSize: 13,
                        }}>
                          No agents yet. Add one above.
                        </div>
                      )}
                    </div>
                  </div>

                  {/* v14.62 Phase D — Inactive Agents section restored with 7-day reactivate window. */}
                  {inactiveAgents.length > 0 && (
                    <div className="space-y-3">
                      <div>
                        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.1rem", fontWeight: 300, color: "rgba(255,255,255,0.4)" }}>
                          Inactive Agents
                        </h2>
                        <p className="text-xs text-muted-foreground">Deactivated agents. Reactivate any time to bring them back, or hard-delete to remove permanently (historical activity is preserved as anonymous).</p>
                      </div>
                      <div className="space-y-2">
                        {inactiveAgents.map((agent) => {
                          // v14.81.2 — Removed the 7-day reactivate window. Deactivated timestamp is
                          // shown for reference only — admins can reactivate OR hard-delete at any time.
                          const deactivatedAt = (agent as any).deactivatedAt ?? null;
                          const msSinceDeactivate = deactivatedAt ? Date.now() - deactivatedAt : null;
                          const daysAgo = msSinceDeactivate ? Math.floor(msSinceDeactivate / (24*60*60*1000)) : null;
                          const countdownText = deactivatedAt === null
                            ? "Legacy inactive (no timestamp)"
                            : daysAgo === 0 ? "Deactivated today"
                              : daysAgo === 1 ? "Deactivated 1 day ago"
                              : `Deactivated ${daysAgo} days ago`;
                          return (
                            <div
                              key={agent.id}
                              style={{
                                background: "rgba(255,255,255,0.01)",
                                border: "1px solid rgba(255,255,255,0.05)",
                                borderRadius: 10, padding: "12px 16px",
                                display: "flex", alignItems: "center", gap: 12,
                                opacity: 0.55,
                              }}
                              data-testid={`row-inactive-agent-${agent.id}`}
                            >
                              {(() => {
                                const initials = agent.name.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2);
                                if (agent.headshotUrl) return (
                                  <img src={agent.headshotUrl} alt={agent.name}
                                    style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover",
                                      border: "2px solid rgba(200,170,90,0.4)", flexShrink: 0 }}
                                    onError={(e) => { e.currentTarget.style.display='none'; }}
                                  />
                                );
                                return (
                                  <div style={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                    border: "1px solid rgba(200,170,90,0.25)", background: "rgba(200,170,90,0.06)",
                                    fontSize: 11, fontWeight: 700, color: "#c8aa5a",
                                    fontFamily: "'Cormorant Garamond','Georgia',serif" }}>
                                    {initials}
                                  </div>
                                );
                              })()}
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-foreground/70">{agent.name}</p>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <p className="text-xs text-muted-foreground" style={{ margin: 0 }}>{agent.email}</p>
                                  <button
                                    type="button"
                                    onClick={() => handleEditAgentEmail({ id: agent.id, name: agent.name, email: agent.email })}
                                    title="Edit email"
                                    data-testid={`button-edit-email-${agent.id}`}
                                    style={{
                                      background: "transparent", border: "none", padding: 0,
                                      cursor: "pointer", color: "rgba(200,170,90,0.55)",
                                      fontSize: 11, lineHeight: 1,
                                    }}
                                  >✎</button>
                                </div>
                              </div>
                              <div className="flex flex-col items-end gap-1">
                                <div className="flex items-center gap-2">
                                  <Badge variant="outline" className="text-xs text-red-400 border-red-400/30">Deactivated</Badge>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="gap-1.5 text-xs border-green-500/40 text-green-400 hover:bg-green-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                    onClick={() => reactivateAgentMutation.mutate(agent.id)}
                                    disabled={reactivateAgentMutation.isPending}
                                    title={`Reactivate ${agent.name}`}
                                    data-testid={`button-reactivate-agent-${agent.id}`}
                                  >
                                    <Power size={11}/> Re-activate
                                  </Button>
                                  {/* v14.81.2 — Hard-delete. Permanent removal with confirmation prompt. */}
                                  <Button
                                    variant="ghost" size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed"
                                    onClick={() => {
                                      const ok = window.confirm(`Permanently DELETE ${agent.name}?\n\nThis removes the agent row entirely. Their historical activity (calls made, leads worked) will be preserved as anonymous but their name/email will be gone.\n\nThis cannot be undone. Type YES on the next prompt to confirm.`);
                                      if (!ok) return;
                                      const typed = window.prompt(`Type DELETE to permanently remove ${agent.name}:`);
                                      if (typed !== "DELETE") { alert("Not deleted (you must type DELETE exactly)."); return; }
                                      hardDeleteAgentMutation.mutate(agent.id);
                                    }}
                                    disabled={hardDeleteAgentMutation.isPending}
                                    title={`Permanently delete ${agent.name}`}
                                    data-testid={`button-hard-delete-agent-${agent.id}`}
                                  >
                                    <Trash2 size={13}/>
                                  </Button>
                                  <Button
                                    variant="ghost" size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-blue-400"
                                    onClick={() => { setMergeSourceAgent(agent); setMergeTargetId(null); }}
                                    title="Merge into another agent"
                                    data-testid={`button-merge-agent-${agent.id}`}
                                  >
                                    <Users size={13}/>
                                  </Button>
                                  <Button
                                    variant="ghost" size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-purple-400"
                                    onClick={() => setAuditLogAgentId(agent.id)}
                                    title="View audit log"
                                    data-testid={`button-audit-log-${agent.id}`}
                                  >
                                    <ScrollText size={13}/>
                                  </Button>
                                </div>
                                <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.4)" }}>{countdownText}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </TabsContent>

          {/* ── SCRIPTS ─────────────────────────────────────────────────────── */}
          <TabsContent value="scripts" className="mt-5">
            <ScriptEditor />
          </TabsContent>

          {/* ── MAP VIEW ────────────────────────────────────────────────────── */}
          <TabsContent value="map" className="mt-5">
            <MapView />
          </TabsContent>

          {/* ── MY PROFILE ─────────────────────────────────────────────────── */}
          <TabsContent value="profile" className="mt-5">
            <ProfilePage onBack={() => {}} />
          </TabsContent>

        </Tabs>
      </main>

      {/* Agent drilldown modal */}
      {drilldownAgent && (
        <AgentDrilldown
          agentId={drilldownAgent.id}
          agentName={drilldownAgent.name}
          onClose={() => setDrilldownAgent(null)}
        />
      )}

      {/* v14.81.2 — Hard Reset modal (hoisted to top level so it renders on every tab) */}
      {hardResetOpen && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
          backdropFilter: "blur(4px)",
        }} onClick={() => { if (!hardResetBusy) { setHardResetOpen(null); setHardResetInput(""); } }}>
          <div style={{
            background: "#0a0a0a", border: "1px solid rgba(239,68,68,0.4)",
            borderRadius: 12, padding: 28, maxWidth: 480, width: "90%",
            boxShadow: "0 20px 60px rgba(239,68,68,0.2)",
          }} onClick={e => e.stopPropagation()}>
            <p style={{ fontSize: 13, fontWeight: 700, color: "#ef4444", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
              ⚠ Hard Reset {hardResetOpen === "seller" ? "Seller Depot" : "Recruiting Depot"}
            </p>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", marginBottom: 8, lineHeight: 1.5 }}>
              This will permanently delete{" "}
              <b style={{ color: "#fff" }}>
                {hardResetOpen === "seller"
                  ? `${stats?.totalLeads ?? 0} seller lead${(stats?.totalLeads ?? 0) === 1 ? "" : "s"}, all activity, points, and appointments`
                  : "every recruiting lead, all activity, and recruiting points"}
              </b>.
            </p>
            <p style={{ fontSize: 12, color: "rgba(239,68,68,0.85)", marginBottom: 16, lineHeight: 1.5 }}>
              Cannot be undone. Type <b>RESET</b> below to confirm.
            </p>
            <input
              autoFocus
              value={hardResetInput}
              onChange={e => setHardResetInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && hardResetInput === "RESET" && !hardResetBusy) runHardReset(); }}
              placeholder="Type RESET"
              disabled={hardResetBusy}
              style={{
                width: "100%", padding: "12px 14px", fontSize: 14, fontWeight: 600,
                background: "rgba(255,255,255,0.06)", color: "#fff",
                border: `1px solid ${hardResetInput === "RESET" ? "#ef4444" : "rgba(239,68,68,0.3)"}`,
                borderRadius: 8, marginBottom: 14, outline: "none",
                letterSpacing: "0.05em", textTransform: "uppercase",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { setHardResetOpen(null); setHardResetInput(""); }}
                disabled={hardResetBusy}
                style={{ padding: "9px 16px", fontSize: 13, borderRadius: 6, background: "transparent", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", cursor: hardResetBusy ? "not-allowed" : "pointer", opacity: hardResetBusy ? 0.5 : 1 }}>
                Cancel
              </button>
              <button onClick={runHardReset} disabled={hardResetInput !== "RESET" || hardResetBusy}
                style={{ padding: "9px 18px", fontSize: 13, fontWeight: 700, borderRadius: 6,
                  background: (hardResetInput === "RESET" && !hardResetBusy) ? "#ef4444" : "rgba(239,68,68,0.3)",
                  color: "#fff", border: "none",
                  cursor: (hardResetInput === "RESET" && !hardResetBusy) ? "pointer" : "not-allowed",
                  transition: "background 120ms ease",
                }}>
                {hardResetBusy ? "Deleting…" : "Delete Everything"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Luxury confirm modal */}
      <LuxConfirmModal
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmColor={confirmDialog.confirmColor}
        onConfirm={confirmDialog.onConfirm}
        onCancel={closeConfirm}
      />

      {/* v14.62 Phase D — Merge Agents dialog. Source picker is the row you clicked from;
           target picker is a searchable dropdown of every other active non-tombstone agent.
           Server (POST /api/admin/agents/merge) re-parents all leads + activities to target
           and turns source into a tombstone row (email prefixed with 'tombstone:<sourceId>:'). */}
      <Dialog open={mergeSourceAgent !== null} onOpenChange={(open) => { if (!open) { setMergeSourceAgent(null); setMergeTargetId(null); } }}>
        <DialogContent style={{ background: "#0f0f0f", border: "1px solid rgba(200,170,90,0.15)", maxWidth: 480 }}>
          <DialogHeader>
            <DialogTitle style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 300, fontSize: "1.3rem", color: "#fff" }}>
              Merge Agent
            </DialogTitle>
          </DialogHeader>
          {mergeSourceAgent && (
            <div className="space-y-4 mt-2">
              <div style={{ padding: 12, borderRadius: 8, background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.2)" }}>
                <p className="text-xs" style={{ color: "rgba(239,68,68,0.85)", letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 6px" }}>Source (will become tombstone)</p>
                <p className="text-sm text-foreground" style={{ margin: 0 }}>{mergeSourceAgent.name}</p>
                <p className="text-xs text-muted-foreground" style={{ margin: 0 }}>{mergeSourceAgent.email}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-foreground/60">Merge into (target survives)</Label>
                <select
                  value={mergeTargetId ?? ""}
                  onChange={e => setMergeTargetId(e.target.value ? parseInt(e.target.value) : null)}
                  style={{
                    width: "100%", padding: "10px 12px",
                    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 6, color: "#e5e5e5", fontSize: 13, cursor: "pointer",
                  }}
                  data-testid="merge-target-select"
                >
                  <option value="" style={{ background: "#111" }}>— Pick target agent —</option>
                  {agents
                    .filter(a => a.id !== mergeSourceAgent.id && a.isActive && !(a.email || "").startsWith("tombstone:"))
                    .map(a => (
                      <option key={a.id} value={a.id} style={{ background: "#111" }}>{a.name} — {a.email}</option>
                    ))}
                </select>
              </div>
              <div style={{ padding: 10, borderRadius: 6, background: "rgba(200,170,90,0.05)", border: "1px solid rgba(200,170,90,0.15)" }}>
                <p className="text-[11px]" style={{ color: "rgba(200,170,90,0.8)", lineHeight: 1.6, margin: 0 }}>
                  All leads, activities, and lead-history rows currently pointing at <strong>{mergeSourceAgent.name}</strong> will be re-parented to the target. This is irreversible. The source row remains for audit but its login is deactivated.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  style={{
                    flex: 1, padding: "10px 16px",
                    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 6, fontSize: 12, color: "rgba(255,255,255,0.7)", cursor: "pointer",
                  }}
                  onClick={() => { setMergeSourceAgent(null); setMergeTargetId(null); }}
                  data-testid="merge-cancel"
                >Cancel</button>
                <button
                  style={{
                    flex: 1, padding: "10px 16px",
                    background: mergeTargetId && !mergeAgentMutation.isPending
                      ? "linear-gradient(135deg,#ef4444 0%,#b91c1c 100%)"
                      : "rgba(239,68,68,0.2)",
                    border: "none", borderRadius: 6,
                    fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase",
                    color: mergeTargetId ? "#fff" : "rgba(255,255,255,0.4)",
                    cursor: mergeTargetId && !mergeAgentMutation.isPending ? "pointer" : "not-allowed",
                  }}
                  onClick={() => {
                    if (!mergeTargetId || !mergeSourceAgent) return;
                    openConfirm({
                      title: `Merge ${mergeSourceAgent.name} into another agent?`,
                      message: `This will re-parent every lead and activity from ${mergeSourceAgent.name} to the target agent. ${mergeSourceAgent.name} becomes a tombstone (cannot log in). This is irreversible.`,
                      confirmLabel: "Merge",
                      confirmColor: "#ef4444",
                      onConfirm: () => {
                        closeConfirm();
                        mergeAgentMutation.mutate(
                          { sourceId: mergeSourceAgent.id, targetId: mergeTargetId },
                          { onSuccess: () => { setMergeSourceAgent(null); setMergeTargetId(null); } },
                        );
                      },
                    });
                  }}
                  disabled={!mergeTargetId || mergeAgentMutation.isPending}
                  data-testid="merge-confirm"
                >{mergeAgentMutation.isPending ? "Merging…" : "Merge"}</button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* v14.62 Phase D — Audit Log dialog. Renders the full lifecycle trail for one agent
           (invite_sent, setup_completed, email_changed, password_reset, deactivated,
           reactivated, merged_into, merge_received, etc.) with actor + timestamp + notes. */}
      <Dialog open={auditLogAgentId !== null} onOpenChange={(open) => { if (!open) setAuditLogAgentId(null); }}>
        <DialogContent style={{ background: "#0f0f0f", border: "1px solid rgba(200,170,90,0.15)", maxWidth: 720, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <DialogHeader>
            <DialogTitle style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 300, fontSize: "1.3rem", color: "#fff" }}>
              Agent Audit Log
              {auditLogAgentId !== null && (() => {
                const a = agents.find(x => x.id === auditLogAgentId);
                return a ? <span className="text-xs" style={{ color: "rgba(200,170,90,0.6)", marginLeft: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>{a.name}</span> : null;
              })()}
            </DialogTitle>
          </DialogHeader>
          <div style={{ overflowY: "auto", flex: 1, marginTop: 8 }}>
            {auditLogQuery.isLoading && <p className="text-sm text-muted-foreground p-4">Loading…</p>}
            {auditLogQuery.isError && <p className="text-sm text-red-400 p-4">Failed to load audit log.</p>}
            {auditLogQuery.data && auditLogQuery.data.entries.length === 0 && (
              <p className="text-sm text-muted-foreground p-4">No audit entries recorded for this agent yet.</p>
            )}
            {auditLogQuery.data && auditLogQuery.data.entries.length > 0 && (
              <div className="space-y-2">
                {auditLogQuery.data.entries.map((entry: any) => (
                  <div key={entry.id} style={{ padding: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Badge variant="outline" className="text-[10px]" style={{ letterSpacing: "0.06em", textTransform: "uppercase", borderColor: "rgba(200,170,90,0.3)", color: "#c8aa5a" }}>{entry.event}</Badge>
                        <span className="text-xs text-foreground/80">{entry.actor_name || "system"}</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">{new Date(entry.ts).toLocaleString()}</span>
                    </div>
                    {entry.notes && <p className="text-xs text-muted-foreground mt-1" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{entry.notes}</p>}
                    {(entry.before_json || entry.after_json) && (
                      <details style={{ marginTop: 6 }}>
                        <summary className="text-[10px] text-muted-foreground" style={{ cursor: "pointer", letterSpacing: "0.06em", textTransform: "uppercase" }}>Diff</summary>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 4 }}>
                          <pre className="text-[10px]" style={{ background: "rgba(239,68,68,0.05)", padding: 6, borderRadius: 4, overflow: "auto", margin: 0, color: "rgba(255,255,255,0.6)" }}>{entry.before_json || "—"}</pre>
                          <pre className="text-[10px]" style={{ background: "rgba(34,197,94,0.05)", padding: 6, borderRadius: 4, overflow: "auto", margin: 0, color: "rgba(255,255,255,0.6)" }}>{entry.after_json || "—"}</pre>
                        </div>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {auditLogQuery.data && (
            <p className="text-[10px] text-muted-foreground text-right" style={{ marginTop: 8 }}>{auditLogQuery.data.count} entries (most recent first)</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Live Activity Feed drawer */}
      <ActivityFeed open={feedOpen} onClose={() => setFeedOpen(false)} wsRef={wsRef} />
      {/* v14.49 — Admin "Who called me?" modal (reused from AgentView). */}
      {adminLookupOpen && <CallbackLookupModal onClose={() => setAdminLookupOpen(false)} />}

      {/* v14.51 — Spacer to clear the bottom nav so page content isn't hidden behind it. */}
      <div style={{ height: "calc(62px + env(safe-area-inset-bottom, 0px))" }} />

      {/* v14.81.2 — Admin bottom nav is now IDENTICAL to AgentView's nav: 5 slots
         (Dashboard, Pipeline, Dial, Referrals, Profile), Dial is a raised gold
         FAB with a subtle red dot when this admin has queued leads. The old
         "99+" count badge is gone — Alex asked for a red dot only ("signals
         activity without dread"). Dashboard stays on Admin (Leaderboard tab).
         Pipeline/Dial/Referrals/Profile jump into AgentView. */}
      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 30,
        display: "flex",
        background: "linear-gradient(180deg, rgba(10,10,10,0.98) 0%, rgba(6,6,6,0.99) 100%)",
        backdropFilter: "blur(24px)",
        borderTop: "1px solid rgba(200,170,90,0.18)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        boxShadow: "0 -4px 24px rgba(0,0,0,0.5)",
      }}>
        {[
          { id: "dashboard", label: "Dashboard", icon: Trophy,      onClick: () => setAdminTab("leaderboard") },
          { id: "pipeline",  label: "Pipeline",  icon: Layers,      onClick: () => onOpenAgentTab?.("pipeline") },
          { id: "dial",      label: "Dial",      icon: Phone,       onClick: () => (onWorkMyLeads ? onWorkMyLeads() : onOpenAgentTab?.("leads")) },
          { id: "refer",     label: "Referrals", icon: UserPlus,    onClick: () => onOpenAgentTab?.("refer") },
          { id: "profile",   label: "Profile",   icon: UserCircle2, onClick: () => setAdminTab("profile") },
        ].map(n => {
          const Icon = n.icon;
          const active =
            (n.id === "dashboard" && adminTab === "leaderboard") ||
            (n.id === "profile"   && adminTab === "profile");
          const isDial = n.id === "dial";
          const showDot = isDial && adminQueueCount > 0;
          return (
            <button key={n.id} data-testid={`admin-bottom-nav-${n.id}`} onClick={n.onClick} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              gap: isDial ? 3 : 5,
              padding: isDial ? "6px 8px 14px" : "12px 8px 14px",
              background: (!isDial && active) ? "rgba(200,170,90,0.07)" : "transparent",
              borderTop: (!isDial && active) ? "2px solid #c8aa5a" : "2px solid transparent",
              border: "none", cursor: "pointer",
              position: "relative", transition: "all 0.2s ease",
            }}>
              {isDial ? (
                <div style={{
                  position: "relative",
                  width: 52, height: 52,
                  marginTop: -18,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, #c8aa5a 0%, #8a6f2a 100%)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 4px 16px rgba(200,170,90,0.35), 0 0 0 3px rgba(6,6,6,0.98)",
                  transition: "all 0.28s cubic-bezier(0.4, 0, 0.2, 1)",
                  animation: "goModePulseIdle 1.8s ease-in-out infinite",
                }}>
                  <Icon size={26} style={{ color: "#0a0700" }} />
                  {showDot && (
                    <span style={{
                      position: "absolute", top: -2, right: -2,
                      width: 12, height: 12, borderRadius: "50%",
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
                color: isDial ? "#c8aa5a" : (active ? "#c8aa5a" : "rgba(255,255,255,0.35)"),
                fontWeight: isDial ? 700 : (active ? 700 : 400),
                transition: "color 0.15s",
              }}>
                {n.label}
              </span>
            </button>
          );
        })}
      </nav>

      {/* v14.81.2 — GO MODE pulse for the admin Dial FAB (louder + faster than v14.81.2).
         Tier 4 fabBreathe (client/src/pages/AgentView.tsx) is intentionally NOT applied
         here: the admin Dial FAB already runs goModePulseIdle continuously (no idle/active
         split like AgentView), so layering a second background-animating class would fight
         it. Per spec: "skip when goModePulse already active". */}
      <style>{`
        @keyframes goModePulseIdle {
          0%,100% { box-shadow: 0 4px 16px rgba(200,170,90,0.35), 0 0 0 3px rgba(6,6,6,0.98), 0 0 0 4px rgba(200,170,90,0.0), 0 0 0 8px rgba(200,170,90,0.0); }
          50%     { box-shadow: 0 4px 20px rgba(200,170,90,0.55), 0 0 0 3px rgba(6,6,6,0.98), 0 0 0 6px rgba(200,170,90,0.55), 0 0 24px 10px rgba(200,170,90,0.22); }
        }
      `}</style>
    </div>
  );
}
