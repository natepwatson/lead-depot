// v20.14.0 — Listing Consult. Full-screen wizard that walks an agent through
// the entire Seller Meet & Greet appointment (per Brothers Group's printed
// Listing Flow, page 1) without needing to stay glued to their phone — a
// handful of quick taps/fields per step, big checklist chips, minimal typing.
// The repair-scoping question lives inside Step 2 (Preview the Home) and can
// hand off into the existing Repair Consult tool mid-appointment; the parent
// (AgentView) is responsible for swapping back to this sheet when that closes.
import { useState, useEffect } from "react";
import { CheckCircle2, ChevronRight, ChevronLeft, X, Wrench, Loader2 } from "lucide-react";

const fetchJson = async (url: string, opts: RequestInit = {}) => {
  const r = await fetch(url, { credentials: "include", ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
};

const GOLD = "#c8aa5a";
const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12, padding: 14, marginBottom: 10,
};
const inputStyle: React.CSSProperties = {
  width: "100%", background: "rgba(255,255,255,0.06)", border: `1px solid rgba(200,170,90,0.3)`,
  padding: "10px 12px", borderRadius: 8, fontSize: 13.5, color: "#fff", outline: "none", colorScheme: "dark",
  boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "rgba(255,255,255,0.45)", letterSpacing: "0.08em",
  textTransform: "uppercase", marginBottom: 6, display: "block",
};
const textareaStyle: React.CSSProperties = { ...inputStyle, minHeight: 72, resize: "vertical", fontFamily: "inherit" };

// Big tappable checklist chip — designed so an agent can glance and tap
// without reading fine print, keeping them present with the client instead
// of staring at a form.
function Chip({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} style={{
      display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
      padding: "12px 14px", borderRadius: 10, marginBottom: 8, cursor: "pointer",
      background: checked ? "rgba(200,170,90,0.14)" : "rgba(255,255,255,0.04)",
      border: checked ? "1px solid rgba(200,170,90,0.5)" : "1px solid rgba(255,255,255,0.1)",
      color: checked ? GOLD : "rgba(255,255,255,0.8)", fontSize: 13.5, fontWeight: checked ? 700 : 500,
    }}>
      <span style={{
        width: 20, height: 20, borderRadius: 5, flexShrink: 0,
        border: checked ? "none" : "1.5px solid rgba(255,255,255,0.3)",
        background: checked ? GOLD : "transparent",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {checked && <CheckCircle2 size={14} style={{ color: "#0c0b0a" }} />}
      </span>
      {label}
    </button>
  );
}

type ChecklistState = Record<string, boolean>;

const PREP_ITEMS = ["Generated Sales Package", "Studied $/SF & DOM", "Texted Confirmation", "Arrived Early"];
const PRESENTATION_ITEMS = ["Accolades", "Reviews", "3x Marketing", "Pay at Close Reno", "Zillow Showcase", "Multiple MLS's"];
const LOCKIN_SCHEDULE_ITEMS = ["Repairs / Cleaning", "Photos & Video", "Sign + Lockbox", "Go Live", "Open House(s)"];

const PRICING_TIERS = [
  { tier: "Top Market", desc: "Fully Renovated", reno: "$25-50k Reno", note: "Maximum Return" },
  { tier: "Median", desc: "Move-in Ready", reno: "$15-25k Reno", note: "Balanced" },
  { tier: "Owner Occupant", desc: "Cash Buyer", reno: "$10-15k Reno", note: "Faster Close" },
  { tier: "Cash Investor", desc: "ARV × 70% − Reno", reno: "$0 Reno", note: "Lowest Return" },
];

export function ListingConsultSheet({
  leadId, agentId, initialAddress, initialClientName, initialClientEmail, initialClientPhone, onClose, onLaunchRepairConsult,
}: {
  leadId?: number | null; agentId?: number | null;
  initialAddress?: string; initialClientName?: string; initialClientEmail?: string; initialClientPhone?: string;
  onClose: () => void;
  onLaunchRepairConsult: (prefill: { address: string; name: string; email: string; phone: string }) => void;
}) {
  const [step, setStep] = useState<"prep" | "preview" | "intel" | "presentation" | "pricing" | "close" | "lockin" | "debrief">("prep");
  const [consultId, setConsultId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // v20.14.2 — nav-bar detach fix. Every other full-screen sheet (Repair
  // Consult, KIT modal, etc.) hides the fixed bottom nav via body.ld-modal-open
  // while it's mounted. This sheet was missing it, so typing into any of its
  // many text fields opened the iOS keyboard, which resizes the visualViewport
  // but not the layout viewport — leaving the nav's position:fixed;bottom:0
  // to "float" up into the middle of the screen. Matches RepairConsultSheet's
  // effect exactly.
  useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);

  const [clientName, setClientName] = useState(initialClientName || "");
  const [clientEmail, setClientEmail] = useState(initialClientEmail || "");
  const [clientPhone, setClientPhone] = useState(initialClientPhone || "");
  const [propertyAddress, setPropertyAddress] = useState(initialAddress || "");
  const [prepChecklist, setPrepChecklist] = useState<ChecklistState>({});

  const [previewNotes, setPreviewNotes] = useState("");
  const [needsRepairs, setNeedsRepairs] = useState<"" | "yes" | "no">("");
  const [repairNotes, setRepairNotes] = useState("");

  const [desiredPrice, setDesiredPrice] = useState("");
  const [motivation, setMotivation] = useState("");
  const [mortgageBalance, setMortgageBalance] = useState("");
  const [buyingToo, setBuyingToo] = useState<"" | "yes" | "no">("");
  const [buyingNotes, setBuyingNotes] = useState("");
  const [timeline, setTimeline] = useState("");

  const [presentationChecklist, setPresentationChecklist] = useState<ChecklistState>({});

  const [recommendedPrice, setRecommendedPrice] = useState("");

  const [readyToStart, setReadyToStart] = useState<"" | "yes" | "no">("");
  const [startTiming, setStartTiming] = useState<"" | "now" | "later">("");
  const [repairsOrReady, setRepairsOrReady] = useState<"" | "repairs" | "ready">("");
  const [holdingBack, setHoldingBack] = useState("");

  const [lockinSchedule, setLockinSchedule] = useState<ChecklistState>({});
  const [accessKeyOrCode, setAccessKeyOrCode] = useState("");
  const [gateCode, setGateCode] = useState("");
  const [ownerNames, setOwnerNames] = useState("");
  const [accessPhone, setAccessPhone] = useState("");
  const [accessEmail, setAccessEmail] = useState("");
  const [contractSent, setContractSent] = useState(false);

  const [debriefResult, setDebriefResult] = useState("");
  const [debriefNotes, setDebriefNotes] = useState("");
  const [debriefUpgrades, setDebriefUpgrades] = useState("");
  const [debriefTempo, setDebriefTempo] = useState("");
  const [debriefStage, setDebriefStage] = useState("");
  const [debriefNextSteps, setDebriefNextSteps] = useState("");
  const [debriefSent, setDebriefSent] = useState(false);
  const [sendingDebrief, setSendingDebrief] = useState(false);

  const ensureConsult = async (): Promise<number> => {
    if (consultId) return consultId;
    setCreating(true);
    try {
      const d = await fetchJson("/api/listing-consult", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, agentId, clientName, clientEmail, clientPhone, propertyAddress }),
      });
      setConsultId(d.id);
      return d.id;
    } finally { setCreating(false); }
  };

  const saveSection = async (section: string, patch: Record<string, any>, id?: number) => {
    const cid = id ?? await ensureConsult();
    await fetchJson(`/api/listing-consult/${cid}/data`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section, patch, clientName, clientEmail, clientPhone, propertyAddress }),
    });
    return cid;
  };

  const toggleChip = (state: ChecklistState, setState: (s: ChecklistState) => void, key: string) =>
    setState({ ...state, [key]: !state[key] });

  const handlePrepNext = async () => {
    if (!propertyAddress.trim()) { setError("Property address is required."); return; }
    setError(""); setSaving(true);
    try {
      await ensureConsult();
      await saveSection("prep", { checklist: prepChecklist });
      setStep("preview");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handlePreviewNext = async () => {
    setError(""); setSaving(true);
    try {
      await saveSection("preview", { notes: previewNotes, needsRepairs: needsRepairs === "yes", repairNotes });
      setStep("intel");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleOpenRepairConsult = async () => {
    setError(""); setSaving(true);
    try {
      await ensureConsult();
      await saveSection("preview", { notes: previewNotes, needsRepairs: true, repairNotes });
      onLaunchRepairConsult({ address: propertyAddress, name: clientName, email: clientEmail, phone: clientPhone });
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleIntelNext = async () => {
    setError(""); setSaving(true);
    try {
      await saveSection("intel", { desiredPrice, motivation, mortgageBalance, buyingToo, buyingNotes, timeline });
      setStep("presentation");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handlePresentationNext = async () => {
    setError(""); setSaving(true);
    try {
      await saveSection("presentation", { covered: presentationChecklist });
      setStep("pricing");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handlePricingNext = async () => {
    setError(""); setSaving(true);
    try {
      await saveSection("pricing", { recommendedPrice });
      setStep("close");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleCloseNext = async () => {
    setError(""); setSaving(true);
    try {
      await saveSection("close", { readyToStart, startTiming, repairsOrReady, holdingBack });
      setStep(readyToStart === "yes" ? "lockin" : "debrief");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleLockinNext = async () => {
    setError(""); setSaving(true);
    try {
      await saveSection("lockin", {
        schedule: lockinSchedule,
        accessNotes: [accessKeyOrCode && `Key/Code: ${accessKeyOrCode}`, gateCode && `Gate: ${gateCode}`, ownerNames && `Owners: ${ownerNames}`, accessPhone, accessEmail].filter(Boolean).join(" · "),
        contractSent,
      });
      setStep("debrief");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleDebriefSubmit = async () => {
    if (!consultId) return;
    setSendingDebrief(true); setError("");
    try {
      await fetchJson(`/api/listing-consult/${consultId}/debrief`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: debriefResult, notes: debriefNotes, upgrades: debriefUpgrades, tempo: debriefTempo, stage: debriefStage, nextSteps: debriefNextSteps }),
      });
      setDebriefSent(true);
    } catch (e: any) { setError(e.message || "Failed to send debrief."); }
    finally { setSendingDebrief(false); }
  };

  const stepOrder = ["prep", "preview", "intel", "presentation", "pricing", "close", readyToStart === "yes" ? "lockin" : null, "debrief"].filter(Boolean) as string[];
  const stepLabels: Record<string, string> = { prep: "Prep", preview: "Preview", intel: "Intel", presentation: "Present", pricing: "Pricing", close: "Close", lockin: "Lock In", debrief: "Debrief" };
  const stepIdx = stepOrder.indexOf(step);

  const header = (title: string, sub: string) => (
    <div style={{ marginBottom: 18 }}>
      <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 24, fontWeight: 400, color: "#fff", margin: 0 }}>{title}</h2>
      <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>{sub}</p>
      <div style={{ display: "flex", gap: 4, marginTop: 14 }}>
        {stepOrder.map((s, i) => (
          <div key={s} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= stepIdx ? GOLD : "rgba(255,255,255,0.1)" }} />
        ))}
      </div>
    </div>
  );

  const navButtons = (opts: { onBack?: () => void; onNext?: () => void; nextLabel?: string; nextDisabled?: boolean; nextBusy?: boolean }) => (
    <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
      {opts.onBack && (
        <button onClick={opts.onBack} style={{
          flex: "0 0 auto", padding: "12px 18px", borderRadius: 10,
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)",
          color: "rgba(255,255,255,0.75)", fontSize: 13, fontWeight: 600, cursor: "pointer",
          display: "flex", alignItems: "center", gap: 4,
        }}><ChevronLeft size={15} /> Back</button>
      )}
      {opts.onNext && (
        <button onClick={opts.onNext} disabled={opts.nextDisabled || opts.nextBusy} style={{
          flex: 1, padding: "12px 18px", borderRadius: 10,
          background: GOLD, border: "none", color: "#0c0b0a", fontSize: 13.5, fontWeight: 700, cursor: opts.nextDisabled ? "not-allowed" : "pointer",
          opacity: opts.nextDisabled ? 0.5 : 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}>
          {opts.nextBusy ? <Loader2 size={15} className="animate-spin" /> : null}
          {opts.nextLabel || "Continue"} {!opts.nextBusy && <ChevronRight size={15} />}
        </button>
      )}
    </div>
  );

  const segmented = (value: string, options: { key: string; label: string }[], onPick: (k: string) => void) => (
    <div style={{ display: "flex", gap: 8 }}>
      {options.map(o => (
        <button key={o.key} type="button" onClick={() => onPick(o.key)} style={{
          flex: 1, padding: "10px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700,
          background: value === o.key ? GOLD : "rgba(255,255,255,0.06)",
          border: value === o.key ? "none" : "1px solid rgba(255,255,255,0.15)",
          color: value === o.key ? "#0c0b0a" : "rgba(255,255,255,0.75)",
        }}>{o.label}</button>
      ))}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }} />
      <div style={{
        position: "relative", zIndex: 1,
        background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
        border: `1px solid rgba(200,170,90,0.3)`, borderBottom: "none",
        borderRadius: "20px 20px 0 0", padding: "24px 20px 40px",
        maxHeight: "94dvh", overflowY: "auto",
      }}>
        <button type="button" onClick={onClose} aria-label="Close" style={{
          position: "absolute", top: 12, right: 12, width: 38, height: 38, borderRadius: 19,
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
          color: "rgba(255,255,255,0.75)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
        }}><X size={18} /></button>

        {error && (
          <div style={{ padding: 10, marginBottom: 14, borderRadius: 8, background: "rgba(255,120,120,0.1)", color: "#ffb0b0", fontSize: 12.5 }}>
            {error}
          </div>
        )}

        {step === "prep" && (
          <>
            {header("Before You Arrive", "Property + client info, quick prep checklist")}
            <label style={labelStyle}>Property Address</label>
            <input style={{ ...inputStyle, marginBottom: 14 }} value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} placeholder="123 Main St, Fernandina Beach, FL" />
            <label style={labelStyle}>Client Name</label>
            <input style={{ ...inputStyle, marginBottom: 14 }} value={clientName} onChange={e => setClientName(e.target.value)} placeholder="Client full name" />
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Client Email</label>
                <input style={inputStyle} value={clientEmail} onChange={e => setClientEmail(e.target.value)} placeholder="client@email.com" type="email" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Client Phone</label>
                <input style={inputStyle} value={clientPhone} onChange={e => setClientPhone(e.target.value)} placeholder="(904) 555-0100" />
              </div>
            </div>
            <label style={labelStyle}>Before-You-Arrive Checklist</label>
            {PREP_ITEMS.map(item => (
              <Chip key={item} label={item} checked={!!prepChecklist[item]} onToggle={() => toggleChip(prepChecklist, setPrepChecklist, item)} />
            ))}
            {navButtons({ onNext: handlePrepNext, nextBusy: creating || saving, nextDisabled: !propertyAddress.trim() })}
          </>
        )}

        {step === "preview" && (
          <>
            {header("Preview the Home", "Interior & exterior walkthrough, condition + repairs")}
            <label style={labelStyle}>Interior / Exterior Notes</label>
            <textarea style={{ ...textareaStyle, marginBottom: 14 }} value={previewNotes} onChange={e => setPreviewNotes(e.target.value)} placeholder="Condition, updates, anything notable while walking through" />
            <label style={labelStyle}>Needs Repairs?</label>
            <div style={{ marginBottom: 14 }}>
              {segmented(needsRepairs, [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], v => setNeedsRepairs(v as any))}
            </div>
            {needsRepairs === "yes" && (
              <div style={cardStyle}>
                <label style={labelStyle}>Quick Repair Notes</label>
                <input style={{ ...inputStyle, marginBottom: 10 }} value={repairNotes} onChange={e => setRepairNotes(e.target.value)} placeholder="What you're seeing — detail happens in Repair Consult" />
                <button type="button" onClick={handleOpenRepairConsult} disabled={saving} style={{
                  width: "100%", padding: "12px 14px", borderRadius: 10, cursor: saving ? "default" : "pointer",
                  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)",
                  color: "#fff", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                }}>
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Wrench size={15} style={{ color: GOLD }} />}
                  Open Repair Consult
                </button>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 8 }}>
                  Scope items + generate the repair list there, then come right back here — this listing consult stays open.
                </p>
              </div>
            )}
            {navButtons({ onBack: () => setStep("prep"), onNext: handlePreviewNext, nextBusy: saving })}
          </>
        )}

        {step === "intel" && (
          <>
            {header("Capture Intel", "LPMAMAB — the numbers behind the decision")}
            <label style={labelStyle}>Desired Price</label>
            <input style={{ ...inputStyle, marginBottom: 12 }} value={desiredPrice} onChange={e => setDesiredPrice(e.target.value)} placeholder="$" />
            <label style={labelStyle}>Motivation</label>
            <input style={{ ...inputStyle, marginBottom: 12 }} value={motivation} onChange={e => setMotivation(e.target.value)} placeholder="Why they're selling, urgency" />
            <label style={labelStyle}>Mortgage Balance</label>
            <input style={{ ...inputStyle, marginBottom: 12 }} value={mortgageBalance} onChange={e => setMortgageBalance(e.target.value)} placeholder="$" />
            <label style={labelStyle}>Buying Another Home?</label>
            <div style={{ marginBottom: 10 }}>
              {segmented(buyingToo, [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], v => setBuyingToo(v as any))}
            </div>
            {buyingToo === "yes" && (
              <input style={{ ...inputStyle, marginBottom: 12 }} value={buyingNotes} onChange={e => setBuyingNotes(e.target.value)} placeholder="Where / what they're looking for" />
            )}
            <label style={labelStyle}>Timeline / Deadline</label>
            <input style={inputStyle} value={timeline} onChange={e => setTimeline(e.target.value)} placeholder="When they need to be moved" />
            {navButtons({ onBack: () => setStep("preview"), onNext: handleIntelNext, nextBusy: saving })}
          </>
        )}

        {step === "presentation" && (
          <>
            {header("Sales Presentation", "What you covered with the client")}
            {PRESENTATION_ITEMS.map(item => (
              <Chip key={item} label={item} checked={!!presentationChecklist[item]} onToggle={() => toggleChip(presentationChecklist, setPresentationChecklist, item)} />
            ))}
            {navButtons({ onBack: () => setStep("intel"), onNext: handlePresentationNext, nextBusy: saving })}
          </>
        )}

        {step === "pricing" && (
          <>
            {header("CMA Pricing & Pay-at-Close Reno", "Reference tiers — walk the client through the tradeoffs")}
            <div style={cardStyle}>
              {PRICING_TIERS.map(t => (
                <div key={t.tier} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 700, color: "#fff", margin: 0 }}>{t.tier}</p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", margin: "2px 0 0" }}>{t.desc} · {t.reno}</p>
                  </div>
                  <span style={{ fontSize: 11, color: GOLD, fontWeight: 600, whiteSpace: "nowrap", marginLeft: 10 }}>{t.note}</span>
                </div>
              ))}
            </div>
            <label style={labelStyle}>Recommended List Price (optional)</label>
            <input style={inputStyle} value={recommendedPrice} onChange={e => setRecommendedPrice(e.target.value)} placeholder="$" />
            {navButtons({ onBack: () => setStep("presentation"), onNext: handlePricingNext, nextBusy: saving })}
          </>
        )}

        {step === "close" && (
          <>
            {header("Close the Deal", "Ready to get started?")}
            <label style={labelStyle}>Ready to Get Started?</label>
            <div style={{ marginBottom: 14 }}>
              {segmented(readyToStart, [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], v => setReadyToStart(v as any))}
            </div>
            <label style={labelStyle}>Timing</label>
            <div style={{ marginBottom: 14 }}>
              {segmented(startTiming, [{ key: "now", label: "Now" }, { key: "later", label: "Later" }], v => setStartTiming(v as any))}
            </div>
            <label style={labelStyle}>Repairs or Ready?</label>
            <div style={{ marginBottom: 14 }}>
              {segmented(repairsOrReady, [{ key: "repairs", label: "Repairs First" }, { key: "ready", label: "Ready Now" }], v => setRepairsOrReady(v as any))}
            </div>
            <label style={labelStyle}>What's Holding Them Back?</label>
            <textarea style={textareaStyle} value={holdingBack} onChange={e => setHoldingBack(e.target.value)} placeholder="Only if not moving forward yet" />
            {navButtons({ onBack: () => setStep("pricing"), onNext: handleCloseNext, nextBusy: saving, nextLabel: readyToStart === "yes" ? "Lock It In" : "Continue to Debrief" })}
          </>
        )}

        {step === "lockin" && (
          <>
            {header("Lock It In", "Schedule + access — moves fast once signed")}
            <label style={labelStyle}>Schedule</label>
            {LOCKIN_SCHEDULE_ITEMS.map(item => (
              <Chip key={item} label={item} checked={!!lockinSchedule[item]} onToggle={() => toggleChip(lockinSchedule, setLockinSchedule, item)} />
            ))}
            <label style={{ ...labelStyle, marginTop: 10 }}>Access</label>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <input style={inputStyle} value={accessKeyOrCode} onChange={e => setAccessKeyOrCode(e.target.value)} placeholder="Key or Code?" />
              <input style={inputStyle} value={gateCode} onChange={e => setGateCode(e.target.value)} placeholder="Gate Code?" />
            </div>
            <input style={{ ...inputStyle, marginBottom: 10 }} value={ownerNames} onChange={e => setOwnerNames(e.target.value)} placeholder="Owner Names" />
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <input style={inputStyle} value={accessPhone} onChange={e => setAccessPhone(e.target.value)} placeholder="Phone" />
              <input style={inputStyle} value={accessEmail} onChange={e => setAccessEmail(e.target.value)} placeholder="Email" />
            </div>
            <Chip label="Send Listing Contract" checked={contractSent} onToggle={() => setContractSent(!contractSent)} />
            {navButtons({ onBack: () => setStep("close"), onNext: handleLockinNext, nextBusy: saving, nextLabel: "Continue to Debrief" })}
          </>
        )}

        {step === "debrief" && (
          <>
            {header("Debrief", "Send the office admin your summary")}
            {!debriefSent ? (
              <>
                <label style={labelStyle}>Consult Result</label>
                <select style={{ ...inputStyle, marginBottom: 12 }} value={debriefResult} onChange={e => setDebriefResult(e.target.value)}>
                  <option value="">Select…</option>
                  <option value="Signed">Signed</option>
                  <option value="Follow-up needed">Follow-up needed</option>
                  <option value="Not ready">Not ready</option>
                  <option value="Lost">Lost</option>
                </select>
                <label style={labelStyle}>Notes</label>
                <textarea style={{ ...textareaStyle, marginBottom: 12 }} value={debriefNotes} onChange={e => setDebriefNotes(e.target.value)} />
                <label style={labelStyle}>Upgrades Noted</label>
                <input style={{ ...inputStyle, marginBottom: 12 }} value={debriefUpgrades} onChange={e => setDebriefUpgrades(e.target.value)} placeholder="Kitchen remodel 2022, new roof, etc." />
                <label style={labelStyle}>Tempo</label>
                <input style={{ ...inputStyle, marginBottom: 12 }} value={debriefTempo} onChange={e => setDebriefTempo(e.target.value)} placeholder="How fast this needs to move" />
                <label style={labelStyle}>Stage</label>
                <input style={{ ...inputStyle, marginBottom: 12 }} value={debriefStage} onChange={e => setDebriefStage(e.target.value)} placeholder="Pipeline stage" />
                <label style={labelStyle}>Next Steps</label>
                <textarea style={textareaStyle} value={debriefNextSteps} onChange={e => setDebriefNextSteps(e.target.value)} />
                {navButtons({ onBack: () => setStep(readyToStart === "yes" ? "lockin" : "close"), onNext: handleDebriefSubmit, nextBusy: sendingDebrief, nextLabel: "Send Debrief" })}
              </>
            ) : (
              <>
                <div style={{ padding: 12, borderRadius: 10, background: "rgba(126,212,154,0.1)", color: "#7ed49a", fontSize: 12.5, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                  <CheckCircle2 size={16} /> Debrief sent to Alex, Nate & Denise.
                </div>
                <button onClick={onClose} style={{
                  width: "100%", padding: "12px 18px", borderRadius: 10, background: "transparent",
                  border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 600, cursor: "pointer",
                }}>Done</button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
