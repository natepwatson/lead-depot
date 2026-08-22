import React, { useState, useRef, useCallback, useEffect } from "react";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import ActivityFeed from "../components/ld/ActivityFeed";
import { RankTrophy } from "../components/ld/RankTrophy";
import { StreakBadge, ChampionFrame } from "../components/ld/StreakBadge";
import { ListingsPanel } from "../components/ld/ListingsPanel";
// v20.6.8 — WeeklyWorkbookPanel removed; FUB is source of truth. Keeping import commented for git history.
// import { WeeklyWorkbookPanel } from "../components/ld/WeeklyWorkbookPanel";
import { FubTagConfigPanel } from "../components/ld/FubTagConfigPanel";
import { RepairPricingVendorPanel } from "../components/ld/RepairPricingVendorPanel";
import { OpenHouseSchedulePanel } from "../components/ld/OpenHouseSchedulePanel";
import { PendingOpenHousesPanel } from "../components/ld/PendingOpenHousesPanel";
import ProfilePage from "./ProfilePage";
import ScriptEditor from "../components/ScriptEditor";
// v20.4.2 — old admin Territory Map removed. Team map now lives in AgentView.
// import MapView from "./MapView";
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
  UserPlus, UserCircle2, KeyRound, RotateCcw,
  Sparkles, Database, Wrench, FileText, PlayCircle, Home, CalendarDays,
  ClipboardList
} from "lucide-react";
import type { Lead, Agent } from "@shared/schema";
// v14.49 — reuse the agent's "Who called me?" modal on the admin dashboard.
import { CallbackLookupModal, TeamPotCard } from "./AgentView";

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

// v15.11.39 — Live On Air widget for the admin dashboard. Shows WHO is dialing
// right now by name, headshot, dial count, and last-activity relative time.
// Refetches every 15 seconds. Renders a green pulsing indicator when ≥ 1 agent
// is live, muted gray + "Quiet" copy when nobody has logged an outcome in the
// last 10 minutes. Alex asked for desktop visibility — the phone-side pill in
// AgentView never made it to the admin console.
//
// v20.7.23 — LiveOnAirChip: compact 34px-tall toolbar variant that just shows
// the count with the same green pulse dot as the full widget. Used in the admin
// header row where the full widget would break the layout. Clicking it toggles
// the full drawer below (setLiveOnAirOpen). Same data source — shares the
// react-query cache with LiveOnAirWidget so no double-polling.
function LiveOnAirChip({ onClick }: { onClick?: () => void }) {
  const { data } = useQuery<{ agents: any[]; count: number; windowMinutes: number }>({
    queryKey: ["/api/agents/live-agents"],
    queryFn: () => apiRequest("GET", "/api/agents/live-agents").then(r => r.json()),
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    staleTime: 5000,
  });
  const count = data?.count || 0;
  const isLive = count > 0;
  return (
    <button
      onClick={onClick}
      title={isLive ? `${count} agent${count === 1 ? "" : "s"} dialing now (last 10 min)` : "Nobody dialing (last 10 min)"}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        height: 34, padding: "0 10px", borderRadius: 8,
        background: isLive ? "rgba(34,197,94,0.10)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${isLive ? "rgba(34,197,94,0.30)" : "rgba(255,255,255,0.10)"}`,
        cursor: onClick ? "pointer" : "default",
        flexShrink: 0, whiteSpace: "nowrap",
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: "50%",
        background: isLive ? "#4ade80" : "rgba(255,255,255,0.25)",
        boxShadow: isLive ? "0 0 6px rgba(74,222,128,0.7)" : "none",
        animation: isLive ? "livePulseChip 1.8s ease-in-out infinite" : "none",
        flexShrink: 0,
      }} />
      <span style={{
        fontSize: 11, fontWeight: 600, letterSpacing: "0.06em",
        color: isLive ? "rgba(134,239,172,0.95)" : "rgba(255,255,255,0.45)",
      }}>
        {isLive ? `${count} On Air` : "Quiet"}
      </span>
      <style>{`@keyframes livePulseChip { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } }`}</style>
    </button>
  );
}

