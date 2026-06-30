import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  LogOut, Phone, Mail, MapPin, User, ChevronRight,
  PhoneOff, PhoneMissed, Calendar, XCircle, CheckCircle2,
  AlertTriangle, RotateCcw, Inbox, ScrollText, Home, Building2,
  DollarSign, BedDouble, Bath, Maximize2, ChevronDown, ChevronUp, ExternalLink
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Lead } from "@shared/schema";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LPMAMAB {
  location: string; price: string; motivation: string;
  agent: string; mortgage: string; appointment: string; buy: string;
}
const emptyLPMAMAB: LPMAMAB = {
  location: "", price: "", motivation: "", agent: "", mortgage: "", appointment: "", buy: "",
};

const lpmamabFields = [
  { key: "location",    label: "L — Location",     placeholder: "Where do they want to go?",           tip: "Destination after sale" },
  { key: "price",       label: "P — Price",         placeholder: "Listed at? Need to net?",              tip: "List price vs. expectations" },
  { key: "motivation",  label: "M — Motivation",    placeholder: "Why are they selling?",                tip: "Job, divorce, downsizing, stress?" },
  { key: "agent",       label: "A — Agent",         placeholder: "Had an agent? What happened?",         tip: "Previous agent relationship?" },
  { key: "mortgage",    label: "M — Mortgage",      placeholder: "What do they owe?",                    tip: "Balance and equity position" },
  { key: "appointment", label: "A — Appointment",   placeholder: "When can we meet?",                    tip: "Availability for listing appt" },
  { key: "buy",         label: "B — Buy",           placeholder: "Do they need to buy after selling?",   tip: "Buyer lead opportunity" },
];

const outcomeButtons = [
  { outcome: "contacted_appointment",    label: "Appointment Set",   icon: CheckCircle2, cls: "bg-green-600/20 text-green-300 border-green-600/40 hover:bg-green-600/30" },
  { outcome: "contacted_not_interested", label: "Not Interested",    icon: XCircle,      cls: "bg-red-600/20 text-red-300 border-red-600/40 hover:bg-red-600/30" },
  { outcome: "no_answer",                label: "No Answer",         icon: PhoneMissed,  cls: "bg-yellow-600/20 text-yellow-200/80 border-yellow-600/30 hover:bg-yellow-600/30" },
  { outcome: "left_voicemail",           label: "Left Voicemail",    icon: PhoneOff,     cls: "bg-purple-600/20 text-purple-300 border-purple-600/40 hover:bg-purple-600/30" },
  { outcome: "callback_requested",       label: "Callback",          icon: Calendar,     cls: "bg-cyan-600/20 text-cyan-300 border-cyan-600/40 hover:bg-cyan-600/30" },
  { outcome: "wrong_number",             label: "Wrong Number",      icon: AlertTriangle,cls: "bg-red-900/20 text-red-400 border-red-900/40 hover:bg-red-900/30" },
];

// ── Script Panel ──────────────────────────────────────────────────────────────

