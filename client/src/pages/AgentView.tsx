import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  LogOut, Phone, Mail, MapPin, User,
  PhoneOff, PhoneMissed, Calendar, XCircle, CheckCircle2,
  AlertTriangle, RotateCcw, Inbox, ScrollText,
  DollarSign, BedDouble, Bath, Maximize2, ChevronDown, ChevronUp,
  PhoneCall, PhoneIncoming, ClipboardList
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Lead } from "@shared/schema";

// ── Types ─────────────────────────────────────────────────────────────────────

type CallStep =
  | "idle"           // before call is initiated
  | "calling"        // call in progress (phone was clicked)
  | "result_root"    // connected or not?
  | "connected_pick" // listing appt / keep in touch / declined
  | "appt_details"   // listing appt details
  | "kit_details"    // keep in touch details
  | "no_connect";    // not connected — recycle confirmation

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

// ── Script Panel ──────────────────────────────────────────────────────────────

function ScriptPanel({ leadType }: { leadType: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<{ content: string }>({
    queryKey: ["/api/scripts", leadType],
    queryFn: () => apiRequest("GET", `/api/scripts/${leadType}`).then(r => r.json()),
    enabled: open,
    staleTime: Infinity,
  });

  const isExpired = leadType === "expired" || leadType === "distressed" || leadType === "land";

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-secondary/50 transition-colors"
        onClick={() => setOpen(p => !p)}
        data-testid="button-toggle-script"
      >
        <span className="flex items-center gap-2.5">
          <ScrollText size={14} className={isExpired ? "text-orange-400" : "text-violet-400"} />
          <span className="text-sm font-semibold text-foreground">
            {leadType === "expired" ? "Expired Listing Script" : leadType === "distressed" ? "Distressed Lead Script" : leadType === "land" ? "Land Lead Script" : "Lead Script"}
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

function AdditionalContacts({ lead, onPhoneClick }: { lead: Lead; onPhoneClick: (phone: string) => void }) {
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
              <a
                href={`tel:${c.phone}`}
                onClick={() => onPhoneClick(c.phone)}
                className="text-white/70 hover:text-white/60 font-medium"
              >{c.phone}</a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Type Badge ────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  const label =
    type === "expired"     ? "Source: Expired"    :
    type === "distressed"  ? "Source: Distressed" :
    type === "website_lead"? "Source: Website"    :
    type === "land"        ? "Source: Land"       : "Source: Unknown";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider type-${type}`}>
      {label}
    </span>
  );
}

// ── Outcome helpers ──────────────────────────────────────────────────────────

const OUTCOME_META: Record<string, { label: string; color: string; dot: string }> = {
  contacted_appointment: { label: "Appt Won",      color: "text-green-300",  dot: "bg-green-400" },
  keep_in_touch:         { label: "Keep In Touch", color: "text-cyan-300",   dot: "bg-cyan-400" },
  declined_service:      { label: "Declined",      color: "text-red-300",    dot: "bg-red-400" },
  no_answer:             { label: "No Answer",     color: "text-yellow-300", dot: "bg-yellow-400" },
  left_voicemail:        { label: "Voicemail",     color: "text-orange-300", dot: "bg-orange-400" },
};

function outcomeDisplay(outcome: string) {
  return OUTCOME_META[outcome] ?? { label: outcome, color: "text-muted-foreground", dot: "bg-muted-foreground" };
}

function formatHistoryTime(iso: string) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const today = new Date();
    const isToday =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth()    === today.getMonth()    &&
      d.getDate()     === today.getDate();
    if (isToday) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch { return iso; }
}

// ── Activity History Panel ────────────────────────────────────────────────────

interface HistoryEntry {
  activityId: number;
  leadId: number;
  ownerName: string | null;
  address: string;
  outcome: string;
  notes: string | null;
  createdAt: string;
}

function ActivityHistory({ agentId }: { agentId: number }) {
  const { data, isLoading } = useQuery<{ history: HistoryEntry[] }>({
    queryKey: ["/api/leads/my-history", agentId],
    queryFn: () => apiRequest("GET", `/api/leads/my-history/${agentId}`).then(r => r.json()),
    enabled: !!agentId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const history = data?.history ?? [];

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden" data-testid="panel-activity-history">
      <div className="px-5 py-3.5 flex items-center gap-2.5 border-b border-border">
        <ClipboardList size={14} className="text-primary shrink-0" />
        <span className="text-sm font-semibold text-foreground">My Activity</span>
        {history.length > 0 && (
          <span className="ml-auto text-xs bg-secondary border border-border rounded-full px-2 py-0.5 text-muted-foreground">
            {history.length}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="px-5 py-4 space-y-2">
          {Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
        </div>
      ) : history.length === 0 ? (
        <div className="px-5 py-6 text-center">
          <p className="text-sm text-muted-foreground">No activity logged yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2.5 text-muted-foreground font-semibold uppercase tracking-wider whitespace-nowrap">Name</th>
                  <th className="text-left px-4 py-2.5 text-muted-foreground font-semibold uppercase tracking-wider whitespace-nowrap hidden sm:table-cell">Address</th>
                  <th className="text-left px-4 py-2.5 text-muted-foreground font-semibold uppercase tracking-wider whitespace-nowrap">Outcome</th>
                  <th className="text-right px-4 py-2.5 text-muted-foreground font-semibold uppercase tracking-wider whitespace-nowrap">Time</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row, i) => {
                  const meta = outcomeDisplay(row.outcome);
                  return (
                    <tr
                      key={row.activityId}
                      className={`border-b border-border/50 hover:bg-secondary/30 transition-colors ${
                        i === 0 ? "bg-secondary/20" : ""
                      }`}
                    >
                      <td className="px-4 py-3 font-medium text-foreground whitespace-nowrap max-w-[140px] truncate">
                        {row.ownerName || <span className="text-muted-foreground italic">Unknown</span>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell max-w-[180px] truncate">
                        {row.address}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`flex items-center gap-1.5 font-semibold ${meta.color}`}>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${meta.dot}`} />
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground whitespace-nowrap">
                        {formatHistoryTime(row.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Call Results Modal ────────────────────────────────────────────────────────

interface CallResultsModalProps {
  lead: Lead;
  open: boolean;
  onClose: () => void;
  onSubmit: (vars: any) => void;
  isPending: boolean;
}

function CallResultsModal({ lead, open, onClose, onSubmit, isPending }: CallResultsModalProps) {
  const [step, setStep] = useState<CallStep>("result_root");
  const [connected, setConnected] = useState<"connected" | "not_connected" | "">("");
  const [connectedOutcome, setConnectedOutcome] = useState<"listing_appt" | "keep_in_touch" | "declined" | "">("");

  // Listing appt fields
  const [apptDateTime, setApptDateTime] = useState("");
  const [apptTime, setApptTime] = useState("");
  const [apptAtProperty, setApptAtProperty] = useState<"yes" | "no" | "">("");
  const [apptNotes, setApptNotes] = useState("");
  const [lpmamab, setLpmamab] = useState<LPMAMAB>(emptyLPMAMAB);
  const [showLPMAMAB, setShowLPMAMAB] = useState(false);

  // Keep in touch fields
  const [kitEmail, setKitEmail] = useState(lead.email || "");
  const [kitNotes, setKitNotes] = useState("");
  const [kitTempo, setKitTempo] = useState("");
  const [kitLpmamab, setKitLpmamab] = useState<LPMAMAB>(emptyLPMAMAB);
  const [kitShowLPMAMAB, setKitShowLPMAMAB] = useState(false);

  const setField = (key: keyof LPMAMAB, val: string) => setLpmamab(p => ({ ...p, [key]: val }));
  const setKitField = (key: keyof LPMAMAB, val: string) => setKitLpmamab(p => ({ ...p, [key]: val }));

  const handleRootNext = () => {
    if (connected === "connected") setStep("connected_pick");
    else if (connected === "not_connected") setStep("no_connect");
  };

  const handleConnectedNext = () => {
    if (connectedOutcome === "listing_appt") setStep("appt_details");
    else if (connectedOutcome === "keep_in_touch") setStep("kit_details");
    else if (connectedOutcome === "declined") {
      // Declined — delete lead, no CRM
      onSubmit({ leadId: lead.id, outcome: "declined_service", notes: "", lpmamab: null, sendToCRM: false });
    }
  };

  const handleApptSubmit = () => {
    const dateTimeStr = apptDateTime && apptTime ? `${apptDateTime} at ${apptTime}` : apptDateTime || apptTime || "";
    onSubmit({
      leadId: lead.id,
      outcome: "contacted_appointment",
      notes: apptNotes,
      lpmamab,
      apptDetails: {
        dateTime: dateTimeStr,
        atProperty: apptAtProperty === "yes",
        address: lead.address,
      },
      sendToCRM: true,
    });
  };

  const handleKITSubmit = () => {
    onSubmit({
      leadId: lead.id,
      outcome: "keep_in_touch",
      notes: kitNotes,
      lpmamab: kitLpmamab,
      kitDetails: {
        email: kitEmail,
        tempo: kitTempo,
      },
      sendToCRM: true,
    });
  };

  const handleRecycle = () => {
    onSubmit({ leadId: lead.id, outcome: "no_answer", notes: "", lpmamab: null, sendToCRM: false });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isPending) onClose(); }}>
      <DialogContent className="bg-card border-border max-w-lg w-full max-h-[90vh] overflow-y-auto" data-testid="modal-call-results">

        {/* ── Step: Connected or Not? ─────────────────────────── */}
        {step === "result_root" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-foreground flex items-center gap-2">
                <PhoneIncoming size={18} className="text-primary" />
                Call Results
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground -mt-1">How did the call go with <span className="text-foreground font-semibold">{lead.ownerName || "this lead"}</span>?</p>
            <div className="space-y-3 mt-2">
              <button
                onClick={() => setConnected("connected")}
                className={`w-full flex items-center gap-3 px-4 py-4 rounded-xl border text-sm font-semibold transition-all ${connected === "connected" ? "bg-green-600/20 border-green-500/60 text-green-300" : "bg-secondary border-border text-foreground hover:bg-secondary/70"}`}
                data-testid="button-connected"
              >
                <PhoneCall size={18} className={connected === "connected" ? "text-green-400" : "text-muted-foreground"} />
                <div className="text-left">
                  <div>Connected</div>
                  <div className="text-xs font-normal opacity-70">I spoke with them</div>
                </div>
              </button>
              <button
                onClick={() => setConnected("not_connected")}
                className={`w-full flex items-center gap-3 px-4 py-4 rounded-xl border text-sm font-semibold transition-all ${connected === "not_connected" ? "bg-yellow-600/20 border-yellow-500/60 text-yellow-300" : "bg-secondary border-border text-foreground hover:bg-secondary/70"}`}
                data-testid="button-not-connected"
              >
                <PhoneMissed size={18} className={connected === "not_connected" ? "text-yellow-400" : "text-muted-foreground"} />
                <div className="text-left">
                  <div>Not Connected</div>
                  <div className="text-xs font-normal opacity-70">No answer, voicemail, hung up</div>
                </div>
              </button>
            </div>
            <Button
              onClick={handleRootNext}
              disabled={!connected || isPending}
              className="w-full mt-2 bg-primary text-primary-foreground hover:bg-primary/90"
              data-testid="button-next-root"
            >
              Next
            </Button>
          </>
        )}

        {/* ── Step: Connected — what happened? ───────────────── */}
        {step === "connected_pick" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-foreground flex items-center gap-2">
                <CheckCircle2 size={18} className="text-green-400" />
                Connected — What's the outcome?
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground -mt-1">Select the result of the conversation.</p>
            <div className="space-y-3 mt-2">
              <button
                onClick={() => setConnectedOutcome("listing_appt")}
                className={`w-full flex items-center gap-3 px-4 py-4 rounded-xl border text-sm font-semibold transition-all ${connectedOutcome === "listing_appt" ? "bg-green-600/20 border-green-500/60 text-green-300" : "bg-secondary border-border text-foreground hover:bg-secondary/70"}`}
                data-testid="button-listing-appt"
              >
                <Calendar size={18} className={connectedOutcome === "listing_appt" ? "text-green-400" : "text-muted-foreground"} />
                <div className="text-left">
                  <div>Listing Appointment Won</div>
                  <div className="text-xs font-normal opacity-70">They agreed to meet — set the details</div>
                </div>
              </button>
              <button
                onClick={() => setConnectedOutcome("keep_in_touch")}
                className={`w-full flex items-center gap-3 px-4 py-4 rounded-xl border text-sm font-semibold transition-all ${connectedOutcome === "keep_in_touch" ? "bg-cyan-600/20 border-cyan-500/60 text-cyan-300" : "bg-secondary border-border text-foreground hover:bg-secondary/70"}`}
                data-testid="button-keep-in-touch"
              >
                <PhoneOff size={18} className={connectedOutcome === "keep_in_touch" ? "text-cyan-400" : "text-muted-foreground"} />
                <div className="text-left">
                  <div>Keep In Touch</div>
                  <div className="text-xs font-normal opacity-70">Not ready now but wants follow-up</div>
                </div>
              </button>
              <button
                onClick={() => setConnectedOutcome("declined")}
                className={`w-full flex items-center gap-3 px-4 py-4 rounded-xl border text-sm font-semibold transition-all ${connectedOutcome === "declined" ? "bg-red-600/20 border-red-500/60 text-red-300" : "bg-secondary border-border text-foreground hover:bg-secondary/70"}`}
                data-testid="button-declined"
              >
                <XCircle size={18} className={connectedOutcome === "declined" ? "text-red-400" : "text-muted-foreground"} />
                <div className="text-left">
                  <div>Declined Services</div>
                  <div className="text-xs font-normal opacity-70">Not interested — remove from system</div>
                </div>
              </button>
            </div>
            <div className="flex gap-2 mt-2">
              <Button variant="ghost" size="sm" onClick={() => setStep("result_root")} className="text-muted-foreground text-xs">Back</Button>
              <Button
                onClick={handleConnectedNext}
                disabled={!connectedOutcome || isPending}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                data-testid="button-next-connected"
              >
                {connectedOutcome === "declined" ? "Remove Lead" : "Next"}
              </Button>
            </div>
          </>
        )}

        {/* ── Step: Listing Appointment Details ──────────────── */}
        {step === "appt_details" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-foreground flex items-center gap-2">
                <Calendar size={18} className="text-green-400" />
                Listing Appointment Details
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-1">
              {/* Date & Time */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Date</Label>
                  <Input
                    type="date"
                    value={apptDateTime}
                    onChange={e => setApptDateTime(e.target.value)}
                    className="bg-secondary border-border text-sm"
                    data-testid="input-appt-date"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Time</Label>
                  <Input
                    type="time"
                    value={apptTime}
                    onChange={e => setApptTime(e.target.value)}
                    className="bg-secondary border-border text-sm"
                    data-testid="input-appt-time"
                  />
                </div>
              </div>

              {/* Location confirm */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">
                  Meeting at subject property?
                </Label>
                <p className="text-xs text-foreground/70 bg-secondary/60 rounded-lg px-3 py-2 border border-border flex items-center gap-1.5">
                  <MapPin size={11} className="text-muted-foreground shrink-0" />
                  {lead.address}
                </p>
                <RadioGroup value={apptAtProperty} onValueChange={(v: any) => setApptAtProperty(v)} className="flex gap-4">
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="yes" id="at-prop-yes" data-testid="radio-at-property-yes" />
                    <Label htmlFor="at-prop-yes" className="text-sm cursor-pointer">Yes, at property</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="no" id="at-prop-no" data-testid="radio-at-property-no" />
                    <Label htmlFor="at-prop-no" className="text-sm cursor-pointer">Different location</Label>
                  </div>
                </RadioGroup>
              </div>

              {/* LPMAMAB */}
              <div className="bg-secondary/40 rounded-xl border border-border overflow-hidden">
                <button
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-secondary/60 transition-colors"
                  onClick={() => setShowLPMAMAB(p => !p)}
                  data-testid="button-toggle-lpmamab-appt"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-black tracking-widest text-primary">LPMAMAB</span>
                    <span className="text-xs text-muted-foreground">— notes from conversation</span>
                  </span>
                  {showLPMAMAB ? <ChevronUp size={13} className="text-muted-foreground" /> : <ChevronDown size={13} className="text-muted-foreground" />}
                </button>
                {showLPMAMAB && (
                  <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
                    {lpmamabFields.map(f => (
                      <div key={f.key} className="space-y-1">
                        <Label className="text-xs font-bold text-foreground/80">{f.label}</Label>
                        <Input
                          value={lpmamab[f.key as keyof LPMAMAB]}
                          onChange={e => setField(f.key as keyof LPMAMAB, e.target.value)}
                          placeholder={f.placeholder}
                          className="bg-background border-border text-sm"
                          data-testid={`input-lpmamab-appt-${f.key}`}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Notes / Tempo for CRM</Label>
                <Textarea
                  value={apptNotes}
                  onChange={e => setApptNotes(e.target.value)}
                  placeholder="Tone of conversation, key objections handled, what to know for the appointment…"
                  className="bg-secondary border-border text-sm resize-none min-h-[80px]"
                  data-testid="textarea-appt-notes"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <Button variant="ghost" size="sm" onClick={() => setStep("connected_pick")} className="text-muted-foreground text-xs">Back</Button>
              <Button
                onClick={handleApptSubmit}
                disabled={!apptDateTime || !apptAtProperty || isPending}
                className="flex-1 bg-green-600 text-white hover:bg-green-500"
                data-testid="button-submit-appt"
              >
                {isPending ? "Saving…" : "Save Appointment to CRM"}
              </Button>
            </div>
          </>
        )}

        {/* ── Step: Keep In Touch Details ────────────────────── */}
        {step === "kit_details" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-foreground flex items-center gap-2">
                <PhoneOff size={18} className="text-cyan-400" />
                Keep In Touch Details
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-1">
              {/* Email confirm */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">
                  Confirm Email Address
                </Label>
                <Input
                  type="email"
                  value={kitEmail}
                  onChange={e => setKitEmail(e.target.value)}
                  placeholder="their@email.com"
                  className="bg-secondary border-border text-sm"
                  data-testid="input-kit-email"
                />
                <p className="text-xs text-muted-foreground">Update if they provided a different address during the call.</p>
              </div>

              {/* Tempo */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Follow-up Tempo</Label>
                <Input
                  value={kitTempo}
                  onChange={e => setKitTempo(e.target.value)}
                  placeholder="e.g. Check back in 30 days, quarterly market update…"
                  className="bg-secondary border-border text-sm"
                  data-testid="input-kit-tempo"
                />
              </div>

              {/* LPMAMAB */}
              <div className="bg-secondary/40 rounded-xl border border-border overflow-hidden">
                <button
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-secondary/60 transition-colors"
                  onClick={() => setKitShowLPMAMAB(p => !p)}
                  data-testid="button-toggle-lpmamab-kit"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-black tracking-widest text-primary">LPMAMAB</span>
                    <span className="text-xs text-muted-foreground">— notes from conversation</span>
                  </span>
                  {kitShowLPMAMAB ? <ChevronUp size={13} className="text-muted-foreground" /> : <ChevronDown size={13} className="text-muted-foreground" />}
                </button>
                {kitShowLPMAMAB && (
                  <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
                    {lpmamabFields.map(f => (
                      <div key={f.key} className="space-y-1">
                        <Label className="text-xs font-bold text-foreground/80">{f.label}</Label>
                        <Input
                          value={kitLpmamab[f.key as keyof LPMAMAB]}
                          onChange={e => setKitField(f.key as keyof LPMAMAB, e.target.value)}
                          placeholder={f.placeholder}
                          className="bg-background border-border text-sm"
                          data-testid={`input-lpmamab-kit-${f.key}`}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Notes for CRM</Label>
                <Textarea
                  value={kitNotes}
                  onChange={e => setKitNotes(e.target.value)}
                  placeholder="Conversation notes, timeline, motivations, key things to remember for follow-up…"
                  className="bg-secondary border-border text-sm resize-none min-h-[80px]"
                  data-testid="textarea-kit-notes"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <Button variant="ghost" size="sm" onClick={() => setStep("connected_pick")} className="text-muted-foreground text-xs">Back</Button>
              <Button
                onClick={handleKITSubmit}
                disabled={isPending}
                className="flex-1 bg-cyan-600 text-white hover:bg-cyan-500"
                data-testid="button-submit-kit"
              >
                {isPending ? "Saving…" : "Save to CRM"}
              </Button>
            </div>
          </>
        )}

        {/* ── Step: Not Connected — recycle ──────────────────── */}
        {step === "no_connect" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-foreground flex items-center gap-2">
                <PhoneMissed size={18} className="text-yellow-400" />
                No Connection
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground mt-1">
              This lead will be <span className="text-foreground font-semibold">recycled back to the main queue</span> for future follow-up. It won't be sent to Follow Up Boss.
            </p>
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mt-2 text-sm text-yellow-200/80">
              <p className="font-semibold mb-0.5">Lead: {lead.ownerName || lead.address}</p>
              <p className="text-xs opacity-70">{lead.address}</p>
            </div>
            <div className="flex gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={() => setStep("result_root")} className="text-muted-foreground text-xs">Back</Button>
              <Button
                onClick={handleRecycle}
                disabled={isPending}
                className="flex-1 bg-yellow-600 text-white hover:bg-yellow-500"
                data-testid="button-recycle"
              >
                {isPending ? "Recycling…" : "Recycle Lead"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Main Agent View ───────────────────────────────────────────────────────────

export default function AgentView() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [callStep, setCallStep] = useState<CallStep>("idle");
  const [showResultsModal, setShowResultsModal] = useState(false);
  const [showLPMAMAB, setShowLPMAMAB] = useState(false);
  const [lpmamab, setLpmamab] = useState<LPMAMAB>(emptyLPMAMAB);

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
        agentId: user?.id,
        outcome: vars.outcome,
        notes: vars.notes,
        lpmamab: vars.lpmamab,
        apptDetails: vars.apptDetails,
        kitDetails: vars.kitDetails,
        sendToCRM: vars.sendToCRM,
      }).then(r => r.json()),
    onSuccess: (_, vars) => {
      const labels: Record<string, string> = {
        contacted_appointment: "Appointment saved to CRM",
        keep_in_touch: "Keep In Touch saved to CRM",
        declined_service: "Lead removed",
        no_answer: "Lead recycled to queue",
      };
      toast({
        title: labels[vars.outcome] || "Outcome saved",
        description:
          vars.outcome === "contacted_appointment" ? "Great work — appointment set and logged to Follow Up Boss!" :
          vars.outcome === "keep_in_touch" ? "Contact saved to Follow Up Boss." :
          vars.outcome === "declined_service" ? "Lead removed from the system." :
          "Lead recycled for future follow-up.",
      });
      setShowResultsModal(false);
      setCallStep("idle");
      setLpmamab(emptyLPMAMAB);
      setShowLPMAMAB(false);
      qc.invalidateQueries({ queryKey: ["/api/leads/my", user?.id] });
      qc.invalidateQueries({ queryKey: ["/api/leads/my-history", user?.id] });
    },
    onError: () => toast({ title: "Error saving outcome", variant: "destructive" }),
  });

  const handlePhoneClick = () => {
    setCallStep("calling");
  };

  const handleCallDone = () => {
    setShowResultsModal(true);
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
          <div className="mt-8 space-y-4">
            <div className="flex flex-col items-center text-center gap-4 py-10">
              <div className="w-16 h-16 rounded-full bg-secondary border border-border flex items-center justify-center">
                <Inbox className="text-muted-foreground" size={28} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">Queue is empty</h2>
                <p className="text-sm text-muted-foreground mt-1">No leads assigned yet. Check back soon.</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5 border-border text-xs">
                <RotateCcw size={12}/> Check for leads
              </Button>
            </div>
            {user?.id && <ActivityHistory agentId={user.id} />}
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
                {/* Call status indicator */}
                {callStep === "calling" && (
                  <span className="flex items-center gap-1.5 text-xs bg-green-600/20 text-green-300 border border-green-600/40 rounded-full px-2.5 py-1 animate-pulse">
                    <PhoneCall size={11} /> In Call
                  </span>
                )}
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

              {/* Primary contact — CLICK TO CALL */}
              <div className="flex flex-wrap gap-3">
                {lead.phone && (
                  <a
                    href={`tel:${lead.phone}`}
                    onClick={handlePhoneClick}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition-all ${
                      callStep === "calling"
                        ? "bg-green-600/20 border-green-500/60 text-green-300"
                        : "bg-primary/10 border-primary/40 text-primary hover:bg-primary/20"
                    }`}
                    data-testid="link-phone"
                  >
                    <Phone size={15}/>
                    {lead.phone}
                  </a>
                )}
                {lead.email && (
                  <a href={`mailto:${lead.email}`} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-email">
                    <Mail size={14}/> {lead.email}
                  </a>
                )}
              </div>

              {/* Additional contact numbers from Landvoice */}
              <AdditionalContacts lead={lead} onPhoneClick={handlePhoneClick} />

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

            {/* ── LPMAMAB (pre-call notes) ───────────────────────── */}
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <button
                className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-secondary/50 transition-colors"
                onClick={() => setShowLPMAMAB(p => !p)}
                data-testid="button-toggle-lpmamab"
              >
                <span className="flex items-center gap-2.5">
                  <span className="text-xs font-black tracking-widest text-primary">LPMAMAB</span>
                  <span className="text-xs text-muted-foreground hidden sm:inline">— pre-call notes</span>
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

            {/* ── Call Action: log result after call ────────────── */}
            {callStep === "calling" ? (
              <Button
                onClick={handleCallDone}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90 py-5 text-base font-semibold gap-2"
                data-testid="button-call-done"
              >
                <CheckCircle2 size={18}/> Call Done — Log Results
              </Button>
            ) : (
              <div className="bg-card border border-border rounded-xl px-5 py-4 flex items-center gap-3 text-sm text-muted-foreground">
                <Phone size={15} className="text-primary shrink-0" />
                <span>Click the phone number above to initiate your call, then log the result when done.</span>
              </div>
            )}

            {/* ── Activity History ───────────────────────────────── */}
            {user?.id && <ActivityHistory agentId={user.id} />}

          </div>
        )}
      </main>

      {/* ── Call Results Modal ─────────────────────────────────── */}
      {lead && (
        <CallResultsModal
          lead={lead}
          open={showResultsModal}
          onClose={() => setShowResultsModal(false)}
          onSubmit={(vars) => outcomeMutation.mutate(vars)}
          isPending={outcomeMutation.isPending}
        />
      )}
    </div>
  );
}