function LiveOnAirWidget() {
  const { data } = useQuery<{ agents: Array<{ id: number; name: string; headshotUrl: string | null; dials: number; lastActivityAt: string }>; count: number; windowMinutes: number }>({
    queryKey: ["/api/agents/live-agents"],
    queryFn: () => apiRequest("GET", "/api/agents/live-agents").then(r => r.json()),
    refetchInterval: 30000, // v19.5 — halved poll rate (WS covers activity events)
    refetchOnWindowFocus: true,
    staleTime: 5000,
  });
  const agents = data?.agents || [];
  const count = data?.count || 0;
  const isLive = count > 0;

  function agoMin(iso: string) {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return "just now";
    if (m === 1) return "1m ago";
    return `${m}m ago`;
  }

  return (
    <div style={{
      background: isLive
        ? "linear-gradient(135deg, rgba(34,197,94,0.08) 0%, rgba(10,9,8,0.6) 60%)"
        : "linear-gradient(135deg, #0f0f0f 0%, #0a0a0a 100%)",
      border: `1px solid ${isLive ? "rgba(34,197,94,0.28)" : "rgba(200,170,90,0.1)"}`,
      borderRadius: 12,
      padding: "14px 16px",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: agents.length > 0 ? 12 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: isLive ? "#4ade80" : "rgba(255,255,255,0.2)",
            boxShadow: isLive ? "0 0 8px rgba(74,222,128,0.7)" : "none",
            animation: isLive ? "livePulse 1.8s ease-in-out infinite" : "none",
          }} />
          <span style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: isLive ? "rgba(134,239,172,0.9)" : "rgba(255,255,255,0.35)", fontWeight: 600 }}>
            {isLive ? `${count} On Air · Live` : "Quiet — nobody dialing"}
          </span>
        </div>
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>last 10 min</span>
      </div>
      {agents.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
          {agents.map(a => (
            <div key={a.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 10px",
              background: "rgba(200,170,90,0.05)",
              border: "1px solid rgba(200,170,90,0.14)",
              borderRadius: 8,
            }}>
              {a.headshotUrl ? (
                <img src={a.headshotUrl} alt="" style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover", border: "1px solid rgba(74,222,128,0.5)" }} />
              ) : (
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(200,170,90,0.2)", border: "1px solid rgba(74,222,128,0.5)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: "#c8aa5a" }}>
                  {(a.name || "?").split(" ").map(w => w[0]).slice(0, 2).join("")}
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, color: "#fff", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.name}
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginTop: 1 }}>
                  {a.dials} dial{a.dials === 1 ? "" : "s"} · {agoMin(a.lastActivityAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <style>{`@keyframes livePulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(1.15); } }`}</style>
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
    refetchInterval: 30000, // v19.5 — modal-scoped, WS covers new activity
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

// v20.4.9 — HealthWidget rebuilt: green-light service checks + live terminal feed.
// The terminal subscribes to the existing /ws hub and prints events like a
// small tail -f. No new API surface — pure client wiring on top of the same
// broadcasts the app already emits (outcomes, pulls, uploads, seats).
function HealthWidget() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, refetch } = useQuery<HealthData>({
    queryKey: ["/api/health"],
    queryFn: () => fetch("/api/health").then(r => r.json()),
    refetchInterval: 60_000, // poll every 60 seconds
    staleTime: 50_000,
  });

  // Rolling terminal feed — last 40 WS events, newest at bottom.
  const [feed, setFeed] = useState<Array<{ t: number; type: string; note?: string }>>([]);
  useEffect(() => {
    if (!open) return; // only subscribe while panel is open, to keep this cheap
    let ws: WebSocket | null = null;
    let cancelled = false;
    const connect = () => {
      if (cancelled) return;
      try {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
        ws.onmessage = (ev) => {
          try {
            const j = JSON.parse(ev.data);
            const type = j.type || j.event || "message";
            let note: string | undefined;
            if (j.leadId) note = `lead #${j.leadId}`;
            else if (j.agentName) note = j.agentName;
            else if (j.name) note = j.name;
            else if (j.count !== undefined) note = `n=${j.count}`;
            setFeed(prev => {
              const next = [...prev, { t: Date.now(), type, note }];
              return next.length > 40 ? next.slice(-40) : next;
            });
          } catch { /* ignore non-json frames */ }
        };
        ws.onclose = () => { if (!cancelled) setTimeout(connect, 3000); };
        ws.onerror = () => ws?.close();
      } catch { /* ignore */ }
    };
    connect();
    return () => { cancelled = true; ws?.close(); };
  }, [open]);

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
          width: 340, zIndex: 200,
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

          {/* Live terminal feed — last WS events, newest at bottom. */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", background: "#050403" }}>
            <div style={{
              padding: "6px 12px", display: "flex", justifyContent: "space-between", alignItems: "center",
              borderBottom: "1px solid rgba(255,255,255,0.04)",
            }}>
              <span style={{ fontSize: 9, letterSpacing: "0.18em", fontWeight: 700, textTransform: "uppercase", color: "rgba(74,222,128,0.75)" }}>
                Live Feed
              </span>
              <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "ui-monospace, monospace" }}>{feed.length} events</span>
            </div>
            <div
              ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
              style={{
                maxHeight: 160, overflowY: "auto", padding: "6px 12px",
                fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
                fontSize: 10.5, lineHeight: 1.5, color: "#4ade80",
              }}
            >
              {feed.length === 0 ? (
                <span style={{ color: "rgba(255,255,255,0.25)" }}>— waiting for events —</span>
              ) : feed.map((e, i) => {
                const d = new Date(e.t);
                const ts = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
                return (
                  <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <span style={{ color: "rgba(255,255,255,0.35)" }}>{ts}</span>{" "}
                    <span style={{ color: "#fde047" }}>{e.type}</span>{e.note ? <span style={{ color: "rgba(255,255,255,0.6)" }}>{" · " + e.note}</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// v17.5 — TeamPotStretchAdmin REMOVED per Alex. The $1000/80-appt tier is now
// permanently visible to the team; no toggle. Below shell retained as a no-op
// stub to keep any lingering render sites compiling.
function _RemovedInV17_2_TeamPotStretchAdmin() { return null as unknown as JSX.Element; }
function _WasTeamPotStretchAdmin_v17_2_removed() {
  const qc = useQueryClient();
  const { data: pot } = useQuery<any>({
    queryKey: ["/api/team-pot"],
    queryFn: () => apiRequest("GET", "/api/team-pot").then(r => r.json()),
    refetchInterval: 60000, // v19.5 — money pool changes slowly
  });
  const [busy, setBusy] = React.useState(false);
  const revealed = !!pot?.stretchRevealed;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest("POST", "/api/admin/team-pot/stretch", { revealed: !revealed });
      await qc.invalidateQueries({ queryKey: ["/api/team-pot"] });
    } catch (e) {
      console.error("[stretch-toggle] error", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
      margin: "0 16px", padding: "10px 14px",
      borderRadius: 12,
      background: "rgba(255,255,255,0.03)",
      border: "1px dashed rgba(200,170,90,0.35)",
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.18em", color: "#c8aa5a", textTransform: "uppercase", fontWeight: 700 }}>
          Admin only · secret stretch tier
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.75)", lineHeight: 1.4 }}>
          Reveal <span style={{ color: "#fde047", fontWeight: 700 }}>$1000</span> at 80 team appointments. Currently <b style={{ color: revealed ? "#4ade80" : "rgba(255,255,255,0.55)" }}>{revealed ? "revealed to team" : "hidden"}</b>.
        </div>
      </div>
      <button
        onClick={toggle}
        disabled={busy}
        style={{
          flexShrink: 0,
          padding: "8px 14px", borderRadius: 8, cursor: busy ? "wait" : "pointer",
          fontSize: 11, letterSpacing: "0.10em", textTransform: "uppercase", fontWeight: 700,
          border: `1px solid ${revealed ? "rgba(74,222,128,0.55)" : "rgba(200,170,90,0.55)"}`,
          background: revealed ? "rgba(74,222,128,0.14)" : "rgba(200,170,90,0.12)",
          color: revealed ? "#4ade80" : "#fde047",
          transition: "all 200ms ease",
        }}
      >
        {busy ? "…" : revealed ? "Hide stretch" : "Reveal stretch"}
      </button>
    </div>
  );
}

export default function AdminDashboard({
  onWorkMyLeads,
  onOpenAgentTab,
  onCloseAdmin,
}: {
  onWorkMyLeads?: () => void;
  // v14.51 — admin bottom nav jumps into AgentView on a specific tab.
  onOpenAgentTab?: (tab: "leads" | "refer" | "leaderboard" | "profile" | "pipeline") => void;
  // v18.4 — UNIFIED SHELL close button. When set, renders a back-pill in the
  // top bar and any Work My Leads / Open Agent Tab actions dismiss the admin
  // takeover instead of navigating internally.
  onCloseAdmin?: () => void;
} = {}) {
  const { user, logout } = useAuth();
  useRealtimeUpdates();
  const { toast } = useToast();
  const qc = useQueryClient();

  // v20.4.9 — Listen for FUB seat overage broadcasts and toast the admin.
  // Event is dispatched by useRealtimeUpdates when the server broadcasts
  // fub_seat_overage after an approve that pushed us past 10 included seats.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as {
        candidateName?: string;
        seatsUsed?: number;
        includedSeats?: number;
        overageCostPerSeat?: number;
      };
      const name = detail?.candidateName || "New agent";
      const cost = detail?.overageCostPerSeat ?? 49;
      const used = detail?.seatsUsed;
      const included = detail?.includedSeats;
      toast({
        title: `FUB seat overage triggered — +$${cost}/mo`,
        description: `${name}'s seat brought us to ${used ?? "?"}/${included ?? "?"}. Next FUB invoice will include the extra seat.`,
        duration: 12000,
      });
    };
    window.addEventListener("ld:fub_seat_overage", handler);
    return () => window.removeEventListener("ld:fub_seat_overage", handler);
  }, [toast]);
  // v14.50 — pull-to-refresh site-wide.
  // v14.53 — destructure indicator so the pull gesture has visible feedback (gold chip at top)
  const { indicator: ptrIndicator } = usePullToRefresh(() => qc.invalidateQueries());
  const fileRef = useRef<HTMLInputElement>(null);
  // Activity Feed
  const [feedOpen, setFeedOpen] = useState(false);
  // v14.51 — Admin tabs now controlled so the bottom nav can activate them.
  const [adminTab, setAdminTab] = useState<string>("approvals"); // v18.4 — admin panel is tools-only; leaderboard tab removed
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
  // v18.0 — Recruiting/Candidate system removed. Lead Depot is seller-only.
  const [newAgent, setNewAgent] = useState({ name: "", email: "", role: "agent" });
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<any | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [intentFilter, setIntentFilter] = useState("all"); // v15.3
  // v20.7.53 — Admin can filter the pipeline view (tiles + paginated table)
  // by owning agent. "all" = every agent. Stored as string so the <Select>
  // can bind cleanly; parseInt at the fetch site.
  const [pipelineAgentFilter, setPipelineAgentFilter] = useState<string>("all");
  const [drilldownAgent, setDrilldownAgent] = useState<{ id: number; name: string } | null>(null);

  // Paginated leads state (v11.70)
  const [leadsPage, setLeadsPage] = useState(0);
  const LEADS_PAGE_SIZE = 50;
  const [lbHistoryOpen, setLbHistoryOpen] = useState(false);

  // Data queries
  const { data: stats } = useQuery({
    queryKey: ["/api/leads/stats"],
    queryFn: () => apiRequest("GET", "/api/leads/stats").then(r => r.json()),
    refetchInterval: 45000, // v19.5 — big aggregate, WS invalidates on real change
  });

  const { data: agentStats = [], isLoading: agentStatsLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/agent-stats"],
    queryFn: () => apiRequest("GET", "/api/admin/agent-stats").then(r => r.json()),
    refetchInterval: 30000, // v19.5 — WS invalidates on outcome log
  });

  // v16.7 — added "monthly" tab. Server now returns a .monthly block on each row.
  const [lbTab, setLbTab] = useState<"today" | "weekly" | "monthly">("today");

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
    // v20.7.53 — Include agent filter in key so React Query refetches when Alex
    // switches which agent's pipeline he's viewing.
    queryKey: ["/api/admin/pipeline", pipelineAgentFilter],
    queryFn: () => {
      const qs = pipelineAgentFilter !== "all" ? `?agentId=${pipelineAgentFilter}` : "";
      return apiRequest("GET", `/api/admin/pipeline${qs}`).then(r => r.json());
    },
    refetchInterval: 30000, // v19.5 — WS invalidates on outcome log
  });

  // Paginated lead list query (v11.70) — replaces full pipeline load for Lead Pool tab
  const paginatedLeadsQuery = useQuery<any>({
    queryKey: ["/api/leads/paginated", statusFilter, intentFilter, searchTerm, leadsPage, pipelineAgentFilter],
    queryFn: () => {
      const params = new URLSearchParams({
        limit: String(LEADS_PAGE_SIZE),
        offset: String(leadsPage * LEADS_PAGE_SIZE),
        status: statusFilter,
        intent: intentFilter,
        ...(searchTerm ? { search: searchTerm } : {}),
        // v20.7.53 — Admin agent filter. Server already supports ?agentId=.
        ...(pipelineAgentFilter !== "all" ? { agentId: pipelineAgentFilter } : {}),
      });
      return apiRequest("GET", `/api/leads/paginated?${params}`).then(r => r.json());
    },
    placeholderData: keepPreviousData,
  });

  // Reset to page 0 when filters change
  const prevStatusFilter = useRef(statusFilter);
  const prevIntentFilter = useRef(intentFilter);
  const prevSearchTerm = useRef(searchTerm);
  useEffect(() => {
    if (
      prevStatusFilter.current !== statusFilter ||
      prevIntentFilter.current !== intentFilter ||
      prevSearchTerm.current !== searchTerm
    ) {
      setLeadsPage(0);
      prevStatusFilter.current = statusFilter;
      prevIntentFilter.current = intentFilter;
      prevSearchTerm.current = searchTerm;
    }
  }, [statusFilter, intentFilter, searchTerm]);

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
  const [hardResetOpen, setHardResetOpen] = useState<null | "seller">(null);
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
  // v18.0 — Recruiting pipeline (DBPR fetch) removed with rest of recruiting system.
  const runHardReset = async () => {
    if (!hardResetOpen || hardResetInput !== "RESET" || hardResetBusy) return;
    setHardResetBusy(true);
    const side = hardResetOpen;
    try {
      const url = "/api/admin/seller-hard-reset";
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
        title: `Seller depot cleared`,
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

  // v15.11.26 — Admin-set password. Admins (Alex/Nate) type the new password directly;
  // hits force-reset endpoint with X-Ingest-Secret. This is now the primary way any
  // agent password gets rotated — agents themselves no longer see Change Password.
  const [setPasswordAgent, setSetPasswordAgent] = useState<{ id: number; name: string; email: string } | null>(null);
  const [setPasswordValue, setSetPasswordValue] = useState("");
  const [setPasswordSaving, setSetPasswordSaving] = useState(false);
  const submitSetPassword = async () => {
    if (!setPasswordAgent) return;
    const pw = setPasswordValue.trim();
    if (pw.length < 8) {
      toast({ title: "Password must be at least 8 characters", variant: "destructive" });
      return;
    }
    setSetPasswordSaving(true);
    try {
      const r = await fetch(`/api/admin/agents/${setPasswordAgent.id}/set-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast({ title: `Password set for ${setPasswordAgent.name}`, description: `They now log in with the new password. All existing sessions were revoked.` });
      setSetPasswordAgent(null);
      setSetPasswordValue("");
    } catch (err: any) {
      toast({ title: "Set password failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setSetPasswordSaving(false);
    }
  };

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

  // v15.11.39 — Reset an agent's daily skip quota. Alex request 7/22:
  // "agents will click skip and they only have three. Then it’s blocked.
  // I need to be able to clear them To reset." Server rewrites today's
  // 'skipped' activity rows to 'skip_cleared_by_admin' (audit-preserving)
  // and drops any per-agent day-long lead holdouts they collected.
  const resetSkipsMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/agents/${id}/reset-skips`, {}).then(async r => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to reset skips");
      return j;
    }),
    onSuccess: (data: any) => {
      const cleared = data?.cleared ?? 0;
      const held    = data?.holdoutsReleased ?? 0;
      toast({
        title: `Skips reset for ${data.agentName}`,
        description: cleared === 0 && held === 0
          ? "No skips were used today — nothing to clear."
          : `Cleared ${cleared} skip${cleared === 1 ? "" : "s"} and released ${held} held-out lead${held === 1 ? "" : "s"}. They're back at ${data.after?.remaining ?? 3}/${data.after?.cap ?? 3}.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Reset failed", description: err?.message || "Could not reset skips", variant: "destructive" });
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
    refetchInterval: 60000, // v19.5 — settings flag rarely changes
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

  // v18.0 — Agent Lead Handlers removed with rest of recruiting system.

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
          {/* v18.4 — UNIFIED SHELL back button. When mounted as a takeover from
              AgentView, tapping this returns the admin to the shared dashboard. */}
          {onCloseAdmin && (
            <button onClick={onCloseAdmin} style={{
              display: "flex", alignItems: "center", gap: 5,
              fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", fontWeight: 700,
              color: "#c8aa5a",
              background: "rgba(200,170,90,0.10)", border: "1px solid rgba(200,170,90,0.30)",
              borderRadius: 8, padding: "6px 9px", cursor: "pointer",
            }}>
              ‹ Back
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
              {user?.name} — Admin
            </p>
            <p style={{ fontSize: 9, color: "rgba(200,170,90,0.45)", letterSpacing: "0.14em", textTransform: "uppercase", lineHeight: 1, marginTop: 3, fontWeight: 600 }}>
              v20.32.3
            </p>
          </div>
        </div>
        {/* v20.7.23 — flexWrap on the toolbar so the sign-out button never falls
             off screen on narrower viewports. Previously the row was a single-line
             flex with health → live chip → feed → Work My Leads → Who called me? →
             Sign Out, and on 1024–768px widths (iPad landscape, small laptops) the
             sign-out button pushed past the viewport. Wrapping lets it drop to a
             second row instead of vanishing. justifyContent flex-end keeps the
             wrapped items right-aligned to match the container. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {/* Connectivity Health Widget */}
          <HealthWidget />
          {/* v20.7.23 — Restored the live dialers indicator in the admin header.
               The full LiveOnAirWidget panel is defined but never rendered anywhere;
               the toolbar chip variant surfaces the count + pulse in the header where
               Alex expects it. */}
          <LiveOnAirChip />
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
              // v20.4.2 — removed "Map View" (old admin territory map) and "Diversity"
              // (now a challenge, not a standalone tab). Team map lives in the
              // agent surface (AgentView → Leaderboard → Map toggle).
              { value: "admin",       icon: Shield,      label: "Admin" },
              { value: "leads",       icon: List,        label: "Lead Pool" },
              { value: "reports",     icon: BarChart2,   label: "Reports" },
              { value: "kpi",         icon: TrendingUp,  label: "KPI" },
              { value: "approvals",   icon: CheckCircle2, label: "Approvals" },
              { value: "candidates",  icon: UserPlus,    label: "Candidates" },
              // v20.7.53 — DB Health, Newsletter, and Open Houses tabs removed
              // from the admin bar per Alex 8/18. Their tab content is still
              // wired up below in case they need to be re-enabled later, but
              // they're not reachable from the admin nav.
              { value: "upload",      icon: Upload,      label: "Upload CSV" },
              { value: "masterlist",  icon: ClipboardList, label: "Master List" },
              { value: "agents",      icon: Users,       label: "Agents" },
              { value: "scripts",     icon: ScrollText,  label: "Scripts" },
              { value: "repairs",     icon: Wrench,      label: "Repair Program" },
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

            {/* Seller Depot admin toolbar: Hard Reset, Territory management */}
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


          {/* ── ALL LEADS ───────────────────────────────────────────────────── */}
          <TabsContent value="leads" className="mt-5 space-y-3">
            {/* v14.81.2 — Pipeline tab deleted; its 8 stage tiles now live here at the
               top of Lead Pool, plus an "All" tile as a 9th at the front. Tapping a
               tile drives the SAME statusFilter state used by the paginated table
               below (and by the Status dropdown), so the two stay in sync either way. */}
            <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
              <div className="flex items-center gap-2">
                <Layers size={13} style={{ color: "rgba(200,170,90,0.7)" }} />
                <p style={{
                  fontFamily: "'Cormorant Garamond','Georgia',serif",
                  fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase",
                  color: "rgba(200,170,90,0.6)", fontWeight: 600,
                }}>
                  Pipeline Funnel
                  {pipelineAgentFilter !== "all" && (
                    <span style={{ marginLeft: 8, color: "#c8aa5a", textTransform: "none", letterSpacing: 0, fontFamily: "inherit" }}>
                      — {(agents.find(a => String(a.id) === pipelineAgentFilter)?.name) || ""}
                    </span>
                  )}
                </p>
              </div>
              {/* v20.7.53 — Admin agent selector for the pipeline view. "All Agents"
                  shows the aggregate pool; selecting one agent filters both the
                  tile counts and the paginated table below to only that agent's
                  leads. Both queries key on pipelineAgentFilter so switching is
                  instant. */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Agent</span>
                <Select value={pipelineAgentFilter} onValueChange={setPipelineAgentFilter}>
                  <SelectTrigger className="w-48 bg-secondary border-border text-sm h-8" data-testid="select-pipeline-agent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Agents</SelectItem>
                    {[...agents]
                      .filter((a: any) => a.isActive && !(a.email || "").startsWith("tombstone:"))
                      .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""))
                      .map((a: any) => (
                        <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                      ))
                    }
                  </SelectContent>
                </Select>
              </div>
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
                    {/* v15.3 — Intent filter (Sell / Buy / Sell&Buy / Unset). Server-side via /api/leads/paginated?intent=. */}
                    <Select value={intentFilter} onValueChange={setIntentFilter}>
                      <SelectTrigger className="w-40 bg-secondary border-border text-sm" data-testid="select-intent-filter">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Intents</SelectItem>
                        <SelectItem value="sell_only">Sell only</SelectItem>
                        <SelectItem value="buy_only">Buy only</SelectItem>
                        <SelectItem value="sell_and_buy">Sell &amp; Buy</SelectItem>
                        <SelectItem value="unset">Unset</SelectItem>
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
                              {/* v15.3 — Intent chip (matches AgentView badge palette). */}
                              {(() => {
                                const raw = lead.intent || (lead.alsoBuying ? "sell_and_buy" : null);
                                if (!raw) return null;
                                const map: Record<string, { bg: string; fg: string; label: string; border: string }> = {
                                  sell_only:    { bg: "rgba(200,170,90,0.16)", fg: "#c8aa5a", label: "Sell",      border: "rgba(200,170,90,0.5)" },
                                  buy_only:     { bg: "rgba(147,197,253,0.18)", fg: "#93c5fd", label: "Buy",       border: "rgba(59,130,246,0.5)" },
                                  sell_and_buy: { bg: "linear-gradient(90deg, rgba(200,170,90,0.22) 0%, rgba(147,197,253,0.22) 100%)", fg: "#f0f0f0", label: "Sell & Buy", border: "rgba(200,170,90,0.5)" },
                                };
                                const s = map[raw];
                                if (!s) return null;
                                return (
                                  <span data-testid={`intent-chip-${raw}`} style={{
                                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                                    height: 18, padding: "0 7px",
                                    borderRadius: 9, fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
                                    background: s.bg, color: s.fg, border: `1px solid ${s.border}`, whiteSpace: "nowrap",
                                  }}>{s.label}</span>
                                );
                              })()}
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

          {/* v16.7 — KPI panel: "What Turns the Gears" — dials-per-appt, KIT/appt,
              referrals/appt, OH logs/appt, OH leads/appt, knocks/appt per agent
              + team roll-up. Scope: cycle | month | all. */}
          <TabsContent value="kpi" className="mt-5">
            <KpiRatiosPanel />
          </TabsContent>

          {/* v17.0 — Unified approvals queue. Currently only Open House Log
              submissions; Direct Mail + Door Knocking pipe into the same queue
              once their flows ship. Approve = award points + insert lead_activity.
              Reject = no points, no activity, decision_notes saved for audit. */}
          <TabsContent value="approvals" className="mt-5">
            {/* v20.4.9 — Pending open houses submitted by Denise appear at the top. */}
            <PendingOpenHousesPanel />
            <ApprovalsPanel />
          </TabsContent>

          {/* v19.6 — Candidate onboarding panel: pending applications, approve/decline */}
          <TabsContent value="candidates" className="mt-5">
            <CandidatesPanel />
          </TabsContent>

          {/* v18.0 — Lead Diversity Challenge panel: weekly history + preview + re-award */}
          <TabsContent value="diversity" className="mt-5">
            <DiversityPanel />
          </TabsContent>

          {/* v18.0 — DB Health: read-only audit report + dry-run repair actions with journal */}
          <TabsContent value="dbhealth" className="mt-5">
            <DbHealthPanel />
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

              {/* v20.4.9 — Listings section: Denise's Monday upload. */}
              <ListingsPanel />

              {/* v20.6.8 — Weekly workbook upload REMOVED. FUB is now source of truth.
                  Denise updates FUB directly; the Monday 6am sweep pulls state into LD.
                  Backup exports flow FROM LD via the button below. */}
              <div style={{ marginTop: 24, padding: 20, borderRadius: 12, background: "rgba(200,170,90,0.08)", border: "1px solid rgba(200,170,90,0.3)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#c8aa5a", marginBottom: 8 }}>Source of Truth Backup</div>
                <div style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", lineHeight: 1.55, marginBottom: 14 }}>
                  FUB is the master record. This button exports Lead Depot's current state as an Excel workbook (Sellers + Buyers + Rentals tabs) so you can hand it to Denise or archive it. Nothing is uploaded here anymore — Denise updates FUB directly and the Monday 6am sweep pulls the fresh state in.
                </div>
                <a
                  href="/api/admin/source-of-truth-backup/download"
                  download
                  style={{
                    display: "inline-block",
                    padding: "10px 18px",
                    borderRadius: 8,
                    background: "#c8aa5a",
                    color: "#0d0d0d",
                    fontSize: 14,
                    fontWeight: 700,
                    textDecoration: "none",
                    letterSpacing: ".02em",
                  }}
                >
                  Download Backup Workbook (.xlsx)
                </a>
              </div>
              <FubTagConfigPanel />
            </div>
          </TabsContent>

          {/* v20.6.0 — MASTER LIST: every buyer + renter, merged sources, K/X + rental toggle. */}
          <TabsContent value="masterlist" className="mt-5">
            <MasterListPanel />
          </TabsContent>

          {/* v20.6.1 — Newsletter Inputs panel: 5 buckets for Tuesday sends. */}
          <TabsContent value="newsletter" className="mt-5">
            <NewsletterInputsPanel />
          </TabsContent>

          {/* v20.4.9 — Open Houses admin tab: Denise's Tuesday schedule form. */}
          <TabsContent value="openhouses" className="mt-5">
            <OpenHouseSchedulePanel />
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
              // v20.7.53 — Inactive agents concept removed. Every row in `agents` is
              // considered active in the roster. Deactivation flow is retired; the
              // trash icon on the active row is now a direct hard-delete with two
              // confirmation steps. Historical activity of hard-deleted agents is
              // preserved as anonymous (agent_id nulled) per the server routes.
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
                      {/* v20.4.2 — Add Agent removed. Agents now come in through Candidates → Approve. */}
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
                              {/* v20.7.53 — Flow toggle + Flow On/Off badge removed.
                                  Every roster agent is now on-flow structurally. */}
                              {/* v14.0 — Min Dials/Wk gate removed. Motivation over shaming. */}
                              {/* v15.11.26 — Set Password: admin types the new password directly. */}
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-amber-400"
                                onClick={() => { setSetPasswordAgent({ id: agent.id, name: agent.name, email: agent.email }); setSetPasswordValue(""); }}
                                title="Set password directly"
                                data-testid={`button-set-password-${agent.id}`}
                              >
                                <KeyRound size={13}/>
                              </Button>
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
                              {/* v20.7.53 — Merge button removed. */}
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-purple-400"
                                onClick={() => setAuditLogAgentId(agent.id)}
                                title="View audit log"
                                data-testid={`button-audit-log-${agent.id}`}
                              >
                                <ScrollText size={13}/>
                              </Button>
                              {/* v20.7.53 — Reset today's skip quota button removed. */}
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={() => {
                                  // v20.7.53 — Two-step confirmation for permanent removal.
                                  const ok = window.confirm(`Permanently DELETE ${agent.name}?\n\nThis removes the agent from the app entirely. All leads in their queue return to the shared pool. Historical activity (calls, KIT, appts) is preserved but attributed to "anonymous".\n\nThis cannot be undone. Type DELETE on the next prompt to confirm.`);
                                  if (!ok) return;
                                  const typed = window.prompt(`Type DELETE to permanently remove ${agent.name}:`);
                                  if (typed !== "DELETE") { alert("Not deleted (you must type DELETE exactly)."); return; }
                                  hardDeleteAgentMutation.mutate(agent.id);
                                }}
                                title="Delete agent (permanent)"
                                disabled={hardDeleteAgentMutation.isPending}
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

                  {/* v20.7.53 — Inactive Agents section removed. All roster rows are active. */}
                </>
              );
            })()}
          </TabsContent>

          {/* ── SCRIPTS ─────────────────────────────────────────────────────── */}
          <TabsContent value="scripts" className="mt-5">
            <ScriptEditor />
          </TabsContent>

          {/* v20.9.0 — Repair Program admin: Pricing Catalog + Vendor Directory CRUD. */}
          <TabsContent value="repairs" className="mt-5">
            <div>
              <h2 style={{
                fontFamily: "'Cormorant Garamond','Georgia',serif",
                fontSize: "1.2rem", fontWeight: 300, color: "#fff",
              }}>
                Repair Program
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                In-house pricing catalog and licensed-trade vendor directory for the Repair Consult tool.
              </p>
            </div>
            <RepairPricingVendorPanel />
          </TabsContent>

          {/* v20.4.2 — Old admin Territory Map (MapView.tsx) removed. Team map lives in
              AgentView → Leaderboard → Map toggle and is now real-coord + masked. */}

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
              ⚠ Hard Reset Seller Depot
            </p>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", marginBottom: 8, lineHeight: 1.5 }}>
              This will permanently delete{" "}
              <b style={{ color: "#fff" }}>
                {`${stats?.totalLeads ?? 0} seller lead${(stats?.totalLeads ?? 0) === 1 ? "" : "s"}, all activity, points, and appointments`}
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

      {/* v15.11.26 — Set Password dialog. Admin types the new password directly; server
           bcrypt-hashes it, writes to agents.password, and revokes all sessions for that
           agent. Agents no longer see Change Password in their Profile — this is the
           canonical path for every rotation. */}
      <Dialog open={setPasswordAgent !== null} onOpenChange={(open) => { if (!open) { setSetPasswordAgent(null); setSetPasswordValue(""); } }}>
        <DialogContent style={{ background: "#0f0f0f", border: "1px solid rgba(200,170,90,0.15)", maxWidth: 440 }}>
          <DialogHeader>
            <DialogTitle style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontWeight: 300, fontSize: "1.3rem", color: "#fff" }}>
              Set password for {setPasswordAgent?.name}
            </DialogTitle>
          </DialogHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 6 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>
              This replaces {setPasswordAgent?.name}'s current password and revokes every
              active session. Deliver the new password to them privately — they will not
              receive any email from Lead Depot. Minimum 8 characters.
            </div>
            <input
              type="text"
              autoFocus
              value={setPasswordValue}
              onChange={(e) => setSetPasswordValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !setPasswordSaving) submitSetPassword(); }}
              placeholder="New password"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 6,
                background: "rgba(0,0,0,0.4)",
                border: "1px solid rgba(200,170,90,0.22)",
                color: "#fff",
                fontSize: 14,
                fontFamily: "'ui-monospace','SFMono-Regular',Menlo,monospace",
                letterSpacing: "0.02em",
              }}
              data-testid="input-set-password"
            />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
              <button
                onClick={() => { setSetPasswordAgent(null); setSetPasswordValue(""); }}
                disabled={setPasswordSaving}
                style={{
                  padding: "9px 16px",
                  borderRadius: 6,
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.15)",
                  color: "rgba(255,255,255,0.75)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >Cancel</button>
              <button
                onClick={submitSetPassword}
                disabled={setPasswordSaving || setPasswordValue.trim().length < 8}
                style={{
                  padding: "9px 18px",
                  borderRadius: 6,
                  background: "#c8aa5a",
                  border: "none",
                  color: "#0f0f0f",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: (setPasswordSaving || setPasswordValue.trim().length < 8) ? "not-allowed" : "pointer",
                  opacity: (setPasswordSaving || setPasswordValue.trim().length < 8) ? 0.5 : 1,
                }}
                data-testid="button-set-password-submit"
              >{setPasswordSaving ? "Setting…" : "Set password"}</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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

// ─── v16.7 KPI Ratios panel — "What Turns the Gears" ─────────────────────────
// Answers Alex's core question: for every appointment, how many dials / KITs /
// referrals / open-house logs / open-house leads / door-knocks did it take?
// Per agent + team roll-up. Toggle scope: current cycle (default), last 30
// days, all-time.
function KpiRatiosPanel() {
  const [scope, setScope] = React.useState<"cycle" | "month" | "all">("cycle");
  const { data, isLoading, refetch, isFetching } = useQuery<any>({
    queryKey: ["/api/admin/kpi-ratios", scope],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/admin/kpi-ratios?scope=${scope}`);
      return r.json();
    },
    refetchInterval: 60000,
  });

  const rows = data?.agents || [];
  const team = data?.team || null;

  const scopeLabel = scope === "cycle" ? "This Cycle" : scope === "month" ? "Last 30 Days" : "All Time";

  const fmtRatio = (r: number | null | undefined) => {
    if (r === null || r === undefined || !isFinite(r)) return "—";
    if (r === 0) return "0";
    return r >= 100 ? Math.round(r).toString() : r.toFixed(1);
  };

  const cell: React.CSSProperties = { padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 13, color: "#fff" };
  const headerCell: React.CSSProperties = {
    padding: "10px 12px", borderBottom: "1px solid rgba(200,170,90,0.2)",
    fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase",
    color: "rgba(200,170,90,0.75)", fontWeight: 700, textAlign: "center",
  };

  return (
    <div>
      {/* Header + scope toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, color: "#fff", fontWeight: 700, fontFamily: "'Cormorant Garamond',serif" }}>What Turns the Gears</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 1.5 }}>
            How much activity produces one appointment. Lower ratios = more efficient.
          </p>
        </div>
        <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 4 }}>
          {(["cycle", "month", "all"] as const).map(s => (
            <button key={s} onClick={() => setScope(s)} style={{
              padding: "6px 12px", background: scope === s ? "rgba(200,170,90,0.18)" : "transparent",
              border: scope === s ? "1px solid rgba(200,170,90,0.4)" : "1px solid transparent",
              borderRadius: 6, color: scope === s ? "#c8aa5a" : "rgba(255,255,255,0.6)",
              fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase",
              cursor: "pointer",
            }}>{s === "cycle" ? "Cycle" : s === "month" ? "30d" : "All"}</button>
          ))}
          <button onClick={() => refetch()} disabled={isFetching} style={{
            padding: "6px 10px", background: "transparent", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 6, color: "rgba(255,255,255,0.5)", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 4, fontSize: 11,
          }}><RefreshCw size={12} className={isFetching ? "animate-spin" : ""} /></button>
        </div>
      </div>

      {isLoading ? (
        <div style={{ padding: 40, textAlign: "center", color: "rgba(255,255,255,0.4)" }}>Loading KPIs…</div>
      ) : (
        <>
          {/* Team roll-up cards */}
          {team && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10, marginBottom: 20 }}>
              {[
                { label: "Dials / Appt", val: team.dialsPerAppt, hint: `${team.dials} dials → ${team.appts} appts` },
                { label: "KITs / Appt", val: team.kitPerAppt, hint: `${team.kits} KITs` },
                { label: "Referrals / Appt", val: team.referralsPerAppt, hint: `${team.referrals} referrals` },
                { label: "OH Logs / Appt", val: team.ohLogsPerAppt, hint: `${team.ohLogs} open houses` },
                { label: "OH Leads / Appt", val: team.ohLeadsPerAppt, hint: `${team.ohLeads} OH leads` },
                { label: "Knocks / Appt", val: team.knocksPerAppt, hint: `${team.knocks} knocks` },
              ].map(kpi => (
                <div key={kpi.label} style={{
                  padding: "14px 16px",
                  background: "linear-gradient(135deg, rgba(200,170,90,0.06) 0%, rgba(200,170,90,0.02) 100%)",
                  border: "1px solid rgba(200,170,90,0.18)", borderRadius: 10,
                }}>
                  <p style={{ margin: 0, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(200,170,90,0.75)", fontWeight: 700 }}>{kpi.label}</p>
                  <p style={{ margin: "6px 0 3px", fontSize: 24, color: "#fff", fontWeight: 700, fontFamily: "'Cormorant Garamond',serif" }}>{fmtRatio(kpi.val)}</p>
                  <p style={{ margin: 0, fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{kpi.hint}</p>
                </div>
              ))}
            </div>
          )}

          {/* Per-agent table */}
          <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ ...headerCell, textAlign: "left" }}>Agent</th>
                  <th style={headerCell}>Appts</th>
                  <th style={headerCell}>Dials / Appt</th>
                  <th style={headerCell}>KITs / Appt</th>
                  <th style={headerCell}>Refs / Appt</th>
                  <th style={headerCell}>OH Log / Appt</th>
                  <th style={headerCell}>OH Lead / Appt</th>
                  <th style={headerCell}>Knocks / Appt</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={8} style={{ ...cell, textAlign: "center", color: "rgba(255,255,255,0.35)", padding: 32 }}>No data for {scopeLabel.toLowerCase()}.</td></tr>
                ) : rows.map((r: any) => (
                  <tr key={r.agentId}>
                    <td style={{ ...cell, fontWeight: 600 }}>{r.name}</td>
                    <td style={{ ...cell, textAlign: "center", color: r.appts > 0 ? "#c8aa5a" : "rgba(255,255,255,0.4)", fontWeight: 700 }}>{r.appts}</td>
                    <td style={{ ...cell, textAlign: "center" }}>{fmtRatio(r.dialsPerAppt)}</td>
                    <td style={{ ...cell, textAlign: "center" }}>{fmtRatio(r.kitPerAppt)}</td>
                    <td style={{ ...cell, textAlign: "center" }}>{fmtRatio(r.referralsPerAppt)}</td>
                    <td style={{ ...cell, textAlign: "center" }}>{fmtRatio(r.ohLogsPerAppt)}</td>
                    <td style={{ ...cell, textAlign: "center" }}>{fmtRatio(r.ohLeadsPerAppt)}</td>
                    <td style={{ ...cell, textAlign: "center" }}>{fmtRatio(r.knocksPerAppt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ marginTop: 12, fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.55 }}>
            Ratios show inputs required to produce one appointment. "—" means no appointments in this window.
          </p>
        </>
      )}
    </div>
  );
}