function ScriptPanel({ leadType }: { leadType: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<{ content: string }>({
    queryKey: ["/api/scripts", leadType],
    queryFn: () => apiRequest("GET", `/api/scripts/${leadType}`).then(r => r.json()),
    enabled: open,
    staleTime: Infinity,
  });

  const scriptLabels: Record<string, { label: string; color: string }> = {
    expired:      { label: "Expired Listing Script",    color: "text-orange-400" },
    distressed:   { label: "Distressed Property Script",color: "text-red-400" },
    website_lead: { label: "Website Lead Script",       color: "text-blue-400" },
    fsbo:         { label: "FSBO Script",               color: "text-violet-400" },
    land:         { label: "Land / Vacant Lot Script",  color: "text-emerald-400" },
  };
  const scriptMeta = scriptLabels[leadType] || { label: "Call Script", color: "text-muted-foreground" };

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-secondary/50 transition-colors"
        onClick={() => setOpen(p => !p)}
        data-testid="button-toggle-script"
      >
        <span className="flex items-center gap-2.5">
          <ScrollText size={14} className={scriptMeta.color} />
          <span className="text-sm font-semibold text-foreground">
            {scriptMeta.label}
          </span>
          <span className="text-xs text-muted-foreground hidden sm:inline">— tap to view during your call</span>
        </span>
        {open ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
      </button>

      {open && (
        <div className="border-t border-border px-5 py-4">
          {isLoading ? (
            <div className="space-y-2">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-4 rounded" />)}</div>
          ) : (
            <pre className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed font-mono bg-secondary/40 rounded-lg p-4 border border-border overflow-x-auto max-h-[420px] overflow-y-auto">
              {data?.content || "Script not available."}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Property Details ──────────────────────────────────────────────────────────

function PropertyDetails({ lead }: { lead: Lead }) {
  let extra: Record<string, string> = {};
  try { extra = JSON.parse(lead.extraData || "{}"); } catch {}

  const price = extra["Price"] || extra["price"] || extra["Listing Price"] || "";
  const beds  = extra["Beds"]  || extra["beds"]  || "";
  const baths = extra["Baths"] || extra["baths"] || "";
  const sqft  = extra["Square Footage"] || extra["square_footage"] || extra["Sqft"] || "";

  const details = [
    price && { icon: DollarSign, label: "List Price", value: `$${Number(price.replace(/[^0-9.]/g,'')).toLocaleString()}` },
    beds  && { icon: BedDouble,  label: "Beds",       value: beds },
    baths && { icon: Bath,       label: "Baths",      value: baths },
    sqft  && { icon: Maximize2,  label: "Sq Ft",      value: Number(sqft).toLocaleString() },
  ].filter(Boolean) as { icon: any; label: string; value: string }[];

  if (!details.length) return null;

  return (
    <div className="flex flex-wrap gap-3">
      {details.map(d => (
        <div key={d.label} className="flex items-center gap-1.5 bg-secondary/60 border border-border rounded-lg px-3 py-1.5 text-xs">
          <d.icon size={11} className="text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">{d.label}:</span>
          <span className="font-semibold text-foreground">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Additional Contact Numbers ────────────────────────────────────────────────

function AdditionalContacts({ lead }: { lead: Lead }) {
  let extra: Record<string, string> = {};
  try { extra = JSON.parse(lead.extraData || "{}"); } catch {}

  const contacts: { name: string; phone: string; dnc: boolean }[] = [];
  for (let i = 1; i <= 4; i++) {
    const fn   = extra[`LandvoiceContact${i}FirstName`] || "";
    const ln   = extra[`LandvoiceContact${i}LastName`]  || "";
    const ph   = extra[`LandvoiceContact${i}Phone`]     || "";
    const dnc  = (extra[`LandvoiceContact${i}DNC`] || "").toLowerCase() === "yes";
    if (ph && ph !== lead.phone) {
      contacts.push({ name: [fn, ln].filter(Boolean).join(" ") || "Contact", phone: ph, dnc });
    }
  }
  const secondary = extra["Secondary Phone"] || "";
  if (secondary && secondary !== lead.phone) {
    contacts.unshift({ name: "Secondary", phone: secondary, dnc: false });
  }

  if (!contacts.length) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Additional Numbers</p>
      <div className="flex flex-wrap gap-2">
        {contacts.map((c, i) => (
          <div key={i} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 border text-xs ${c.dnc ? "bg-red-900/15 border-red-900/30 opacity-60" : "bg-secondary/60 border-border"}`}>
            <Phone size={10} className={c.dnc ? "text-red-400" : "text-muted-foreground"} />
            <span className="text-muted-foreground">{c.name}:</span>
            {c.dnc ? (
              <span className="text-red-400 font-medium">{c.phone} <span className="opacity-70">(DNC)</span></span>
            ) : (
              <a href={`tel:${c.phone}`} className="text-white/70 hover:text-white/60 font-medium">{c.phone}</a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    expired: "Expired Listing", distressed: "Distressed", website_lead: "Website Lead", fsbo: "FSBO", land: "Land",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider type-${type}`}>
      {labels[type] || type}
    </span>
  );
}

export default function AgentView() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [lpmamab, setLpmamab] = useState<LPMAMAB>(emptyLPMAMAB);
  const [notes, setNotes] = useState("");
  const [callbackDate, setCallbackDate] = useState("");
  const [pendingOutcome, setPendingOutcome] = useState<string | null>(null);
  const [showLPMAMAB, setShowLPMAMAB] = useState(false);

  const { data, isLoading, refetch } = useQuery<{ lead: Lead | null; totalActive: number }>({
    queryKey: ["/api/leads/my", user?.id],
    queryFn: () => apiRequest("GET", `/api/leads/my/${user?.id}`).then(r => r.json()),
    enabled: !!user?.id,
    refetchOnWindowFocus: false,
  });

  const lead = data?.lead ?? null;
  const totalActive = data?.totalActive ?? 0;

  const outcomeMutation = useMutation({
    mutationFn: (vars: any) =>
      apiRequest("POST", `/api/leads/${vars.leadId}/outcome`, {
        agentId: user?.id, outcome: vars.outcome, notes: vars.notes,
        lpmamab: vars.lpmamab, callbackDate: vars.callbackDate,
      }).then(r => r.json()),
    onSuccess: (_, vars) => {
      const btn = outcomeButtons.find(b => b.outcome === vars.outcome);
      const recycled = ["no_answer", "left_voicemail"].includes(vars.outcome);
      toast({
        title: btn?.label || "Outcome saved",
        description: recycled ? "Lead recycled to queue." : vars.outcome === "contacted_appointment" ? "Great work — appointment set!" : "Moving to next lead…",
      });
      setLpmamab(emptyLPMAMAB);
      setNotes(""); setCallbackDate(""); setPendingOutcome(null); setShowLPMAMAB(false);
      qc.invalidateQueries({ queryKey: ["/api/leads/my", user?.id] });
    },
    onError: () => toast({ title: "Error saving outcome", variant: "destructive" }),
  });

  const handleOutcome = (outcome: string) => {
    if (!lead) return;
    if (outcome === "callback_requested" && !callbackDate) { setPendingOutcome("callback_requested"); return; }
    outcomeMutation.mutate({ leadId: lead.id, outcome, notes, lpmamab, callbackDate });
  };

  const setField = (key: keyof LPMAMAB, val: string) => setLpmamab(p => ({ ...p, [key]: val }));

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <svg width="28" height="28" viewBox="0 0 52 52" fill="none">
            <rect width="52" height="52" rx="10" fill="white" />
            <path d="M8 36V22L26 12L44 22V36H8Z" fill="#171717" />
            <rect x="21" y="26" width="10" height="10" rx="1" fill="white" opacity="0.9"/>
            <path d="M26 17V23M23 20L26 23L29 20" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div>
            <span className="text-sm font-bold text-foreground">Lead Depot</span>
            <span className="text-xs text-muted-foreground ml-2">— {user?.name}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {totalActive > 0 && (
            <span className="text-xs bg-secondary border border-border rounded-full px-2.5 py-1 text-muted-foreground">
              <span className="text-white/70 font-bold">{totalActive}</span> in queue
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={logout} className="gap-1.5 text-muted-foreground text-xs">
            <LogOut size={13}/> Sign out
          </Button>
        </div>
      </header>

      <main className="p-4 max-w-2xl mx-auto">
        {isLoading ? (
          <div className="mt-8 space-y-4">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-56 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
          </div>
        ) : !lead ? (
          <div className="mt-16 flex flex-col items-center text-center gap-4">
            <div className="w-16 h-16 rounded-full bg-secondary border border-border flex items-center justify-center">
              <Inbox className="text-muted-foreground" size={28} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Queue is empty</h2>
              <p className="text-sm text-muted-foreground mt-1">No leads assigned yet. Check back soon.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5 border-border text-xs mt-2">
              <RotateCcw size={12}/> Check for leads
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">

            {/* ── Lead Card ─────────────────────────────────────── */}
            <div className="lead-active-glow bg-card border border-border rounded-xl p-5 space-y-4" data-testid="card-current-lead">
              {/* Type + attempt */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <TypeBadge type={lead.leadType} />
                  {lead.attemptCount > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground">
                      Attempt #{lead.attemptCount + 1}
                    </span>
                  )}
                </div>
              </div>

              {/* Owner */}
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <User size={14} className="text-primary shrink-0" />
                  <h2 className="text-lg font-bold text-foreground leading-tight">{lead.ownerName || "Unknown Owner"}</h2>
                </div>
                <p className="text-sm text-muted-foreground flex items-center gap-1.5 ml-0.5">
                  <MapPin size={12} className="shrink-0"/>
                  {lead.address}{lead.extraData && (() => { try { const e = JSON.parse(lead.extraData); return e.City ? `, ${e.City}, ${e.State || ""}` : ""; } catch { return ""; }})()}
                </p>
              </div>

              {/* Property details */}
              <PropertyDetails lead={lead} />

              {/* Zillow link */}
              {lead.address && (() => {
                let extra: Record<string, string> = {};
                try { extra = JSON.parse(lead.extraData || "{}"); } catch {}
                const city  = extra["City"]  || extra["city"]  || "";
                const state = extra["State"] || extra["state"] || "FL";
                const zip   = extra["Zip"]   || extra["zip"]   || extra["ZipCode"] || "";
                const fullAddress = [lead.address, city, state, zip].filter(Boolean).join(" ");
                const zillowUrl = `https://www.zillow.com/homes/${encodeURIComponent(fullAddress)}_rb/`;
                return (
                  <a
                    href={zillowUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#006AFF] hover:text-[#0056cc] transition-colors bg-[#006AFF]/10 hover:bg-[#006AFF]/20 border border-[#006AFF]/30 rounded-lg px-3 py-1.5"
                    data-testid="link-zillow"
                  >
                    <ExternalLink size={11} />
                    View on Zillow
                  </a>
                );
              })()}

              {/* Primary contact */}
              <div className="flex flex-wrap gap-3">
                {lead.phone && (
                  <a href={`tel:${lead.phone}`} className="flex items-center gap-1.5 text-sm font-semibold text-white/70 hover:text-white/60 transition-colors" data-testid="link-phone">
                    <Phone size={14}/> {lead.phone}
                  </a>
                )}
                {lead.email && (
                  <a href={`mailto:${lead.email}`} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-email">
                    <Mail size={14}/> {lead.email}
                  </a>
                )}
              </div>

              {/* Additional contact numbers from Landvoice */}
              <AdditionalContacts lead={lead} />

              {/* Motivation */}
              {lead.motivation && (
                <div className="bg-secondary/60 rounded-lg px-3 py-2.5 border border-border">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1 font-semibold">Motivation / Notes</p>
                  <p className="text-sm text-foreground leading-relaxed">{lead.motivation}</p>
                </div>
              )}
            </div>

            {/* ── Call Script ───────────────────────────────────── */}
            <ScriptPanel leadType={lead.leadType} />

            {/* ── LPMAMAB ───────────────────────────────────────── */}
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <button
                className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-secondary/50 transition-colors"
                onClick={() => setShowLPMAMAB(p => !p)}
                data-testid="button-toggle-lpmamab"
              >
                <span className="flex items-center gap-2.5">
                  <span className="text-xs font-black tracking-widest text-primary">LPMAMAB</span>
                  <span className="text-xs text-muted-foreground hidden sm:inline">— gather during the call</span>
                </span>
                {showLPMAMAB ? <ChevronUp size={14} className="text-muted-foreground"/> : <ChevronDown size={14} className="text-muted-foreground"/>}
              </button>
              {showLPMAMAB && (
                <div className="border-t border-border px-5 pb-5 pt-4 space-y-3">
                  {lpmamabFields.map(f => (
                    <div key={f.key} className="space-y-1">
                      <div className="flex items-baseline gap-2">
                        <Label className="text-xs font-bold text-foreground/80">{f.label}</Label>
                        <span className="text-xs text-muted-foreground/50">{f.tip}</span>
                      </div>
                      <Input
                        value={lpmamab[f.key as keyof LPMAMAB]}
                        onChange={e => setField(f.key as keyof LPMAMAB, e.target.value)}
                        placeholder={f.placeholder}
                        className="bg-secondary border-border text-sm"
                        data-testid={`input-lpmamab-${f.key}`}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Call Notes ────────────────────────────────────── */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Call Notes</Label>
              <Textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Anything from the conversation worth noting…"
                className="bg-card border-border text-sm resize-none min-h-[72px]"
                data-testid="textarea-notes"
              />
            </div>

            {/* ── Callback date (inline) ────────────────────────── */}
            {pendingOutcome === "callback_requested" && (
              <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-xl p-4 space-y-3">
                <p className="text-sm font-semibold text-cyan-300">When should we call back?</p>
                <div className="flex items-center gap-3 flex-wrap">
                  <Input
                    type="date"
                    value={callbackDate}
                    onChange={e => setCallbackDate(e.target.value)}
                    className="bg-secondary border-border text-sm w-44"
                    data-testid="input-callback-date"
                  />
                  <Button size="sm" onClick={() => outcomeMutation.mutate({ leadId: lead.id, outcome: "callback_requested", notes, lpmamab, callbackDate })}
                    disabled={!callbackDate} className="bg-cyan-600 text-white hover:bg-cyan-500 text-xs">
                    Confirm
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPendingOutcome(null)} className="text-xs text-muted-foreground">Cancel</Button>
                </div>
              </div>
            )}

            {/* ── Outcome Buttons ───────────────────────────────── */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Log Outcome</p>
              <div className="grid grid-cols-2 gap-2">
                {outcomeButtons.map(btn => {
                  const Icon = btn.icon;
                  return (
                    <button
                      key={btn.outcome}
                      onClick={() => handleOutcome(btn.outcome)}
                      disabled={outcomeMutation.isPending}
                      className={`flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-semibold transition-colors ${btn.cls} disabled:opacity-50`}
                      data-testid={`button-outcome-${btn.outcome}`}
                    >
                      <Icon size={15}/> {btn.label}
                    </button>
                  );
                })}
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}
