import { useState, useRef } from "react";
import ScriptEditor from "../components/ScriptEditor";
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
  LogOut, Upload, Users, BarChart3, List, Plus, Trash2,
  Phone, Mail, MapPin, RefreshCw, Trophy, TrendingUp,
  PhoneOff, PhoneMissed, Calendar, XCircle, CheckCircle2,
  AlertTriangle, ChevronRight, X, Layers, ScrollText, Power, Trash, UserCheck
} from "lucide-react";
import type { Lead, Agent } from "@shared/schema";

// ── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    assigned: "Assigned", no_answer: "No Answer", left_voicemail: "Voicemail",
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
    <div className="bg-card border border-border rounded-xl p-4">
      <div className={`text-2xl font-bold ${accent || "text-foreground"}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5 font-medium">{label}</div>
      {sub && <div className="text-xs text-muted-foreground/50 mt-1">{sub}</div>}
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
  left_voicemail: PhoneOff,
  callback_requested: Calendar,
  wrong_number: AlertTriangle,
};

const OUTCOME_COLORS: Record<string, string> = {
  contacted_appointment: "text-green-400",
  contacted_not_interested: "text-red-400",
  no_answer: "text-yellow-400",
  left_voicemail: "text-purple-400",
  callback_requested: "text-cyan-400",
  wrong_number: "text-red-600",
};

const OUTCOME_LABELS: Record<string, string> = {
  contacted_appointment: "Appts",
  contacted_not_interested: "Not Int.",
  no_answer: "No Ans.",
  left_voicemail: "VM",
  callback_requested: "Callback",
  wrong_number: "Wrong #",
};

// ── Agent Drilldown Modal ─────────────────────────────────────────────────────

function AgentDrilldown({ agentId, agentName, onClose }: { agentId: number; agentName: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/agent", agentId, "leads"],
    queryFn: () => apiRequest("GET", `/api/admin/agent/${agentId}/leads`).then(r => r.json()),
  });

  const leads: Lead[] = data?.leads || [];
  const activities = data?.activities || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-bold text-foreground">{agentName}</h2>
            <p className="text-xs text-muted-foreground">{leads.length} total leads assigned</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-1">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {isLoading ? (
            <div className="space-y-2">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
          ) : (
            <>
              {/* Recent Activity */}
              {activities.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Recent Activity</p>
                  <div className="space-y-1.5">
                    {activities.slice(0, 10).map((act: any) => {
                      const Icon = OUTCOME_ICONS[act.outcome] || ChevronRight;
                      return (
                        <div key={act.id} className="flex items-start gap-3 bg-secondary/50 rounded-lg px-3 py-2.5 border border-border">
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

              {/* Leads list */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">All Assigned Leads</p>
                {leads.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No leads assigned yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {leads.map((lead: Lead) => (
                      <div key={lead.id} className="flex items-center gap-3 bg-secondary/40 rounded-lg px-3 py-2.5 border border-border">
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

// ── Main Component ────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState<"expired" | "distressed" | "website_lead" | "fsbo" | "land">("expired");
  const [websiteLeadForm, setWebsiteLeadForm] = useState({ firstName: "", lastName: "", email: "", phone: "", address: "", city: "", state: "FL", zip: "", county: "", propertyType: "", reasonForSelling: "", estimatedValue: "", timeframe: "" });
  const [submittingWebsiteLead, setSubmittingWebsiteLead] = useState(false);
  const [newAgent, setNewAgent] = useState({ name: "", email: "", password: "" });
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
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
    mutationFn: (data: any) => apiRequest("POST", "/api/agents", data).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      setAgentDialogOpen(false);
      setNewAgent({ name: "", email: "", password: "" });
      toast({ title: "Agent added" });
    },
    onError: () => toast({ title: "Email already exists", variant: "destructive" }),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/agents/${id}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
      toast({ title: "Agent moved to Inactive" });
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

  const toggleReceiveLeadsMutation = useMutation({
    mutationFn: ({ id, receiveLeads }: { id: number; receiveLeads: boolean }) =>
      apiRequest("PATCH", `/api/agents/${id}/receive-leads`, { receiveLeads }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/agents"] }),
  });

  const toggleLeadFlowMutation = useMutation({
    mutationFn: ({ id, leadFlowOn }: { id: number; leadFlowOn: boolean }) =>
      apiRequest("PATCH", `/api/agents/${id}/lead-flow`, { leadFlowOn }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] });
    },
  });

  const toggleWebsiteLeadsMutation = useMutation({
    mutationFn: ({ id, receiveWebsiteLeads }: { id: number; receiveWebsiteLeads: boolean }) =>
      apiRequest("PATCH", `/api/agents/${id}/website-leads`, { receiveWebsiteLeads }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/agents"] }),
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

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
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
      toast({ title: `${data.created} leads uploaded`, description: `Distributed via round-robin as ${typeLabels[uploadType] || uploadType}.` });
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
    { key: "unassigned",              label: "Unassigned",    color: "text-slate-400",  bg: "bg-slate-500/10 border-slate-500/20" },
    { key: "assigned",                label: "Assigned",      color: "text-blue-400",   bg: "bg-blue-500/10 border-blue-500/20" },
    { key: "no_answer",               label: "No Answer",     color: "text-yellow-400",  bg: "bg-yellow-500/10 border-yellow-500/20" },
    { key: "left_voicemail",          label: "Voicemail",     color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20" },
    { key: "callback_requested",      label: "Callback",      color: "text-cyan-400",   bg: "bg-cyan-500/10 border-cyan-500/20" },
    { key: "contacted_appointment",   label: "Appt Set ✓",   color: "text-green-400",  bg: "bg-green-500/10 border-green-500/20" },
    { key: "contacted_not_interested",label: "Not Interested",color: "text-red-400",    bg: "bg-red-500/10 border-red-500/20" },
    { key: "wrong_number",            label: "Wrong #",       color: "text-red-600",    bg: "bg-red-900/10 border-red-900/20" },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 bg-white rounded-sm flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 40 40" fill="none" aria-label="Brothers Group">
              <path d="M4 34V8L20 2L36 8V34H4Z" fill="#171717"/>
              <path d="M4 8L20 14L36 8" stroke="white" strokeWidth="1.5" fill="none"/>
              <rect x="15" y="22" width="10" height="12" fill="white" opacity="0.9"/>
              <path d="M10 18h6M24 18h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-foreground leading-tight">Lead Depot</h1>
            <p className="text-xs text-muted-foreground">{user?.name} — Admin</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={logout} className="gap-1.5 text-muted-foreground text-xs">
          <LogOut size={13}/> Sign out
        </Button>
      </header>

      <main className="p-5 max-w-7xl mx-auto space-y-5">
        <Tabs defaultValue="leaderboard">
          <TabsList className="bg-secondary border border-border h-auto flex-wrap gap-0.5 p-1">
            <TabsTrigger value="leaderboard" className="gap-1.5 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><Trophy size={12}/>Leaderboard</TabsTrigger>
            <TabsTrigger value="pipeline" className="gap-1.5 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><Layers size={12}/>Pipeline</TabsTrigger>
            <TabsTrigger value="leads" className="gap-1.5 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><List size={12}/>All Leads</TabsTrigger>
            <TabsTrigger value="upload" className="gap-1.5 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><Upload size={12}/>Upload CSV</TabsTrigger>
            <TabsTrigger value="agents" className="gap-1.5 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><Users size={12}/>Agents</TabsTrigger>
            <TabsTrigger value="scripts" className="gap-1.5 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"><ScrollText size={12}/>Scripts</TabsTrigger>
          </TabsList>

          {/* ─── LEADERBOARD ──────────────────────────────────────────────────── */}
          <TabsContent value="leaderboard" className="mt-4 space-y-4">
            {/* Summary bar */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Total Leads" value={stats?.totalLeads ?? 0} />
              <StatCard label="Active in Queue" value={stats?.activeLeads ?? 0} accent="text-white" />
              <StatCard label="Appointments Set" value={stats?.appointmentsSet ?? 0} accent="text-green-400" />
              <StatCard label="Unassigned" value={stats?.unassignedLeads ?? 0} />
            </div>

            {/* Leaderboard */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-foreground flex items-center gap-2"><Trophy size={14} className="text-white/60"/>Agent Leaderboard</h2>
                <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["/api/admin/agent-stats"] })} className="gap-1 text-xs text-muted-foreground">
                  <RefreshCw size={11}/>Refresh
                </Button>
              </div>

              {agentStatsLoading ? (
                <div className="space-y-2">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
              ) : agentStats.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground border border-dashed border-border rounded-xl">
                  No agents yet. Add agents in the Agents tab.
                </div>
              ) : (
                <div className="space-y-2">
                  {agentStats.map((stat: any, idx: number) => {
                    const rank = idx + 1;
                    const rankColors = ["text-white", "text-white/60", "text-white/40"];
                    const rankBg = ["bg-white/10 border-white/20", "bg-white/5 border-white/10", "bg-white/5 border-white/10"];
                    return (
                      <div
                        key={stat.agent.id}
                        className="bg-card border border-border rounded-xl p-4 cursor-pointer hover:border-primary/40 transition-colors group"
                        onClick={() => setDrilldownAgent({ id: stat.agent.id, name: stat.agent.name })}
                        data-testid={`row-leaderboard-${stat.agent.id}`}
                      >
                        <div className="flex items-center gap-4">
                          {/* Rank */}
                          <div className={`w-9 h-9 rounded-full border flex items-center justify-center shrink-0 ${rankBg[idx] || "bg-secondary border-border"}`}>
                            <span className={`text-sm font-bold ${rankColors[idx] || "text-muted-foreground"}`}>#{rank}</span>
                          </div>

                          {/* Name + meta */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">{stat.agent.name}</p>
                              <ChevronRight size={12} className="text-muted-foreground group-hover:text-primary transition-colors"/>
                            </div>
                            <p className="text-xs text-muted-foreground">{stat.agent.email}</p>
                          </div>

                          {/* Key stats */}
                          <div className="hidden sm:flex items-center gap-5 text-center">
                            <div>
                              <div className="text-lg font-bold text-green-400">{stat.appointmentsSet}</div>
                              <div className="text-xs text-muted-foreground">Appts</div>
                            </div>
                            <div>
                              <div className="text-lg font-bold text-white">{stat.leadsReceived}</div>
                              <div className="text-xs text-muted-foreground">Received</div>
                            </div>
                            <div>
                              <div className="text-lg font-bold text-foreground">{stat.totalAttempts}</div>
                              <div className="text-xs text-muted-foreground">Dials</div>
                            </div>
                            <div>
                              <div className="text-lg font-bold text-cyan-400">{stat.contactRate}%</div>
                              <div className="text-xs text-muted-foreground">Contact</div>
                            </div>
                            <div>
                              <div className="text-lg font-bold text-blue-400">{stat.activeLeads}</div>
                              <div className="text-xs text-muted-foreground">Active</div>
                            </div>
                          </div>
                        </div>

                        {/* Outcome breakdown bar */}
                        {stat.totalAttempts > 0 && (
                          <div className="mt-3 flex items-center gap-3 flex-wrap">
                            {Object.entries(stat.outcomes).map(([key, val]: [string, any]) => {
                              if (!val) return null;
                              const Icon = OUTCOME_ICONS[key];
                              return (
                                <span key={key} className={`flex items-center gap-1 text-xs ${OUTCOME_COLORS[key] || "text-muted-foreground"}`}>
                                  {Icon && <Icon size={11}/>}
                                  {OUTCOME_LABELS[key]} <span className="font-bold">{val}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          {/* ─── PIPELINE ─────────────────────────────────────────────────────── */}
          <TabsContent value="pipeline" className="mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-foreground flex items-center gap-2"><Layers size={14} className="text-primary"/>Live Pipeline</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Every lead from the depot, grouped by stage</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["/api/admin/pipeline"] })} className="gap-1 text-xs text-muted-foreground">
                <RefreshCw size={11}/>Refresh
              </Button>
            </div>

            {pipelineLoading ? (
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {Array(8).fill(0).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
              </div>
            ) : (
              <>
                {/* Stage summary cards */}
                <div className="grid gap-2 grid-cols-2 md:grid-cols-4 lg:grid-cols-4">
                  {pipelineStages.map(stage => (
                    <div key={stage.key} className={`rounded-xl border px-4 py-3 ${stage.bg}`}>
                      <div className={`text-xl font-bold ${stage.color}`}>{(byStatus[stage.key] || []).length}</div>
                      <div className="text-xs text-muted-foreground font-medium mt-0.5">{stage.label}</div>
                    </div>
                  ))}
                </div>

                {/* Active leads flowing through */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Active Leads in Flow</p>
                  <div className="space-y-1.5">
                    {(pipeline?.leads || [])
                      .filter((l: any) => ["unassigned","assigned","no_answer","left_voicemail","callback_requested"].includes(l.status))
                      .slice(0, 50)
                      .map((lead: any) => (
                        <div key={lead.id} className="bg-card border border-border rounded-lg px-4 py-2.5 flex items-center gap-3" data-testid={`row-pipeline-${lead.id}`}>
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
                            {lead.phone && <span className="text-white/60 flex items-center gap-1"><Phone size={10}/>{lead.phone}</span>}
                            {lead.assignedAgentName && <span className="text-muted-foreground">{lead.assignedAgentName}</span>}
                            {lead.callbackDate && <span className="text-cyan-400">CB: {lead.callbackDate}</span>}
                          </div>
                        </div>
                      ))}
                    {(pipeline?.leads || []).filter((l: any) => ["unassigned","assigned","no_answer","left_voicemail","callback_requested"].includes(l.status)).length === 0 && (
                      <div className="py-8 text-center text-sm text-muted-foreground border border-dashed border-border rounded-xl">No active leads in queue. Upload a CSV to populate the pipeline.</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </TabsContent>

          {/* ─── ALL LEADS ─────────────────────────────────────────────────────── */}
          <TabsContent value="leads" className="mt-4 space-y-3">
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
                  <SelectItem value="left_voicemail">Left Voicemail</SelectItem>
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
              <div className="py-12 text-center text-muted-foreground text-sm border border-dashed border-border rounded-xl">No leads found.</div>
            ) : (
              <div className="space-y-1.5">
                {filteredLeads.map((lead: any) => (
                  <div key={lead.id} className="bg-card border border-border rounded-lg px-4 py-3 flex items-center gap-4" data-testid={`row-lead-${lead.id}`}>
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

          {/* ─── UPLOAD ──────────────────────────────────────────────────────────── */}
          <TabsContent value="upload" className="mt-4">
            <div className="max-w-lg space-y-6">
              <div>
                <h2 className="text-base font-semibold text-foreground mb-1">Upload Lead CSV</h2>
                <p className="text-sm text-muted-foreground">Leads auto-distribute to agents via round-robin the moment they're uploaded.</p>
              </div>

              {/* Clear Queue */}
              <div className="bg-red-950/20 border border-red-900/30 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Trash size={13} className="text-red-400"/>
                  <p className="text-sm font-semibold text-red-300">Clear Active Queue</p>
                </div>
                <p className="text-xs text-muted-foreground">Retires all active leads from the queue so you can load a fresh batch. Master records and full history are preserved — no data is deleted.</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-900/40 text-red-400 hover:bg-red-900/20 hover:text-red-300 text-xs gap-1.5"
                  onClick={() => {
                    if (confirm("Clear the active queue? All in-progress leads will be marked Retired. Their history and master records are kept — only the active queue is cleared.")) {
                      clearQueueMutation.mutate();
                    }
                  }}
                  disabled={clearQueueMutation.isPending}
                  data-testid="button-clear-queue"
                >
                  <Trash size={11}/>{clearQueueMutation.isPending ? "Clearing…" : "Clear Queue & Load New Batch"}
                </Button>
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
                        className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${uploadType === key ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-foreground/70 border-border hover:border-primary/50"}`}
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
                      <div className="space-y-1"><Label className="text-xs text-foreground/70">Email</Label><Input value={websiteLeadForm.email} onChange={e => setWebsiteLeadForm(p => ({...p, email: e.target.value}))} className="bg-secondary border-border" placeholder="brad24utd@gmail.com" data-testid="input-wl-email" /></div>
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
                    <Button onClick={handleSubmitWebsiteLead} disabled={submittingWebsiteLead} className="w-full bg-primary text-primary-foreground" data-testid="button-submit-website-lead">
                      {submittingWebsiteLead ? "Submitting…" : "Add Website Lead & Assign"}
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label className="text-sm text-foreground/80">CSV File</Label>
                      <div className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-primary/50 transition-colors" onClick={() => fileRef.current?.click()}>
                        <Upload className="mx-auto mb-2 text-muted-foreground" size={24} />
                        <p className="text-sm text-muted-foreground">{uploading ? "Uploading…" : "Click to select a CSV file"}</p>
                        <p className="text-xs text-muted-foreground/50 mt-1">Expected columns: Address, Owner Name, Phone, Email, Motivation</p>
                      </div>
                      <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} data-testid="input-csv-file" />
                    </div>
                    <div className="bg-secondary border border-border rounded-xl p-4 space-y-2">
                      <p className="text-xs font-semibold text-foreground/60 uppercase tracking-wider">Recognized Column Names</p>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                        <span><span className="text-white/50">address</span> / Address / Property Address</span>
                        <span><span className="text-white/50">ownerName</span> / Owner Name / name</span>
                        <span><span className="text-white/50">phone</span> / Phone / Phone Number</span>
                        <span><span className="text-white/50">email</span> / Email</span>
                        <span><span className="text-white/50">motivation</span> / Motivation</span>
                        <span className="text-muted-foreground/40">All other columns preserved</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </TabsContent>

          {/* ─── AGENTS ──────────────────────────────────────────────────────────── */}
          <TabsContent value="agents" className="mt-4 space-y-5">

            {/* Admin as Agent section — single All Leads toggle */}
            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <UserCheck size={14} className="text-primary"/>
                <h3 className="text-sm font-bold text-foreground">Admin Lead Receiving</h3>
                <span className="text-xs text-muted-foreground">— toggle to join the round-robin for all lead types</span>
              </div>
              {agents.filter(a => a.role === "admin").map((admin) => (
                <div key={admin.id} className="flex items-center justify-between bg-secondary/50 border border-border rounded-lg px-4 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-foreground">{admin.name}</p>
                    <p className="text-xs text-muted-foreground">{admin.email}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[10px] text-muted-foreground">All Leads</span>
                      <button
                        onClick={() => toggleReceiveLeadsMutation.mutate({ id: admin.id, receiveLeads: !admin.receiveLeads })}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors border ${admin.receiveLeads ? "bg-green-500/20 border-green-500/40" : "bg-secondary border-border"}`}
                        title={admin.receiveLeads ? "Receiving all leads — click to opt out" : "Not in rotation — click to opt in"}
                        data-testid={`toggle-receive-leads-${admin.id}`}
                      >
                        <span className={`inline-block h-3 w-3 transform rounded-full transition-transform ${admin.receiveLeads ? "translate-x-5 bg-green-400" : "translate-x-1 bg-muted-foreground"}`}/>
                      </button>
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
                        <h2 className="text-base font-semibold text-foreground">Agents</h2>
                        <p className="text-sm text-muted-foreground">Round-robin: top → bottom. Flow off = Inactive (removed from rotation &amp; leaderboard). Trash = moves to Inactive section.</p>
                      </div>
                      <Dialog open={agentDialogOpen} onOpenChange={setAgentDialogOpen}>
                        <DialogTrigger asChild>
                          <Button size="sm" className="gap-1.5 bg-primary text-primary-foreground text-xs" data-testid="button-add-agent"><Plus size={12}/>Add Agent</Button>
                        </DialogTrigger>
                        <DialogContent className="bg-card border-border">
                          <DialogHeader><DialogTitle className="text-foreground">Add Agent</DialogTitle></DialogHeader>
                          <div className="space-y-3 mt-2">
                            <div className="space-y-1">
                              <Label className="text-xs text-foreground/70">Full Name</Label>
                              <Input value={newAgent.name} onChange={e => setNewAgent(p => ({...p, name: e.target.value}))} className="bg-secondary border-border" placeholder="Jane Smith" data-testid="input-agent-name"/>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs text-foreground/70">Email</Label>
                              <Input type="email" value={newAgent.email} onChange={e => setNewAgent(p => ({...p, email: e.target.value}))} className="bg-secondary border-border" placeholder="jane@watsonbrothersgroup.com" data-testid="input-agent-email"/>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs text-foreground/70">Password</Label>
                              <Input type="text" value={newAgent.password} onChange={e => setNewAgent(p => ({...p, password: e.target.value}))} className="bg-secondary border-border" placeholder="Set their initial password" data-testid="input-agent-password"/>
                            </div>
                            <Button className="w-full bg-primary text-primary-foreground" onClick={() => createAgentMutation.mutate({ ...newAgent, role: "agent" })} disabled={createAgentMutation.isPending || !newAgent.name || !newAgent.email || !newAgent.password} data-testid="button-save-agent">
                              {createAgentMutation.isPending ? "Adding…" : "Add Agent"}
                            </Button>
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
                            className={`border rounded-xl px-4 py-3 flex items-center gap-4 transition-all ${
                              flowActive ? "bg-card border-border" : "bg-secondary/30 border-border/50 opacity-70"
                            }`}
                            data-testid={`row-agent-${agent.id}`}
                          >
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border ${
                              flowActive ? "bg-primary/15 border-primary/30" : "bg-secondary border-border"
                            }`}>
                              <span className={`text-xs font-bold ${flowActive ? "text-primary" : "text-muted-foreground"}`}>{idx + 1}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground">{agent.name}</p>
                              <p className="text-xs text-muted-foreground">{agent.email}</p>
                            </div>
                            <div className="flex items-center gap-3">
                              {/* Flow toggle */}
                              <div className="flex flex-col items-center gap-0.5">
                                <span className="text-[10px] text-muted-foreground">Flow</span>
                                <button
                                  onClick={() => toggleLeadFlowMutation.mutate({ id: agent.id, leadFlowOn: !agent.leadFlowOn })}
                                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors border ${
                                    flowActive ? "bg-green-500/20 border-green-500/40" : "bg-secondary border-border"
                                  }`}
                                  title={flowActive ? "Flow ON — click to pause" : "Flow PAUSED — click to resume"}
                                  data-testid={`toggle-lead-flow-${agent.id}`}
                                >
                                  <span className={`inline-block h-3 w-3 transform rounded-full transition-transform ${
                                    flowActive ? "translate-x-5 bg-green-400" : "translate-x-1 bg-muted-foreground"
                                  }`}/>
                                </button>
                              </div>
                              {/* Website toggle — greyed/disabled when flow is off */}
                              <div className="flex flex-col items-center gap-0.5">
                                <span className="text-[10px] text-muted-foreground">Website</span>
                                <button
                                  onClick={() => {
                                    if (!flowActive) return;
                                    toggleWebsiteLeadsMutation.mutate({ id: agent.id, receiveWebsiteLeads: !agent.receiveWebsiteLeads });
                                  }}
                                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors border ${
                                    !flowActive
                                      ? "bg-secondary border-border opacity-30 cursor-not-allowed"
                                      : agent.receiveWebsiteLeads
                                      ? "bg-blue-500/20 border-blue-500/40"
                                      : "bg-secondary border-border"
                                  }`}
                                  title={!flowActive ? "Enable Flow first" : agent.receiveWebsiteLeads ? "Receiving website leads — click to disable" : "Not receiving website leads — click to enable"}
                                  data-testid={`toggle-website-leads-${agent.id}`}
                                >
                                  <span className={`inline-block h-3 w-3 transform rounded-full transition-transform ${
                                    agent.receiveWebsiteLeads && flowActive ? "translate-x-5 bg-blue-400" : "translate-x-1 bg-muted-foreground"
                                  }`}/>
                                </button>
                              </div>
                              {/* Badge driven by leadFlowOn */}
                              <Badge variant="outline" className={`text-xs ${
                                flowActive ? "text-green-400 border-green-400/30" : "text-red-400 border-red-400/30"
                              }`}>
                                {flowActive ? "Active" : "Inactive"}
                              </Badge>
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={() => deleteAgentMutation.mutate(agent.id)}
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
                        <div className="py-10 text-center text-sm text-muted-foreground border border-dashed border-border rounded-xl">No active agents yet. Add one above.</div>
                      )}
                    </div>
                  </div>

                  {/* Inactive Agents (soft-deleted via trash button) */}
                  {inactiveAgents.length > 0 && (
                    <div className="space-y-3">
                      <div>
                        <h2 className="text-base font-semibold text-foreground/50">Inactive Agents</h2>
                        <p className="text-sm text-muted-foreground">Removed from rotation. Re-activate to bring them back.</p>
                      </div>
                      <div className="space-y-2">
                        {inactiveAgents.map((agent) => (
                          <div
                            key={agent.id}
                            className="bg-secondary/20 border border-border/40 rounded-xl px-4 py-3 flex items-center gap-4 opacity-60"
                            data-testid={`row-inactive-agent-${agent.id}`}
                          >
                            <div className="w-7 h-7 rounded-full bg-secondary border border-border flex items-center justify-center shrink-0">
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

          {/* ─── SCRIPTS ────────────────────────────────────────────────────────────── */}
          <TabsContent value="scripts" className="mt-4">
            <ScriptEditor />
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
    </div>
  );
}