// ─── v17.0 — Admin Approvals queue ──────────────────────────────────────────
// Unified queue for evidence-required lead-gen activities. First shipping user
// is Open House Log; Direct Mail + Door Knocking flow through the same panel
// once they ship. Each row shows the selfie/evidence, form fields, and Approve
// / Reject buttons. Approve awards points + writes lead_activity; Reject does
// neither and stores the decision note for audit.
function ApprovalsPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [rejectNotes, setRejectNotes] = useState("");

  const { data, isLoading, refetch } = useQuery<{
    items: Array<{
      id: number; kind: string; agentId: number; agentName: string;
      status: "pending" | "approved" | "rejected";
      pointsAwarded: number | null; pointsPotential: number;
      submittedAt: string; decidedAt: string | null; decidedBy: number | null;
      decisionNotes: string | null; activityId: number | null;
      payload: any;
    }>;
    counts: { pending: number; approved: number; rejected: number };
  }>({
    queryKey: ["/api/admin/approvals", statusFilter],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/admin/approvals?status=${statusFilter}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const approveMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await apiRequest("POST", `/api/admin/approvals/${id}/approve`, {});
      return r.json();
    },
    onSuccess: (result) => {
      toast({ title: "Approved", description: `+${result.pointsAwarded || 0} pts awarded.` });
      qc.invalidateQueries({ queryKey: ["/api/admin/approvals"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      setSelectedId(null);
    },
    onError: (err: any) => {
      toast({ title: "Approve failed", description: err?.message || "Unknown error", variant: "destructive" });
    },
  });

  const rejectMut = useMutation({
    mutationFn: async ({ id, notes }: { id: number; notes: string }) => {
      const r = await apiRequest("POST", `/api/admin/approvals/${id}/reject`, { notes });
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Rejected", description: "No points awarded.", variant: "destructive" });
      qc.invalidateQueries({ queryKey: ["/api/admin/approvals"] });
      setSelectedId(null);
      setRejectNotes("");
    },
    onError: (err: any) => {
      toast({ title: "Reject failed", description: err?.message || "Unknown error", variant: "destructive" });
    },
  });

  const items = data?.items || [];
  const counts = data?.counts || { pending: 0, approved: 0, rejected: 0 };

  const kindLabel = (k: string) => k === "open_house_log" ? "Open House"
    : k === "oh_knock_route" ? "OH Knock Route"
    : k === "direct_mail" ? "Direct Mail"
    : k === "door_knock" ? "Door Knocking"
    : k;

  const fmtDate = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "1.5rem", fontWeight: 300, color: "#fff", marginBottom: 4,
        }}>Approvals</h2>
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 1.5 }}>
          Evidence-required submissions. Approve to award points and log the activity. Reject to close it out with no points.
        </p>
      </div>

      {/* Filter chips */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {(["pending", "approved", "rejected", "all"] as const).map(s => {
          const n = s === "all" ? counts.pending + counts.approved + counts.rejected : counts[s as keyof typeof counts] ?? 0;
          const active = statusFilter === s;
          return (
            <button key={s} onClick={() => setStatusFilter(s)} style={{
              padding: "6px 14px", borderRadius: 999,
              background: active ? "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)" : "rgba(255,255,255,0.03)",
              border: active ? "none" : "1px solid rgba(200,170,90,0.28)",
              color: active ? "#080808" : "rgba(255,255,255,0.75)",
              fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase",
              cursor: "pointer",
            }}>
              {s} {typeof n === "number" && s !== "all" ? `· ${n}` : ""}
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>Loading…</p>
      ) : items.length === 0 ? (
        <div style={{
          padding: "40px 20px", textAlign: "center", borderRadius: 10,
          background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.4)", fontSize: 13,
        }}>
          {statusFilter === "pending" ? "No pending approvals. All caught up." : `No ${statusFilter} requests.`}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map(item => {
            const isSelected = selectedId === item.id;
            const p = item.payload || {};
            const r = p.results || {};
            return (
              <div key={item.id} style={{
                padding: 16, borderRadius: 12,
                background: "rgba(255,255,255,0.02)",
                border: item.status === "pending"
                  ? "1px solid rgba(200,170,90,0.28)"
                  : "1px solid rgba(255,255,255,0.06)",
              }}>
                <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                  {/* Evidence thumbnails. v20.7.20 — social_post can have 1-3 screenshots
                      (one per platform) in p.photoDataUrls; other kinds use single p.photoDataUrl. */}
                  {(() => {
                    const urls: string[] = Array.isArray(p.photoDataUrls) && p.photoDataUrls.length > 0
                      ? p.photoDataUrls
                      : (p.photoDataUrl ? [p.photoDataUrl] : []);
                    const plats: string[] = Array.isArray(p.platforms) ? p.platforms : [];
                    if (urls.length === 0) return null;
                    return (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flexShrink: 0 }}>
                        {urls.map((u, i) => (
                          <div key={i} style={{ position: "relative" }}>
                            <img src={u} alt={plats[i] ? `${plats[i]} evidence` : "Evidence"} style={{
                              width: 96, height: 96, objectFit: "cover", borderRadius: 8,
                              border: "1px solid rgba(200,170,90,0.28)",
                            }} />
                            {plats[i] && (
                              <span style={{
                                position: "absolute", bottom: 4, left: 4,
                                padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700,
                                letterSpacing: "0.08em", textTransform: "uppercase",
                                background: "rgba(0,0,0,0.7)", color: "#fde047",
                                border: "1px solid rgba(200,170,90,0.4)",
                              }}>{plats[i]}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{
                        padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                        letterSpacing: "0.1em", textTransform: "uppercase",
                        background: "rgba(200,170,90,0.15)", color: "#c8aa5a",
                      }}>{kindLabel(item.kind)}</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{item.agentName}</span>
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>· {fmtDate(item.submittedAt)}</span>
                      {item.status !== "pending" && (
                        <span style={{
                          padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                          letterSpacing: "0.1em", textTransform: "uppercase",
                          background: item.status === "approved" ? "rgba(76,175,80,0.15)" : "rgba(244,67,54,0.15)",
                          color: item.status === "approved" ? "#4caf50" : "#f44336",
                        }}>{item.status}</span>
                      )}
                    </div>
                    <p style={{ margin: "0 0 8px", fontSize: 13, color: "rgba(255,255,255,0.85)" }}>{p.address || "—"}</p>
                    {(r.attendees != null || r.notes || r.issues || r.recommendations) && (
                      <div style={{
                        marginTop: 8, padding: "10px 12px", borderRadius: 8,
                        background: "rgba(0,0,0,0.2)", fontSize: 12, lineHeight: 1.55,
                        color: "rgba(255,255,255,0.75)",
                      }}>
                        {r.attendees != null && <div><strong style={{ color: "#c8aa5a" }}>Attendees:</strong> {r.attendees}</div>}
                        {r.notes && <div style={{ marginTop: 4 }}><strong style={{ color: "#c8aa5a" }}>Notes:</strong> {r.notes}</div>}
                        {r.issues && <div style={{ marginTop: 4 }}><strong style={{ color: "#c8aa5a" }}>Issues:</strong> {r.issues}</div>}
                        {r.recommendations && <div style={{ marginTop: 4 }}><strong style={{ color: "#c8aa5a" }}>Recommendations:</strong> {r.recommendations}</div>}
                      </div>
                    )}
                    {item.decisionNotes && (
                      <p style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.4)", fontStyle: "italic" }}>
                        Decision note: {item.decisionNotes}
                      </p>
                    )}
                  </div>
                  {item.status === "pending" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => approveMut.mutate(item.id)} disabled={approveMut.isPending} style={{
                        padding: "8px 18px", borderRadius: 8,
                        background: "linear-gradient(135deg,#4caf50 0%,#2e7d32 100%)",
                        border: "none", color: "#fff", fontWeight: 700, fontSize: 12,
                        letterSpacing: "0.1em", textTransform: "uppercase",
                        cursor: approveMut.isPending ? "wait" : "pointer",
                        display: "flex", alignItems: "center", gap: 6,
                      }}><CheckCircle2 size={13} /> Approve +{item.pointsPotential}</button>
                      <button onClick={() => { setSelectedId(item.id === selectedId ? null : item.id); setRejectNotes(""); }} style={{
                        padding: "8px 18px", borderRadius: 8,
                        background: "rgba(244,67,54,0.12)",
                        border: "1px solid rgba(244,67,54,0.4)",
                        color: "#f44336", fontWeight: 700, fontSize: 12,
                        letterSpacing: "0.1em", textTransform: "uppercase",
                        cursor: "pointer",
                        display: "flex", alignItems: "center", gap: 6,
                      }}><XCircle size={13} /> Reject</button>
                    </div>
                  )}
                </div>

                {isSelected && item.status === "pending" && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(244,67,54,0.2)" }}>
                    <label style={{ display: "block", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(244,67,54,0.85)", fontWeight: 600, marginBottom: 6 }}>Reason for rejection (optional)</label>
                    <textarea value={rejectNotes} onChange={e => setRejectNotes(e.target.value)} rows={2} placeholder="e.g. Sign not visible in selfie, no attendees recorded…" style={{
                      width: "100%", padding: "10px 12px", borderRadius: 8,
                      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(244,67,54,0.28)",
                      color: "#fff", fontSize: 13, boxSizing: "border-box", resize: "none",
                    }} />
                    <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button onClick={() => { setSelectedId(null); setRejectNotes(""); }} style={{
                        padding: "6px 14px", borderRadius: 6,
                        background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                        color: "rgba(255,255,255,0.7)", fontSize: 11, fontWeight: 600,
                        cursor: "pointer",
                      }}>Cancel</button>
                      <button onClick={() => rejectMut.mutate({ id: item.id, notes: rejectNotes })} disabled={rejectMut.isPending} style={{
                        padding: "6px 14px", borderRadius: 6,
                        background: "linear-gradient(135deg,#f44336 0%,#c62828 100%)",
                        border: "none", color: "#fff", fontSize: 11, fontWeight: 700,
                        letterSpacing: "0.1em", textTransform: "uppercase",
                        cursor: rejectMut.isPending ? "wait" : "pointer",
                      }}>Confirm Reject</button>
                    </div>
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

// ─── v18.0 Lead Diversity Challenge panel ─────────────────────────────────────
// v19.6 Candidates panel — pending applications, approve/decline
function CandidatesPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [declining, setDeclining] = useState<number | null>(null);
  const [declineNotes, setDeclineNotes] = useState("");

  const list = useQuery({
    queryKey: ["/api/admin/candidates"],
    queryFn: async () => (await fetch("/api/admin/candidates", { credentials: "include" })).json(),
    refetchInterval: 30_000,
  });

  // v20.4.9 — FUB Pro plan seat headroom. First 10 seats included in $499/mo
  // base; seat 11+ is $49/mo. Show a pill above the list so Alex sees the state
  // before hitting Approve. Refetches on candidate-list refetch cadence.
  const seats = useQuery({
    queryKey: ["/api/admin/fub-seats"],
    queryFn: async () => (await fetch("/api/admin/fub-seats", { credentials: "include" })).json(),
    refetchInterval: 60_000,
  });

  const approveMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/admin/candidates/${id}/approve`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "approve failed");
      return data;
    },
    onSuccess: () => { toast({ title: "Approved — agent row + drafts created" }); qc.invalidateQueries({ queryKey: ["/api/admin/candidates"] }); qc.invalidateQueries({ queryKey: ["/api/agents"] }); },
    onError: (e: any) => toast({ title: e.message || "Approve failed", variant: "destructive" }),
  });

  const declineMut = useMutation({
    mutationFn: async ({ id, notes }: { id: number; notes: string }) => {
      const res = await fetch(`/api/admin/candidates/${id}/decline`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "decline failed");
      return data;
    },
    onSuccess: () => { toast({ title: "Declined — polite pass email sent" }); qc.invalidateQueries({ queryKey: ["/api/admin/candidates"] }); setDeclining(null); setDeclineNotes(""); },
    onError: (e: any) => toast({ title: e.message || "Decline failed", variant: "destructive" }),
  });

  // v20.7.53 — Hard-delete removes the candidate row and reverses any points
  // that were awarded to the referring agent (invite +50, approval +100).
  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/admin/candidates/${id}/hard-delete`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "delete failed");
      return data;
    },
    onSuccess: (data: any) => {
      const rev = (data?.reversedInvitePts || 0) + (data?.reversedApprovalPts || 0);
      toast({ title: rev > 0 ? `Deleted \u2014 reversed ${rev} pts` : "Deleted \u2014 no points to reverse" });
      qc.invalidateQueries({ queryKey: ["/api/admin/candidates"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/leaderboard"] });
    },
    onError: (e: any) => toast({ title: e.message || "Delete failed", variant: "destructive" }),
  });

  const candidates: any[] = list.data?.candidates || [];
  const buckets = {
    submitted: candidates.filter(c => c.status === "submitted"),
    invited:   candidates.filter(c => c.status === "invited"),
    approved:  candidates.filter(c => c.status === "approved"),
    declined:  candidates.filter(c => c.status === "declined"),
  };

  const toggleExpand = (id: number) => setExpanded(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const recBadge = (rec: string | null, score: number | null) => {
    if (!rec) return null;
    const map: Record<string, { c: string; b: string }> = {
      STRONG_FIT: { c: "#4ade80", b: "rgba(74,222,128,0.14)" },
      WORTH_CALL: { c: "#38bdf8", b: "rgba(56,189,248,0.14)" },
      SOFT_PASS:  { c: "#fb923c", b: "rgba(251,146,60,0.14)" },
      HARD_PASS:  { c: "#f87171", b: "rgba(248,113,113,0.14)" },
    };
    const s = map[rec] || { c: "#999", b: "rgba(255,255,255,0.05)" };
    return <span style={{ background: s.b, color: s.c, padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: ".08em" }}>{rec.replace("_", " ")}{score != null ? ` · ${score}` : ""}</span>;
  };

  const row = (c: any) => (
    <div key={c.id} style={{ padding: 14, borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <strong style={{ color: "#fff", fontSize: 15 }}>{c.name}</strong>
            {recBadge(c.recommendation, c.recommendation_score)}
          </div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>{c.phone}{c.email ? ` · ${c.email}` : ""}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
            Invited by {c.invited_by_name || "admin"} · {new Date(c.created_at).toLocaleDateString()}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
          {c.status === "submitted" && (
            <>
              <button onClick={() => approveMut.mutate(c.id)} disabled={approveMut.isPending} style={{ padding: "6px 12px", borderRadius: 6, background: "rgba(74,222,128,0.16)", border: "1px solid rgba(74,222,128,0.4)", color: "#4ade80", fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer" }}>Approve</button>
              <button onClick={() => setDeclining(c.id)} style={{ padding: "6px 12px", borderRadius: 6, background: "rgba(248,113,113,0.16)", border: "1px solid rgba(248,113,113,0.4)", color: "#f87171", fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer" }}>Decline</button>
            </>
          )}
          {/* v20.7.53 — Hard-delete on every row. Confirms, reverses pts, drops candidate. */}
          <button
            onClick={() => {
              const msg = `Hard-delete ${c.name}? Removes the candidate and reverses any recruiting points from this invite.`;
              if (window.confirm(msg)) deleteMut.mutate(c.id);
            }}
            disabled={deleteMut.isPending}
            title="Hard delete + reverse points"
            style={{ padding: "6px 8px", borderRadius: 6, background: "transparent", border: "1px solid rgba(255,255,255,0.14)", color: "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {c.status === "submitted" && c.questionnaire && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => toggleExpand(c.id)} style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", padding: 0, fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", fontWeight: 700 }}>{expanded.has(c.id) ? "Hide answers ▲" : "View answers ▼"}</button>
          {expanded.has(c.id) && (
            <div style={{ marginTop: 10, padding: 12, background: "rgba(0,0,0,0.2)", borderRadius: 8, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
              {Object.entries(c.questionnaire).map(([k, v]) => (
                <div key={k} style={{ marginBottom: 4 }}><span style={{ color: "rgba(255,255,255,0.4)", textTransform: "capitalize" }}>{k.replace(/_/g, " ")}:</span> {String(v ?? "—")}</div>
              ))}
            </div>
          )}
        </div>
      )}
      {declining === c.id && (
        <div style={{ marginTop: 10, padding: 12, background: "rgba(248,113,113,0.06)", borderRadius: 8, border: "1px solid rgba(248,113,113,0.2)" }}>
          <textarea value={declineNotes} onChange={e => setDeclineNotes(e.target.value)} placeholder="Internal decline note (optional — not sent to candidate)" rows={2} style={{ width: "100%", padding: 8, borderRadius: 6, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.14)", color: "#fff", fontSize: 12, marginBottom: 8, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => declineMut.mutate({ id: c.id, notes: declineNotes })} disabled={declineMut.isPending} style={{ padding: "6px 12px", borderRadius: 6, background: "rgba(248,113,113,0.24)", border: "1px solid rgba(248,113,113,0.5)", color: "#f87171", fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer" }}>Confirm decline</button>
            <button onClick={() => { setDeclining(null); setDeclineNotes(""); }} style={{ padding: "6px 12px", borderRadius: 6, background: "transparent", border: "1px solid rgba(255,255,255,0.14)", color: "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );

  const section = (title: string, items: any[], empty: string) => (
    <div style={{ marginBottom: 20 }}>
      <h4 style={{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginBottom: 8, fontWeight: 700 }}>{title} ({items.length})</h4>
      {items.length === 0 ? <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>{empty}</p> : items.map(row)}
    </div>
  );

  if (list.isLoading) return <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>Loading candidates…</p>;

  // v20.4.9 — seat pill rendering
  const seatData = seats.data;
  const seatPill = (() => {
    if (!seatData) return null;
    if (seatData.error) {
      return <span style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, letterSpacing: ".08em", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.14)", color: "rgba(255,255,255,0.5)" }}>FUB seats — unavailable</span>;
    }
    const overage = seatData.overageSeats > 0;
    const willOverage = seatData.nextApproveWouldOverage && !overage;
    const color = overage ? "#f87171" : willOverage ? "#fbbf24" : "#4ade80";
    const bg    = overage ? "rgba(248,113,113,0.14)" : willOverage ? "rgba(251,191,36,0.14)" : "rgba(74,222,128,0.12)";
    const border = overage ? "rgba(248,113,113,0.4)" : willOverage ? "rgba(251,191,36,0.4)" : "rgba(74,222,128,0.3)";
    const label = overage
      ? `FUB seats: ${seatData.used}/${seatData.included} — overage +$${seatData.overageMonthlyCost}/mo (${seatData.overageSeats} extra)`
      : willOverage
      ? `FUB seats: ${seatData.used}/${seatData.included} — next approve = +$${seatData.overagePerSeat}/mo`
      : `FUB seats: ${seatData.used}/${seatData.included} — ${seatData.remaining} remaining`;
    return <span style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, letterSpacing: ".08em", background: bg, border: `1px solid ${border}`, color }}>{label}</span>;
  })();

  return (
    <div>
      {seatPill && <div style={{ marginBottom: 10 }}>{seatPill}</div>}
      <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 16, lineHeight: 1.55 }}>
Only Alex can approve. Approve creates the agent row, drafts a personal welcome email to Alex's inbox (to hand-send from Superhuman), emails Nate an onboarding brief (CC Alex + Denise), AND emails Brittany Brooks + Michelle Weaver to kick off Momentum Realty onboarding (CC Alex + Nate). Decline sends a polite pass email.
      </p>
      {section("Ready to review", buckets.submitted, "No candidates awaiting decision.")}
      {section("Invited (not yet submitted)", buckets.invited, "No pending invites.")}
      {section("Approved", buckets.approved, "None yet.")}
      {section("Declined", buckets.declined, "None yet.")}
    </div>
  );
}

// Weekly bonus for hitting 3/4/5 different lead-gen categories.
// Shows: current-week preview (who would win right now), history table, re-award button.
function DiversityPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const history = useQuery({
    queryKey: ["/api/admin/diversity/history"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/admin/diversity/history");
      return r.json();
    },
    refetchInterval: 90000, // v19.5 — daily-cadence data
  });

  const preview = useQuery({
    queryKey: ["/api/admin/diversity/preview"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/admin/diversity/preview");
      return r.json();
    },
    refetchInterval: 90000, // v19.5 — daily-cadence data
  });

  const reaward = useMutation({
    mutationFn: async (date: string) => {
      const r = await apiRequest("POST", "/api/admin/diversity/reaward", { date });
      return r.json();
    },
    onSuccess: (d: any) => {
      toast({ title: "Diversity re-awarded", description: `${d.awardsCount ?? 0} agents processed` });
      qc.invalidateQueries({ queryKey: ["/api/admin/diversity/history"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/diversity/preview"] });
    },
    onError: (err: any) => toast({ title: "Re-award failed", description: err?.message || String(err), variant: "destructive" }),
  });

  const rows: any[] = Array.isArray(history.data?.rows) ? history.data.rows : [];
  const pv: any[] = Array.isArray(preview.data?.rows) ? preview.data.rows : [];
  const pvWeek: string = preview.data?.weekStart ?? "";

  const catColors: Record<string, string> = {
    phone: "#60a5fa",
    open_house: "#c8aa5a",
    door_knock: "#4ade80",
    direct_mail: "#f472b6",
    social: "#a78bfa",
  };

  const catChip = (c: string) => (
    <span key={c} style={{
      display: "inline-block", padding: "3px 8px", borderRadius: 6, marginRight: 4,
      fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em",
      background: `${catColors[c] || "#888"}22`,
      color: catColors[c] || "#ccc",
      border: `1px solid ${catColors[c] || "#888"}44`,
    }}>{c.replace("_", " ")}</span>
  );

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "1.4rem", fontWeight: 300, color: "#fff", marginBottom: 4,
        }}>Lead Diversity Challenge</h2>
        <p className="text-sm text-muted-foreground">
          Weekly bonus (Mon–Sun ET) for hitting multiple lead-gen categories. 3 cats = +150, 4 = +200, 5 = +250.
          Auto-awards Sunday 23:59 ET.
        </p>
      </div>

      {/* CURRENT WEEK PREVIEW */}
      <div style={{
        background: "rgba(200,170,90,0.05)",
        border: "1px solid rgba(200,170,90,0.18)",
        borderRadius: 10, padding: 18,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: "#fde047", marginBottom: 2, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              Current Week Preview
            </h3>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", margin: 0 }}>
              Week of {pvWeek || "—"} · what would award if today were Sunday
            </p>
          </div>
          <Button
            size="sm" variant="outline"
            onClick={() => { preview.refetch(); history.refetch(); }}
            disabled={preview.isFetching}
          >
            <RefreshCw size={12} className={preview.isFetching ? "animate-spin" : ""} />
            <span style={{ marginLeft: 6 }}>Refresh</span>
          </Button>
        </div>

        {pv.length === 0 ? (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", padding: "20px 0", textAlign: "center" }}>
            No agents qualify yet this week.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pv.map((row: any) => (
              <div key={row.agentId} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 12px", borderRadius: 8,
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{row.agentName}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                    {Array.isArray(row.categories) && row.categories.map((c: string) => catChip(c))}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#fde047", lineHeight: 1 }}>+{row.potentialBonus}</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{row.count} cats</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* HISTORY */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.75)", letterSpacing: "0.08em", textTransform: "uppercase", margin: 0 }}>
            Award History
          </h3>
          {rows.length > 0 && rows[0].week_start && (
            <Button
              size="sm" variant="outline"
              onClick={() => {
                if (confirm(`Re-award week ${rows[0].week_start}? Idempotent — safe to run twice.`)) {
                  reaward.mutate(rows[0].week_start);
                }
              }}
              disabled={reaward.isPending}
            >
              <RotateCcw size={12} />
              <span style={{ marginLeft: 6 }}>Re-award last week</span>
            </Button>
          )}
        </div>

        {history.isLoading ? (
          <Skeleton className="h-40" />
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", padding: 20, textAlign: "center",
            background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)" }}>
            No bonuses awarded yet. First auto-fire happens Sunday 23:59 ET.
          </p>
        ) : (
          <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)" }}>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Week</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Agent</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Categories</th>
                  <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Points</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Awarded</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any, i: number) => {
                  let cats: string[] = [];
                  try { cats = JSON.parse(r.categories_list || "[]"); } catch {}
                  return (
                    <tr key={r.id} style={{ borderTop: i === 0 ? "none" : "1px solid rgba(255,255,255,0.06)" }}>
                      <td style={{ padding: "10px 12px", color: "rgba(255,255,255,0.6)", fontFamily: "monospace" }}>{r.week_start}</td>
                      <td style={{ padding: "10px 12px", color: "#fff", fontWeight: 500 }}>{r.agent_name || `#${r.agent_id}`}</td>
                      <td style={{ padding: "10px 12px" }}>{cats.map(c => catChip(c))}</td>
                      <td style={{ padding: "10px 12px", textAlign: "right", color: "#fde047", fontWeight: 700 }}>+{r.points_awarded}</td>
                      <td style={{ padding: "10px 12px", color: "rgba(255,255,255,0.4)", fontSize: 11 }}>
                        {r.awarded_at ? new Date(r.awarded_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── v18.0 DB Health panel ────────────────────────────────────────────────────
// Read-only audit + dry-run-default repair actions. Every repair journaled.
function DbHealthPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const audit = useQuery({
    queryKey: ["/api/admin/db-audit"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/admin/db-audit");
      return r.json();
    },
  });

  const log = useQuery({
    queryKey: ["/api/admin/db-repair/log"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/admin/db-repair/log");
      return r.json();
    },
  });

  const runRepair = async (endpoint: string, label: string, dryRun: boolean) => {
    try {
      const r = await apiRequest("POST", endpoint, { dryRun });
      const data = await r.json();
      if (r.ok) {
        // Server response shape varies by endpoint: recompute returns { drift }, prune/reassign return { rowsAffected } or { pruned }, so summarize whatever is present.
        const affected = data.drift ?? data.rowsAffected ?? data.pruned ?? data.reassigned ?? data.checked ?? 0;
        toast({
          title: dryRun ? `Preview: ${label}` : `Applied: ${label}`,
          description: `${affected} rows ${dryRun ? "would be" : "were"} affected`,
        });
        qc.invalidateQueries({ queryKey: ["/api/admin/db-audit"] });
        qc.invalidateQueries({ queryKey: ["/api/admin/db-repair/log"] });
      } else {
        toast({ title: "Repair failed", description: data.error || "Unknown", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Repair failed", description: err?.message || String(err), variant: "destructive" });
    }
  };

  const findings: any[] = Array.isArray(audit.data?.findings) ? audit.data.findings : [];
  const totals = audit.data?.totals || { critical: 0, warning: 0, info: 0 };
  const logRows: any[] = Array.isArray(log.data?.rows) ? log.data.rows : [];

  const sevColor = (s: string) => s === "critical" ? "#ef4444" : s === "warning" ? "#eab308" : "#60a5fa";
  const sevBg = (s: string) => s === "critical" ? "rgba(239,68,68,0.08)" : s === "warning" ? "rgba(234,179,8,0.08)" : "rgba(96,165,250,0.06)";

  const RepairCard = ({ label, description, endpoint, danger }: { label: string; description: string; endpoint: string; danger?: boolean }) => (
    <div style={{
      padding: 14, borderRadius: 10,
      background: "rgba(255,255,255,0.03)",
      border: `1px solid ${danger ? "rgba(239,68,68,0.24)" : "rgba(200,170,90,0.18)"}`,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 10, lineHeight: 1.5 }}>{description}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button size="sm" variant="outline" onClick={() => runRepair(endpoint, label, true)}>
          <PlayCircle size={12} /> <span style={{ marginLeft: 6 }}>Dry-run</span>
        </Button>
        <Button size="sm" variant={danger ? "destructive" : "default"}
          onClick={() => { if (confirm(`Apply "${label}"? This will write to the database.`)) runRepair(endpoint, label, false); }}>
          <Wrench size={12} /> <span style={{ marginLeft: 6 }}>Apply</span>
        </Button>
      </div>
    </div>
  );

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "1.4rem", fontWeight: 300, color: "#fff", marginBottom: 4,
        }}>DB Health · Audit + Repair</h2>
        <p className="text-sm text-muted-foreground">
          Read-only sweep for orphans, ledger drift, and bloat. Repairs default to dry-run and are journaled.
        </p>
      </div>

      {/* AUDIT SUMMARY */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
        <div style={{ padding: 14, borderRadius: 10, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.28)" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(239,68,68,0.85)", marginBottom: 4 }}>Critical</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#fca5a5" }}>{totals.critical}</div>
        </div>
        <div style={{ padding: 14, borderRadius: 10, background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.28)" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(234,179,8,0.85)", marginBottom: 4 }}>Warning</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#fde047" }}>{totals.warning}</div>
        </div>
        <div style={{ padding: 14, borderRadius: 10, background: "rgba(96,165,250,0.06)", border: "1px solid rgba(96,165,250,0.24)" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(96,165,250,0.85)", marginBottom: 4 }}>Info</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#93c5fd" }}>{totals.info}</div>
        </div>
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.75)", letterSpacing: "0.08em", textTransform: "uppercase", margin: 0 }}>
            Findings
          </h3>
          <Button size="sm" variant="outline" onClick={() => audit.refetch()} disabled={audit.isFetching}>
            <RefreshCw size={12} className={audit.isFetching ? "animate-spin" : ""} />
            <span style={{ marginLeft: 6 }}>Re-scan</span>
          </Button>
        </div>

        {audit.isLoading ? (
          <Skeleton className="h-40" />
        ) : findings.length === 0 ? (
          <p style={{ fontSize: 12, color: "#4ade80", padding: 20, textAlign: "center",
            background: "rgba(74,222,128,0.05)", borderRadius: 8, border: "1px solid rgba(74,222,128,0.2)" }}>
            ✓ Clean board. No issues found.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {findings.map((f: any, i: number) => (
              <div key={i} style={{ padding: 12, borderRadius: 8, background: sevBg(f.severity), border: `1px solid ${sevColor(f.severity)}33` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{
                      fontSize: 9, padding: "2px 6px", borderRadius: 4,
                      background: sevColor(f.severity), color: "#080808", fontWeight: 700, letterSpacing: "0.06em",
                    }}>{String(f.severity || "info").toUpperCase()}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>{f.check}</span>
                  </div>
                  {typeof f.count === "number" && (
                    <span style={{ fontSize: 12, color: sevColor(f.severity), fontWeight: 700 }}>{f.count}</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.5 }}>{f.detail}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* REPAIR ACTIONS */}
      <div>
        <h3 style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.75)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
          Repair Actions
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
          <RepairCard
            label="Recompute points (all agents)"
            description="Rebuild ledger totals from lead_activity + approvals + diversity_bonuses. Inserts a single repair:recompute delta row per agent — never rewrites history."
            endpoint="/api/admin/db-repair/recompute-points"
          />
          <RepairCard
            label="Prune stale evidence photos"
            description="Strip photoDataUrl from decided approvals older than 180 days. Row + metadata preserved; only image data removed."
            endpoint="/api/admin/db-repair/prune-evidence"
          />
          <RepairCard
            label="Reassign orphan leads"
            description="Null out assigned_agent_id for leads owned by deactivated agents. Sends them back to the shared pool."
            endpoint="/api/admin/db-repair/reassign-orphan-leads"
            danger
          />
        </div>
      </div>

      {/* REPAIR LOG */}
      <div>
        <h3 style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.75)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
          Repair Journal
        </h3>
        {log.isLoading ? (
          <Skeleton className="h-32" />
        ) : logRows.length === 0 ? (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", padding: 20, textAlign: "center",
            background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)" }}>
            No repairs run yet.
          </p>
        ) : (
          <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)" }}>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>When</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Operation</th>
                  <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Actor</th>
                  <th style={{ padding: "8px 12px", textAlign: "center", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Mode</th>
                  <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>Rows</th>
                </tr>
              </thead>
              <tbody>
                {logRows.map((r: any, i: number) => (
                  <tr key={r.id} style={{ borderTop: i === 0 ? "none" : "1px solid rgba(255,255,255,0.06)" }}>
                    <td style={{ padding: "8px 12px", color: "rgba(255,255,255,0.5)", fontFamily: "monospace", fontSize: 10 }}>
                      {r.ran_at ? new Date(r.ran_at).toLocaleString() : "—"}
                    </td>
                    <td style={{ padding: "8px 12px", color: "#fff", fontWeight: 500 }}>{r.operation}</td>
                    <td style={{ padding: "8px 12px", color: "rgba(255,255,255,0.6)" }}>{r.actor_name || "system"}</td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <span style={{
                        fontSize: 9, padding: "2px 6px", borderRadius: 4, fontWeight: 700, letterSpacing: "0.06em",
                        background: r.dry_run ? "rgba(96,165,250,0.15)" : "rgba(74,222,128,0.15)",
                        color: r.dry_run ? "#93c5fd" : "#4ade80",
                      }}>{r.dry_run ? "DRY-RUN" : "APPLIED"}</span>
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right", color: "#fde047", fontWeight: 600 }}>{r.rows_affected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// v20.6.0 — MASTER LIST PANEL
//   Every buyer + renter, merged sources, source badges, K/X + rental toggle.
//   Backend: GET /api/admin/master-list, POST /api/admin/master-list/:id/action
// ═══════════════════════════════════════════════════════════════════════════
function MasterListPanel() {
  const [q, setQ] = useState("");
  const [source, setSource] = useState<"all"|"excel"|"fub"|"lead_depot">("all");
  const [kind, setKind] = useState<"all"|"buyer"|"rental">("all");
  const [status, setStatus] = useState<"all"|"active"|"nurture"|"closed"|"rental"|"dead">("all");
  const [rows, setRows] = useState<any[]>([]);
  const [counts, setCounts] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      const params = new URLSearchParams({ q, source, kind, status });
      const r = await fetch(`/api/admin/master-list?${params.toString()}`, { credentials: "include" });
      const j = await r.json();
      setRows(j.rows || []);
      setCounts(j.counts || null);
    } catch (e) { console.error("[master-list load]", e); }
    finally { setBusy(false); }
  }, [q, source, kind, status]);

  useEffect(() => { load(); }, [load]);

  const doAction = async (id: number, action: "keep"|"kill"|"toggle_rental") => {
    if (action === "kill" && !window.confirm("Mark as DEAD? Row will be excluded from all lists. (You can restore with 'K'.)")) return;
    try {
      const r = await fetch(`/api/admin/master-list/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action }),
      });
      if (r.ok) await load();
    } catch (e) { console.error("[master-list action]", e); }
  };

  const pill = (label: string, active: boolean, on: () => void) => (
    <button
      onClick={on}
      style={{
        padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
        border: active ? "1px solid #c8aa5a" : "1px solid rgba(200,170,90,0.2)",
        background: active ? "rgba(200,170,90,0.15)" : "transparent",
        color: active ? "#c8aa5a" : "#a0a0a0",
        cursor: "pointer", transition: "all 0.15s",
      }}
    >{label}</button>
  );

  const sourceBadge = (origins: string) => {
    const parsed: string[] = (() => { try { return JSON.parse(origins || "[]"); } catch { return []; } })();
    const chip = (src: string, color: string) => (
      <span key={src} style={{
        display: "inline-block", padding: "2px 6px", borderRadius: 3, fontSize: 10,
        fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase",
        background: color, color: "#0a0a0a", marginRight: 4,
      }}>{src === "lead_depot" ? "LD" : src.toUpperCase()}</span>
    );
    return (
      <>
        {parsed.includes("excel")      && chip("excel",      "#c8aa5a")}
        {parsed.includes("fub")        && chip("fub",        "#93c5fd")}
        {parsed.includes("lead_depot") && chip("lead_depot", "#4ade80")}
      </>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header + counts */}
      <div style={{
        background: "rgba(200,170,90,0.05)",
        border: "1px solid rgba(200,170,90,0.15)",
        borderRadius: 10, padding: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#f0f0f0", letterSpacing: -0.2 }}>Master List</div>
            <div style={{ fontSize: 12, color: "#7a7a7a", marginTop: 2 }}>
              Every buyer + renter, all sources merged. K = keep · X = kill · Rental toggle flips between the two buckets.
            </div>
          </div>
          <button onClick={load} disabled={busy} style={{
            padding: "8px 14px", background: "rgba(200,170,90,0.15)",
            border: "1px solid rgba(200,170,90,0.3)", borderRadius: 6,
            color: "#c8aa5a", fontSize: 12, fontWeight: 600, cursor: busy ? "wait" : "pointer",
          }}>{busy ? "Loading…" : "Refresh"}</button>
        </div>

        {counts && (
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <StatChip label="Total" value={counts.total} accent="#f0f0f0" />
            <StatChip label="Buyers" value={counts.buyers} accent="#93c5fd" />
            <StatChip label="Rentals" value={counts.rentals} accent="#a78bfa" />
            <StatChip label="From Excel" value={counts.by_source.excel} accent="#c8aa5a" />
            <StatChip label="From FUB" value={counts.by_source.fub} accent="#93c5fd" />
            <StatChip label="From LD" value={counts.by_source.lead_depot} accent="#4ade80" />
          </div>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name / email / phone / area / notes…"
          style={{
            flex: "1 1 240px", padding: "8px 12px", background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(200,170,90,0.15)", borderRadius: 6, color: "#f0f0f0", fontSize: 13,
          }}
        />
        <div style={{ display: "flex", gap: 4 }}>
          <span style={{ fontSize: 11, color: "#7a7a7a", alignSelf: "center", marginRight: 4 }}>Kind:</span>
          {pill("All", kind === "all", () => setKind("all"))}
          {pill("Buyers", kind === "buyer", () => setKind("buyer"))}
          {pill("Rentals", kind === "rental", () => setKind("rental"))}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <span style={{ fontSize: 11, color: "#7a7a7a", alignSelf: "center", marginRight: 4 }}>Source:</span>
          {pill("All", source === "all", () => setSource("all"))}
          {pill("Excel", source === "excel", () => setSource("excel"))}
          {pill("FUB", source === "fub", () => setSource("fub"))}
          {pill("LD", source === "lead_depot", () => setSource("lead_depot"))}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <span style={{ fontSize: 11, color: "#7a7a7a", alignSelf: "center", marginRight: 4 }}>Status:</span>
          {pill("All", status === "all", () => setStatus("all"))}
          {pill("Active", status === "active", () => setStatus("active"))}
          {pill("Nurture", status === "nurture", () => setStatus("nurture"))}
          {pill("Closed", status === "closed", () => setStatus("closed"))}
          {pill("Rental", status === "rental", () => setStatus("rental"))}
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", border: "1px solid rgba(200,170,90,0.1)", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead style={{ background: "rgba(200,170,90,0.06)" }}>
            <tr style={{ textAlign: "left" }}>
              <th style={hdrStyle}>Name</th>
              <th style={hdrStyle}>Contact</th>
              <th style={hdrStyle}>Status</th>
              <th style={hdrStyle}>Budget</th>
              <th style={hdrStyle}>Areas</th>
              <th style={hdrStyle}>Source</th>
              <th style={hdrStyle}>Conf</th>
              <th style={{ ...hdrStyle, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ borderTop: "1px solid rgba(200,170,90,0.06)", opacity: r.status === "dead" ? 0.4 : 1 }}>
                <td style={cellStyle}>
                  <div style={{ fontWeight: 600, color: "#f0f0f0" }}>
                    {r.name}
                    {r.multi_search_ordinal > 1 && <span style={{ marginLeft: 6, fontSize: 10, color: "#7a7a7a" }}>#{r.multi_search_ordinal}</span>}
                    {r.is_rental ? <span style={{ marginLeft: 8, padding: "1px 6px", background: "rgba(167,139,250,0.15)", color: "#a78bfa", borderRadius: 3, fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>{(r.rental_type || "rental").replace(/_/g, " ")}</span> : null}
                    {r.is_investor ? <span style={{ marginLeft: 6, padding: "1px 6px", background: "rgba(250,204,21,0.15)", color: "#facc15", borderRadius: 3, fontSize: 10, fontWeight: 700 }}>INV</span> : null}
                  </div>
                  {r.buyers_agent && <div style={{ fontSize: 10, color: "#7a7a7a", marginTop: 2 }}>Agent: {r.buyers_agent}</div>}
                </td>
                <td style={cellStyle}>
                  {r.phone && <div style={{ color: "#a0a0a0" }}>{r.phone}</div>}
                  {r.email && <div style={{ color: "#7a7a7a", fontSize: 11 }}>{r.email}</div>}
                </td>
                <td style={cellStyle}>
                  <span style={{
                    padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                    background: r.status === "active" ? "rgba(74,222,128,0.15)" :
                               r.status === "nurture" ? "rgba(250,204,21,0.15)" :
                               r.status === "rental"  ? "rgba(167,139,250,0.15)" :
                               r.status === "closed"  ? "rgba(147,197,253,0.15)" :
                                                        "rgba(239,68,68,0.15)",
                    color:      r.status === "active" ? "#4ade80" :
                               r.status === "nurture" ? "#facc15" :
                               r.status === "rental"  ? "#a78bfa" :
                               r.status === "closed"  ? "#93c5fd" :
                                                        "#ef4444",
                  }}>{r.status || "—"}</span>
                </td>
                <td style={cellStyle}>
                  {(r.price_min || r.price_max) ? (
                    <span style={{ color: "#c8aa5a", fontWeight: 600 }}>
                      {r.price_min ? `$${(r.price_min / 1000).toFixed(0)}K` : "—"} – {r.price_max ? `$${(r.price_max / 1000).toFixed(0)}K` : "—"}
                    </span>
                  ) : <span style={{ color: "#5a5a5a" }}>—</span>}
                </td>
                <td style={{ ...cellStyle, maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.preferred_areas || ""}>
                  <span style={{ color: "#a0a0a0" }}>{r.preferred_areas || "—"}</span>
                </td>
                <td style={cellStyle}>{sourceBadge(r.origin_sources)}</td>
                <td style={cellStyle}>
                  <span style={{
                    color: r.confidence >= 0.8 ? "#4ade80" : r.confidence >= 0.5 ? "#facc15" : "#7a7a7a",
                    fontWeight: 600,
                  }}>{r.confidence ? (r.confidence * 100).toFixed(0) + "%" : "—"}</span>
                </td>
                <td style={{ ...cellStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button onClick={() => doAction(r.id, "keep")} title="Keep — bump to 100% confidence" style={actionBtn("#4ade80")}>K</button>
                  <button onClick={() => doAction(r.id, "toggle_rental")} title={r.is_rental ? "Convert to Buyer" : "Convert to Rental"} style={actionBtn("#a78bfa")}>{r.is_rental ? "→B" : "→R"}</button>
                  <button onClick={() => doAction(r.id, "kill")} title="Kill — mark as dead" style={actionBtn("#ef4444")}>X</button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={8} style={{ padding: 40, textAlign: "center", color: "#5a5a5a" }}>
                {busy ? "Loading…" : "No rows match those filters."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// v20.6.1 — Newsletter Inputs admin panel. Alex fills these fields during the
// week; Monday 6am cron sends a heads-up email pointing here; Tuesday 8am
// cron reads this row and injects into the LD + BGRE newsletters.
function NewsletterInputsPanel() {
  const [quote, setQuote] = React.useState("");
  const [wins, setWins] = React.useState("");
  const [coaching, setCoaching] = React.useState("");
  const [conversation, setConversation] = React.useState("");
  const [bgreTopic, setBgreTopic] = React.useState("");
  const [weekOf, setWeekOf] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/admin/newsletter/inputs", { credentials: "include" })
      .then(r => r.json())
      .then(j => {
        if (j.ok) {
          setQuote(j.quote || "");
          setWins(j.wins || "");
          setCoaching(j.coaching || "");
          setConversation(j.conversation || "");
          setBgreTopic(j.bgre_topic || "");
          setWeekOf(j.week_of || "");
        }
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      const r = await fetch("/api/admin/newsletter/inputs", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quote, wins, coaching, conversation, bgre_topic: bgreTopic }),
      });
      const j = await r.json();
      if (j.ok) { setSaved(true); setTimeout(() => setSaved(false), 2400); }
    } catch {} finally { setSaving(false); }
  }

  const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "#8a7548", marginBottom: 6 };
  const hint: React.CSSProperties = { fontSize: 12, color: "#7a7a7a", marginBottom: 8, lineHeight: 1.5 };
  const ta: React.CSSProperties = { width: "100%", background: "rgba(0,0,0,0.35)", border: "1px solid rgba(200,170,90,0.15)", borderRadius: 6, padding: "10px 12px", color: "#f0f0f0", fontSize: 13, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical", minHeight: 70 };

  return (
    <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(200,170,90,0.12)", borderRadius: 10, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, borderBottom: "1px solid rgba(200,170,90,0.1)", paddingBottom: 12 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#f0f0f0", letterSpacing: -0.2 }}>Newsletter Inputs</div>
          <div style={{ fontSize: 12, color: "#7a7a7a", marginTop: 3 }}>Fill any/all before Tuesday 8am. Empty fields skip cleanly. Week of {weekOf || "—"}.</div>
        </div>
        <button onClick={save} disabled={saving} style={{ padding: "9px 18px", background: saved ? "#3a5f3a" : "#8a7548", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
        </button>
      </div>

      <div style={{ display: "grid", gap: 20 }}>
        <div>
          <div style={label}>Quote / scripture / wisdom of the week</div>
          <div style={hint}>One line that sets the tone. Attributed if you have the source.</div>
          <textarea style={ta} value={quote} onChange={e => setQuote(e.target.value)} placeholder='e.g. “Discipline is doing what you hate to do but nonetheless doing it like you loved it.” — Mike Tyson' />
        </div>

        <div>
          <div style={label}>Big wins &amp; shoutouts</div>
          <div style={hint}>Deals closed, listings signed, notable agent moments. Bullet-style is fine.</div>
          <textarea style={{ ...ta, minHeight: 110 }} value={wins} onChange={e => setWins(e.target.value)} placeholder='e.g. — Sarah closed the Amelia Island property…— Mike signed 3 new listings this week…' />
        </div>

        <div>
          <div style={label}>This week&apos;s coaching focus</div>
          <div style={hint}>The one skill or habit to double down on this week.</div>
          <textarea style={ta} value={coaching} onChange={e => setCoaching(e.target.value)} placeholder='e.g. Stop pitching in the first 30 seconds. Ask 3 open-ended questions before you say anything about you or the market.' />
        </div>

        <div>
          <div style={label}>Conversation starter of the week</div>
          <div style={hint}>Something to use on every call this week: rate/homeprice relationship, the window is always open, etc.</div>
          <textarea style={ta} value={conversation} onChange={e => setConversation(e.target.value)} placeholder='e.g. Ask: “If you knew rates would drop 1% next spring, would you rather list now or wait?” Then listen.' />
        </div>

        <div style={{ borderTop: "1px dashed rgba(200,170,90,0.2)", paddingTop: 18 }}>
          <div style={label}>BGRE client newsletter angle</div>
          <div style={hint}>Alex’s angle for the weekly client email. Nate reads this Tuesday 8am and writes/schedules the send. Leave blank to skip the BGRE send this week.</div>
          <textarea style={{ ...ta, minHeight: 140 }} value={bgreTopic} onChange={e => setBgreTopic(e.target.value)} placeholder='e.g. This week: the mortgage rate lock myth. Rates below 6% aren’t coming back. Buyers are winning right now because inventory is up, sellers are negotiating, and…' />
        </div>
      </div>

      <div style={{ marginTop: 20, padding: 14, background: "rgba(0,0,0,0.25)", borderRadius: 6, border: "1px solid rgba(200,170,90,0.08)", fontSize: 12, color: "#9a9a9a", lineHeight: 1.6 }}>
        <div style={{ color: "#8a7548", fontWeight: 700, marginBottom: 6, letterSpacing: 0.3 }}>How this works</div>
        <div>• Monday 6am ET — you get a heads-up email reminding you to fill anything you want in the newsletter.</div>
        <div>• Tuesday 8am ET — the LD newsletter fires to every active agent (personalized stats + your inputs above).</div>
        <div>• Tuesday 8am ET — if BGRE angle is filled, Nate gets the client newsletter draft. Empty = no send.</div>
        <div>• Anything left blank just skips that section — no wasted sends, no broken emails.</div>
      </div>
    </div>
  );
}

function StatChip({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#7a7a7a", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent, marginTop: 2 }}>{value}</div>
    </div>
  );
}

const hdrStyle: React.CSSProperties = {
  padding: "10px 12px", fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
  textTransform: "uppercase", color: "#7a7a7a", borderBottom: "1px solid rgba(200,170,90,0.1)",
};

const cellStyle: React.CSSProperties = {
  padding: "10px 12px", verticalAlign: "top",
};

function actionBtn(color: string): React.CSSProperties {
  return {
    padding: "4px 8px", marginLeft: 4, borderRadius: 3,
    background: "transparent", border: `1px solid ${color}`, color,
    fontSize: 11, fontWeight: 700, cursor: "pointer",
  };
}
