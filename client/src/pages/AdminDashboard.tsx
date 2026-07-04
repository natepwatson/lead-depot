import { useState, useRef, useCallback, useEffect } from "react";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import ActivityFeed from "../components/ld/ActivityFeed";
import ProfilePage from "./ProfilePage";
import ScriptEditor from "../components/ScriptEditor";
import MapView from "./MapView";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  LogOut, Upload, Download, Users, BarChart3, BarChart2, List, Plus, Trash2,
  Phone, Mail, MapPin, RefreshCw, Trophy, TrendingUp,
  PhoneOff, PhoneMissed, Calendar, XCircle, CheckCircle2,
  AlertTriangle, ChevronRight, X, Layers, ScrollText, Power, Trash, UserCheck, Heart, Map as MapIcon,
  Clock, FileText, ChevronDown, ChevronUp, Activity, Star, Wifi, WifiOff, Shield, Settings
} from "lucide-react";
import type { Lead, Agent } from "@shared/schema";

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
    expired: "Expired", distressed: "Distressed", website_lead: "Website Lead", fsbo: "FSBO", land: "Land",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium type-${type}`}>{labels[type] || type}</span>;
}

function StatCard({ label, value, sub, accent }: { label: string; value: number | string; sub?: string; accent?: string }) {
  return (
    <div style={{
      background: "linear-gradient(135deg, #0f0f0f 0%, #0a0a0a 100%)",
      border: "1px solid rgba(200,170,90,0.1)",
      borderRadius: 10, padding: "16px",
    }}>
      <div style={{ fontSize: 28, fontWeight: 300, lineHeight: 1, marginBottom: 4 }}
        className={accent || "text-foreground"}
      >
        {value}
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

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return obj;
  });
}

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

// ─── CONNECTIVITY HEALTH WIDGET (v11.52) ────────────────────────────────────────
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

export default function AdminDashboard({ onWorkMyLeads }: { onWorkMyLeads?: () => void } = {}) {
  const { user, logout } = useAuth();
  useRealtimeUpdates();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  // Activity Feed
  const [feedOpen, setFeedOpen] = useState(false);
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
  const [dragOver, setDragOver] = useState(false);
  const [uploadType, setUploadType] = useState<"expired" | "distressed" | "website_lead" | "fsbo" | "land">("expired");
  const [websiteLeadForm, setWebsiteLeadForm] = useState({ firstName: "", lastName: "", email: "", phone: "", address: "", city: "", state: "FL", zip: "", county: "", propertyType: "", reasonForSelling: "", estimatedValue: "", timeframe: "" });
  const [submittingWebsiteLead, setSubmittingWebsiteLead] = useState(false);
  const [newAgent, setNewAgent] = useState({ name: "", email: "" });
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<any | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [drilldownAgent, setDrilldownAgent] = useState<{ id: number; name: string } | null>(null);

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

  const { data: myQueueData } = useQuery<{ count: number }>({
    queryKey: [`/api/leads/my-count/${user?.id}`],
    queryFn: () => apiRequest("GET", `/api/leads/my-count/${user?.id}`).then(r => r.json()),
    enabled: !!user?.id,
    refetchInterval: 15000,
  });

  const { data: pipeline, isLoading: pipelineLoading } = useQuery<any>({
    queryKey: ["/api/admin/pipeline"],
    queryFn: () => apiRequest("GET", "/api/admin/pipeline").then(r => r.json()),
    refetchInterval: 15000,
  });

  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
    queryFn: () => apiRequest("GET", "/api/agents").then(r => r.json()),
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
      setNewAgent({ name: "", email: "" });
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
    mutationFn: (id: number) => apiRequest("PATCH", `/api/agents/${id}/reactivate`, {}).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      toast({ title: "Agent reactivated" });
    },
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

  const toggleWebsiteLeadsMutation = useMutation({
    mutationFn: ({ id, receiveWebsiteLeads }: { id: number; receiveWebsiteLeads: boolean }) =>
      apiRequest("PATCH", `/api/agents/${id}/website-leads`, { receiveWebsiteLeads }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/agents"] }),
  });

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

  const processFile = async (file: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (!rows.length) throw new Error("No valid rows found in CSV");
      const batchId = `batch_${Date.now()}`;
      const res = await apiRequest("POST", "/api/leads/upload", {
        leads: rows, leadType: uploadType, uploadedBy: user?.id, batchId,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      const typeLabels: Record<string,string> = { expired:"Expired Listings", distressed:"Distressed", website_lead:"Website Lead", fsbo:"FSBO", land:"Land" };
      const disqNote = data.disqualified > 0 ? ` ${data.disqualified} skipped (missing name or phone).` : "";
      toast({ title: `${data.created} leads uploaded`, description: `Distributed via round-robin as ${typeLabels[uploadType] || uploadType}.${disqNote}` });
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

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.endsWith(".csv")) {
      processFile(file);
    } else {
      toast({ title: "Please drop a .csv file", variant: "destructive" });
    }
  };

  const handleExportCSV = () => {
    window.open("/api/export/leads", "_blank");
  };

  const handleSubmitWebsiteLead = async () => {
    const { firstName, lastName, phone, address } = websiteLeadForm;
    if (!firstName || !lastName || !phone || !address) {
      toast({ title: "Missing fields", description: "First name, last name, phone, and address are required.", variant: "destructive" });
      return;
    }
    setSubmittingWebsiteLead(true);
    try {
      const ownerName = `${firstName} ${lastName}`.trim();
      const fullAddress = [address, websiteLeadForm.city, websiteLeadForm.state, websiteLeadForm.zip].filter(Boolean).join(", ");
      const extraData = JSON.stringify({
        county: websiteLeadForm.county,
        propertyType: websiteLeadForm.propertyType,
        reasonForSelling: websiteLeadForm.reasonForSelling,
        estimatedValue: websiteLeadForm.estimatedValue,
        timeframe: websiteLeadForm.timeframe,
      });
      const batchId = `website_${Date.now()}`;
      const res = await apiRequest("POST", "/api/leads/upload", {
        leads: [{ address: fullAddress, ownerName, phone: websiteLeadForm.phone, email: websiteLeadForm.email, motivation: websiteLeadForm.reasonForSelling, extraData }],
        leadType: "website_lead",
        uploadedBy: user?.id,
        batchId,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit lead");
      toast({ title: "Website lead added", description: `${ownerName} — ${fullAddress} assigned via round-robin.` });
      setWebsiteLeadForm({ firstName: "", lastName: "", email: "", phone: "", address: "", city: "", state: "FL", zip: "", county: "", propertyType: "", reasonForSelling: "", estimatedValue: "", timeframe: "" });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/stats"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/pipeline"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSubmittingWebsiteLead(false);
    }
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
              v11.52
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
          {agents.filter(a => a.role === "admin" && a.id === user?.id && a.receiveLeads).length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs"
              style={{ borderColor: "rgba(200,170,90,0.3)", color: "#c8aa5a" }}
              onClick={() => onWorkMyLeads?.()}
            >
              <Phone size={11}/> Work My Leads
            </Button>
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
            <LogOut size={13}/> Sign out
          </button>
        </div>
      </header>

      <main style={{ padding: "20px 16px", maxWidth: 1200, margin: "0 auto" }}>
        <Tabs defaultValue="leaderboard">
          {/* ── Tab bar ──────────────────────────────────────────────────────── */}
          <TabsList style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(200,170,90,0.12)",
            borderRadius: 8, padding: 4, height: "auto",
            display: "flex", flexWrap: "wrap", gap: 2,
          }}>
            {[
              { value: "leaderboard", icon: Trophy,     label: "Leaderboard" },
              { value: "pipeline",    icon: Layers,      label: "Pipeline" },
              { value: "leads",       icon: List,        label: "All Leads" },
              { value: "map",         icon: MapIcon,     label: "Map View" },
              { value: "reports",     icon: BarChart2,   label: "Reports" },
              { value: "upload",      icon: Upload,      label: "Upload CSV" },
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

          {/* ── LEADERBOARD ─────────────────────────────────────────────────── */}
          <TabsContent value="leaderboard" className="mt-5 space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Total Leads" value={stats?.totalLeads ?? 0} />
              <StatCard label="Active in Queue" value={stats?.activeLeads ?? 0} accent="text-white" />
              <StatCard label="Appointments Set" value={stats?.appointmentsSet ?? 0} accent="text-green-400" />
              <StatCard label="My Lead Queue" value={myQueueData?.count ?? 0} accent={myQueueData?.count ? "text-gold" : undefined} />
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
                <div style={{ flex: 1 }} />
                <div style={{ display: "flex", gap: 20, textAlign: "center", alignItems: "center" }}>
                  {lbTab === "today" ? (
                    <>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Dials</div>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Appts</div>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>KIT</div>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Emails</div>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Refs</div>
                      <div style={{ width: 44, fontSize: 10, color: "#c8aa5a", letterSpacing: "0.07em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 3 }}><Star size={8} style={{ color: "#c8aa5a" }} />Pts</div>
                    </>
                  ) : (
                    <>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Dials</div>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Appts</div>
                      <div style={{ width: 52, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Conv%</div>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Emails</div>
                      <div style={{ width: 44, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>Refs</div>
                      <div style={{ width: 44, fontSize: 10, color: "#c8aa5a", letterSpacing: "0.07em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 3 }}><Star size={8} style={{ color: "#c8aa5a" }} />Pts</div>
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
                // Sort: today → dials desc; weekly → appts desc then dials desc
                const sorted = [...dualLb].sort((a, b) =>
                  lbTab === "today"
                    ? (b.today.dials - a.today.dials) || (b.today.appts - a.today.appts)
                    : (b.weekly.appts - a.weekly.appts) || (b.weekly.dials - a.weekly.dials)
                );
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
                            cursor: "pointer", transition: "border-color 0.2s",
                            display: "flex", alignItems: "center", gap: 12,
                          }}
                          onClick={() => setDrilldownAgent({ id: stat.agent.id, name: stat.agent.name })}
                          onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(200,170,90,0.35)")}
                          onMouseLeave={e => (e.currentTarget.style.borderColor = isTop ? "rgba(200,170,90,0.2)" : "rgba(255,255,255,0.07)")}
                          className="group"
                        >
                          {/* Rank badge — headshot or initials (v11.52) */}
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
                              <span style={{ fontSize: 13, fontWeight: 500, color: "#fff", fontFamily: "'Switzer','Inter',sans-serif" }}>
                                {stat.agent.name}
                              </span>
                              <ChevronRight size={11} className="text-muted-foreground group-hover:text-gold transition-colors" />
                            </div>
                          </div>

                          {/* Stats columns */}
                          <div style={{ display: "flex", gap: 20, textAlign: "center", flexShrink: 0 }}>
                            {lbTab === "today" ? (
                              <>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "rgba(255,255,255,0.8)" }}>{s.dials}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#86efac" }}>{s.appts}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#c4b5fd" }}>{s.kit}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#fbcfe8" }}>{s.emails}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#fde68a" }}>{s.referrals}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{
                                    fontSize: 15, fontWeight: 700, color: "#c8aa5a",
                                    background: "rgba(200,170,90,0.1)", borderRadius: 6,
                                    padding: "2px 6px", display: "inline-block",
                                  }}>{stat.points || 0}</div>
                                </div>
                              </>
                            ) : (
                              <>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "rgba(255,255,255,0.8)" }}>{s.dials}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#86efac" }}>{s.appts}</div>
                                </div>
                                <div style={{ width: 52 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#67e8f9" }}>{s.convRate}%</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#fbcfe8" }}>{s.emails}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{ fontSize: 17, fontWeight: 300, color: "#fde68a" }}>{s.referrals}</div>
                                </div>
                                <div style={{ width: 44 }}>
                                  <div style={{
                                    fontSize: 15, fontWeight: 700, color: "#c8aa5a",
                                    background: "rgba(200,170,90,0.1)", borderRadius: 6,
                                    padding: "2px 6px", display: "inline-block",
                                  }}>{stat.points || 0}</div>
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
          </TabsContent>

          {/* ── PIPELINE ────────────────────────────────────────────────────── */}
          <TabsContent value="pipeline" className="mt-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 style={{
                  fontFamily: "'Cormorant Garamond','Georgia',serif",
                  fontSize: "1.3rem", fontWeight: 300, color: "#fff",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <Layers size={16} style={{ color: "rgba(200,170,90,0.7)" }} />
                  Live Pipeline
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">Every lead from the depot, grouped by stage</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["/api/admin/pipeline"] })} className="gap-1 text-xs text-muted-foreground">
                <RefreshCw size={11}/>Refresh
              </Button>
            </div>

            {pipelineLoading ? (
              <div className="grid gap-3 md:grid-cols-4">
                {Array(8).fill(0).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
              </div>
            ) : (
              <>
                <div className="grid gap-2 grid-cols-2 md:grid-cols-4">
                  {pipelineStages.map(stage => (
                    <div key={stage.key} style={{
                      borderRadius: 10, border: `1px solid ${stage.border}`,
                      background: stage.bg, padding: "12px 16px",
                    }}>
                      <div style={{ fontSize: 24, fontWeight: 300, color: stage.color, lineHeight: 1 }}>
                        {(byStatus[stage.key] || []).length}
                      </div>
                      <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginTop: 4 }}>
                        {stage.label}
                      </div>
                    </div>
                  ))}
                </div>

                <div>
                  <p style={{ fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 10 }}>
                    Active Leads in Flow
                  </p>
                  <div className="space-y-1.5">
                    {(pipeline?.leads || [])
                      .filter((l: any) => ["unassigned","assigned","no_answer","keep_in_touch","callback_requested"].includes(l.status))
                      .slice(0, 50)
                      .map((lead: any) => (
                        <div key={lead.id} style={{
                          background: "rgba(255,255,255,0.02)",
                          border: "1px solid rgba(255,255,255,0.06)",
                          borderRadius: 8, padding: "10px 16px",
                          display: "flex", alignItems: "center", gap: 10,
                        }} data-testid={`row-pipeline-${lead.id}`}>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                              <TypeBadge type={lead.leadType} />
                              <StatusBadge status={lead.status} />
                              {lead.attemptCount > 0 && <span className="text-xs text-muted-foreground">{lead.attemptCount}×</span>}
                            </div>
                            <p className="text-sm font-medium text-foreground truncate">{lead.ownerName || "—"}</p>
                            <p className="text-xs text-muted-foreground truncate flex items-center gap-1"><MapPin size={9}/>{lead.address}</p>
                          </div>
                          <div className="hidden md:flex flex-col items-end gap-0.5 text-xs shrink-0">
                            {lead.phone && <span className="text-white/50 flex items-center gap-1"><Phone size={10}/>{lead.phone}</span>}
                            {lead.assignedAgentName && <span className="text-muted-foreground">{lead.assignedAgentName}</span>}
                            {lead.callbackDate && <span style={{ color: "#67e8f9" }}>CB: {lead.callbackDate}</span>}
                          </div>
                        </div>
                      ))}
                    {(pipeline?.leads || []).filter((l: any) => ["unassigned","assigned","no_answer","keep_in_touch","callback_requested"].includes(l.status)).length === 0 && (
                      <div style={{
                        padding: "32px 20px", textAlign: "center",
                        border: "1px dashed rgba(200,170,90,0.1)",
                        borderRadius: 12, color: "rgba(255,255,255,0.3)", fontSize: 13,
                      }}>
                        No active leads in queue. Upload a CSV to populate the pipeline.
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </TabsContent>

          {/* ── ALL LEADS ───────────────────────────────────────────────────── */}
          <TabsContent value="leads" className="mt-5 space-y-3">
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
              <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["/api/admin/pipeline"] })} className="gap-1 text-xs border-border">
                <RefreshCw size={11}/> Refresh
              </Button>
              <span className="text-xs text-muted-foreground">{filteredLeads.length} leads</span>
            </div>

            {pipelineLoading ? (
              <div className="space-y-2">{Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
            ) : filteredLeads.length === 0 ? (
              <div style={{
                padding: "48px 20px", textAlign: "center",
                border: "1px dashed rgba(200,170,90,0.1)",
                borderRadius: 12, color: "rgba(255,255,255,0.3)", fontSize: 13,
              }}>
                No leads found.
              </div>
            ) : (
              <div className="space-y-1.5">
                {filteredLeads.map((lead: any) => (
                  <div
                    key={lead.id}
                    style={{
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(255,255,255,0.07)",
                      borderRadius: 8, padding: "12px 16px",
                      display: "flex", alignItems: "center", gap: 12,
                      cursor: "pointer",
                      transition: "border-color 0.15s",
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
                        {lead.attemptCount > 0 && <span className="text-xs text-muted-foreground">{lead.attemptCount} attempt{lead.attemptCount !== 1 ? "s" : ""}</span>}
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
          </TabsContent>

          {/* ── LEAD MODAL ──────────────────────────────────────────────────── */}
          {selectedLead && (() => {
            const lead = selectedLead;
            const extra = (() => { try { return JSON.parse(lead.extraData || "{}"); } catch { return {}; } })();
            const zillow = lead.address
              ? `https://www.zillow.com/homes/${encodeURIComponent(lead.address + (extra.city ? ", " + extra.city : ""))}_rb/`
              : null;
            const subject = encodeURIComponent(`Regarding your property at ${lead.address}`);
            const body = encodeURIComponent(`Hi ${lead.ownerName || "there"},\n\nI wanted to reach out about your property at ${lead.address}. I specialize in helping homeowners in your area and I'd love to connect.\n\nWould you be available for a quick call?\n\nBest,\nBrothers Group Real Estate at Momentum Realty`);
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
                      <div className="flex items-center gap-2 mb-1.5">
                        <TypeBadge type={lead.leadType} />
                        <StatusBadge status={lead.status} />
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
                    {lead.phone && <div className="flex items-center gap-2"><Phone size={13} className="text-muted-foreground"/><span className="text-foreground">{lead.phone}</span></div>}
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
                      { key: "distressed", label: "Distressed" },
                      { key: "website_lead", label: "Website Lead" },
                      { key: "fsbo", label: "FSBO" },
                      { key: "land", label: "Land" },
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

                {uploadType === "website_lead" ? (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">Enter the details from the MotivatedSellers.com email. The lead will be assigned to the next agent in rotation.</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">First Name *</Label><Input value={websiteLeadForm.firstName} onChange={e => setWebsiteLeadForm(p => ({...p, firstName: e.target.value}))} className="bg-secondary border-border" placeholder="Brad" data-testid="input-wl-first-name" /></div>
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">Last Name *</Label><Input value={websiteLeadForm.lastName} onChange={e => setWebsiteLeadForm(p => ({...p, lastName: e.target.value}))} className="bg-secondary border-border" placeholder="Wintch" data-testid="input-wl-last-name" /></div>
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">Phone *</Label><Input value={websiteLeadForm.phone} onChange={e => setWebsiteLeadForm(p => ({...p, phone: e.target.value}))} className="bg-secondary border-border" placeholder="7028840784" data-testid="input-wl-phone" /></div>
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">Email</Label><Input value={websiteLeadForm.email} onChange={e => setWebsiteLeadForm(p => ({...p, email: e.target.value}))} className="bg-secondary border-border" placeholder="brad@gmail.com" data-testid="input-wl-email" /></div>
                    </div>
                    <div className="space-y-1"><Label className="text-xs text-foreground/70">Property Address *</Label><Input value={websiteLeadForm.address} onChange={e => setWebsiteLeadForm(p => ({...p, address: e.target.value}))} className="bg-secondary border-border" placeholder="77019 Hardwood Ct" data-testid="input-wl-address" /></div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">City</Label><Input value={websiteLeadForm.city} onChange={e => setWebsiteLeadForm(p => ({...p, city: e.target.value}))} className="bg-secondary border-border" placeholder="Yulee" data-testid="input-wl-city" /></div>
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">State</Label><Input value={websiteLeadForm.state} onChange={e => setWebsiteLeadForm(p => ({...p, state: e.target.value}))} className="bg-secondary border-border" placeholder="FL" data-testid="input-wl-state" /></div>
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">Zip</Label><Input value={websiteLeadForm.zip} onChange={e => setWebsiteLeadForm(p => ({...p, zip: e.target.value}))} className="bg-secondary border-border" placeholder="32097" data-testid="input-wl-zip" /></div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">County</Label><Input value={websiteLeadForm.county} onChange={e => setWebsiteLeadForm(p => ({...p, county: e.target.value}))} className="bg-secondary border-border" placeholder="NASSAU" data-testid="input-wl-county" /></div>
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">Property Type</Label><Input value={websiteLeadForm.propertyType} onChange={e => setWebsiteLeadForm(p => ({...p, propertyType: e.target.value}))} className="bg-secondary border-border" placeholder="Single Family" data-testid="input-wl-property-type" /></div>
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">Estimated Value</Label><Input value={websiteLeadForm.estimatedValue} onChange={e => setWebsiteLeadForm(p => ({...p, estimatedValue: e.target.value}))} className="bg-secondary border-border" placeholder="413500" data-testid="input-wl-value" /></div>
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">Timeframe</Label><Input value={websiteLeadForm.timeframe} onChange={e => setWebsiteLeadForm(p => ({...p, timeframe: e.target.value}))} className="bg-secondary border-border" placeholder="1-3 months" data-testid="input-wl-timeframe" /></div>
                    </div>
                    <div className="space-y-1"><Label className="text-xs text-foreground/70">Reason for Selling</Label><Input value={websiteLeadForm.reasonForSelling} onChange={e => setWebsiteLeadForm(p => ({...p, reasonForSelling: e.target.value}))} className="bg-secondary border-border" placeholder="Enter reason for selling…" data-testid="input-wl-reason" /></div>
                    <button
                      onClick={handleSubmitWebsiteLead}
                      disabled={submittingWebsiteLead}
                      style={{
                        width: "100%", padding: "14px",
                        background: submittingWebsiteLead ? "rgba(200,170,90,0.3)" : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                        border: "none", borderRadius: 6,
                        fontSize: 12, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase",
                        color: "#080808", cursor: submittingWebsiteLead ? "not-allowed" : "pointer",
                      }}
                      data-testid="button-submit-website-lead"
                    >
                      {submittingWebsiteLead ? "Submitting…" : "Add Website Lead & Assign"}
                    </button>
                  </div>
                ) : (
                  <>
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
                          {uploading ? "Uploading…" : dragOver ? "Drop CSV here" : "Click or drag a CSV file here"}
                        </p>
                        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 4 }}>
                          Expected columns: Address, Owner Name, Phone, Email, Motivation
                        </p>
                      </div>
                      <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} data-testid="input-csv-file" />
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
                  </>
                )}
              </div>
            </div>
          </TabsContent>

          {/* ── AGENTS ──────────────────────────────────────────────────────── */}
          <TabsContent value="agents" className="mt-5 space-y-5">

            {/* Queue Management */}
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

            {/* Admin as Agent */}
            <div style={{
              background: "linear-gradient(135deg,#0f0f0f 0%,#0a0a0a 100%)",
              border: "1px solid rgba(200,170,90,0.1)",
              borderRadius: 12, padding: 16,
            }}>
              <div className="flex items-center gap-2 mb-3">
                <UserCheck size={14} style={{ color: "rgba(200,170,90,0.7)" }} />
                <h3 className="text-sm font-semibold text-foreground">Admin Lead Receiving</h3>
                <span className="text-xs text-muted-foreground">— toggle to join the round-robin for all lead types</span>
              </div>
              {agents.filter(a => a.role === "admin").map((admin) => (
                <div key={admin.id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 8, padding: "10px 16px",
                }}>
                  <div>
                    <p className="text-sm font-medium text-foreground">{admin.name}</p>
                    <p className="text-xs text-muted-foreground">{admin.email}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[10px] text-muted-foreground">All Leads</span>
                      <LuxToggle
                        on={!!admin.receiveLeads}
                        onToggle={() => toggleReceiveLeadsMutation.mutate({ id: admin.id, receiveLeads: !admin.receiveLeads })}
                        testId={`toggle-receive-leads-${admin.id}`}
                      />
                    </div>
                    <Badge variant="outline" className={`text-xs ${admin.receiveLeads ? "text-green-400 border-green-400/30" : "text-muted-foreground border-border"}`}>
                      {admin.receiveLeads ? "Active" : "Off"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>

            {/* Active + Inactive Agents */}
            {(() => {
              const allRoleAgents = agents.filter(a => a.role === "agent");
              const activeAgents = allRoleAgents.filter(a => a.isActive);
              const flowOn = activeAgents.filter(a => a.leadFlowOn !== false);
              const flowOff = activeAgents.filter(a => a.leadFlowOn === false);
              const sortedActive = [...flowOn, ...flowOff];
              const inactiveAgents = allRoleAgents.filter(a => !a.isActive);
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
                        <p className="text-xs text-muted-foreground mt-0.5">Round-robin: top → bottom. Flow off = Inactive (removed from rotation &amp; leaderboard).</p>
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
                              onClick={() => createAgentMutation.mutate({ name: newAgent.name, email: newAgent.email })}
                              disabled={createAgentMutation.isPending || !newAgent.name || !newAgent.email}
                              data-testid="button-save-agent"
                            >
                              {createAgentMutation.isPending ? "Sending invite…" : "Send Invitation"}
                            </button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>

                    <div className="space-y-2">
                      {sortedActive.map((agent, idx) => {
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
                            <div style={{
                              width: 28, height: 28, borderRadius: "50%",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              border: `1px solid ${flowActive ? "rgba(200,170,90,0.25)" : "rgba(255,255,255,0.08)"}`,
                              background: flowActive ? "rgba(200,170,90,0.06)" : "rgba(255,255,255,0.03)",
                              flexShrink: 0,
                            }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: flowActive ? "#c8aa5a" : "rgba(255,255,255,0.3)" }}>{idx + 1}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground">{agent.name}</p>
                              <p className="text-xs text-muted-foreground">{agent.email}</p>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="flex flex-col items-center gap-0.5">
                                <span className="text-[10px] text-muted-foreground">Flow</span>
                                <LuxToggle
                                  on={flowActive}
                                  onToggle={() => toggleLeadFlowMutation.mutate({ id: agent.id, leadFlowOn: !agent.leadFlowOn })}
                                  testId={`toggle-lead-flow-${agent.id}`}
                                />
                              </div>
                              <div className="flex flex-col items-center gap-0.5">
                                <span className="text-[10px] text-muted-foreground">Website</span>
                                <LuxToggle
                                  on={!!agent.receiveWebsiteLeads && flowActive}
                                  onToggle={() => {
                                    if (!flowActive) return;
                                    toggleWebsiteLeadsMutation.mutate({ id: agent.id, receiveWebsiteLeads: !agent.receiveWebsiteLeads });
                                  }}
                                  disabled={!flowActive}
                                  testId={`toggle-website-leads-${agent.id}`}
                                  activeColor="rgba(59,130,246,0.2)"
                                  activeDot="#93c5fd"
                                />
                              </div>
                              <Badge variant="outline" className={`text-xs ${flowActive ? "text-green-400 border-green-400/30" : "text-red-400 border-red-400/30"}`}>
                                {flowActive ? "Active" : "Inactive"}
                              </Badge>
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={() => openConfirm({
                                  title: `Deactivate ${agent.name}?`,
                                  message: `${agent.name} will be moved to Inactive Agents. All leads in their queue will be returned to the pool for redistribution. This cannot be undone without manually reactivating them.`,
                                  confirmLabel: "Deactivate",
                                  confirmColor: "#ef4444",
                                  onConfirm: () => { closeConfirm(); deleteAgentMutation.mutate(agent.id); },
                                })}
                                title="Move to Inactive Agents"
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
                          No active agents yet. Add one above.
                        </div>
                      )}
                    </div>
                  </div>

                  {inactiveAgents.length > 0 && (
                    <div className="space-y-3">
                      <div>
                        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.1rem", fontWeight: 300, color: "rgba(255,255,255,0.4)" }}>
                          Inactive Agents
                        </h2>
                        <p className="text-xs text-muted-foreground">Removed from rotation. Re-activate to bring them back.</p>
                      </div>
                      <div className="space-y-2">
                        {inactiveAgents.map((agent) => (
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
                            <div style={{
                              width: 28, height: 28, borderRadius: "50%",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              border: "1px solid rgba(255,255,255,0.06)",
                              background: "rgba(255,255,255,0.02)",
                              flexShrink: 0,
                            }}>
                              <span className="text-xs text-muted-foreground">—</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground/70">{agent.name}</p>
                              <p className="text-xs text-muted-foreground">{agent.email}</p>
                            </div>
                            <div className="flex items-center gap-3">
                              <Badge variant="outline" className="text-xs text-red-400 border-red-400/30">Inactive</Badge>
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 text-xs border-green-500/40 text-green-400 hover:bg-green-500/10"
                                onClick={() => reactivateAgentMutation.mutate(agent.id)}
                                disabled={reactivateAgentMutation.isPending}
                                data-testid={`button-reactivate-agent-${agent.id}`}
                              >
                                <Power size={11}/> Re-activate
                              </Button>
                            </div>
                          </div>
                        ))}
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

      {/* Live Activity Feed drawer */}
      <ActivityFeed open={feedOpen} onClose={() => setFeedOpen(false)} wsRef={wsRef} />
    </div>
  );
}
