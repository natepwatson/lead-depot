// v20.14.0 — Listing Consult. Full-screen wizard that walks an agent through
// the entire Seller Meet & Greet appointment without needing to stay glued
// to their phone — a handful of quick taps/fields per step, big checklist
// chips, minimal typing.
//
// v20.18.0 — FOUR-PAGE REDESIGN (Prep → Walkthrough & Intel → Close → Lock In).
// See server/listingConsult.ts header for the full design rationale. Key
// frontend changes: Preview + Intel merged into one Walkthrough & Intel
// step; Close is now a single 3-way "Where are we?" control whose
// "not moving forward" branch reveals 4 outcomes INLINE (the standalone
// Debrief page is gone — Consult Result is the only thing that survived
// from it); Lock In gained Cleaning Y/N (always asked), a direct Repair
// Date/Time (only when Close said repairs-first — never re-asks a question
// already answered), a Showing Approval Contact picker (Owner 1 / Owner 2 /
// Other) that replaces the old free-text Access Phone, a Showing
// Restrictions field, a derived (read-only) Access Email, and a real
// validation + summary-card gate behind "Send Listing Contract" instead of
// a plain checkbox chip.
import { useState, useEffect, useRef, useMemo } from "react";
import { CheckCircle2, ChevronRight, ChevronLeft, X, Wrench, Loader2, Camera } from "lucide-react";
import { ConsultResumePicker, ResumeCheckingSpinner, type ResumeItem } from "./ConsultResumePicker";

// v20.19.x — Timeline Forecaster. Cleaning and repairs are never scheduled
// to a hard date/time in Lock In anymore (that's an after-the-contract
// conversation, once the seller believes the plan and books the real instant
// quote). Instead we forecast the whole runway forward from a start date
// (defaults to today) using rule-of-thumb durations, so the seller sees a
// realistic Go-Live and Open House date on the spot without anyone being
// pinned to a specific cleaning/repair appointment today.
const pad2 = (n: number) => String(n).padStart(2, "0");
const toISO = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseISODate = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const addCalendarDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const addBusinessDays = (d: Date, n: number) => {
  let r = new Date(d);
  let remaining = n;
  while (remaining > 0) {
    r = addCalendarDays(r, 1);
    const dow = r.getDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return r;
};
const nextSaturdayOnOrAfter = (d: Date) => {
  const r = new Date(d);
  const diff = (6 - r.getDay() + 7) % 7;
  r.setDate(r.getDate() + diff);
  return r;
};
const fmtShort = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

// Rule-of-thumb durations (adjust here if the real world proves different):
const FORECAST_RULES = {
  repairBusinessDays: 5,   // typical touch-up/turnover window when repairs-first was chosen
  cleaningBusinessDays: 1, // cleaning happens last, right before photos
  photoScheduleBusinessDays: 2, // time to get on the photographer's schedule
  photoEditCalendarDays: 2,     // 48-hour edit turnaround after the shoot
};

type MilestoneKey = "repairStart" | "repairEnd" | "cleaningDay" | "photosScheduled" | "photosBack" | "goLive" | "openHouse";
type TimelineForecast = {
  showRepairWindow: boolean;
  repairStart: Date | null; repairEnd: Date | null;
  cleaningDay: Date | null;
  photosScheduled: Date; photosBack: Date;
  goLive: Date; showingsBegin: Date; openHouse: Date;
};
// Full ordered sequence this milestone key can appear in (used to know what
// "everything after" means when an agent overrides one date by hand).
const milestoneSequence = (showRepairWindow: boolean, cleaningNeeded: boolean): MilestoneKey[] => {
  const order: MilestoneKey[] = [];
  if (showRepairWindow) order.push("repairStart", "repairEnd");
  if (cleaningNeeded) order.push("cleaningDay");
  order.push("photosScheduled", "photosBack", "goLive", "openHouse");
  return order;
};
// v20.19.x — every forecasted date is agent-editable. The chain still starts
// from forecastStartDate and applies the rule-of-thumb gaps by default ("the
// quickest we can do it"), but any manual override for a milestone becomes
// the new anchor for everything scheduled after it — sellers who need more
// breathing room in one phase don't have to fight the calculator, and later
// dates cascade forward automatically from wherever they land it.
const computeTimelineForecast = (
  startISO: string,
  showRepairWindow: boolean,
  cleaningNeeded: boolean,
  overrides: Partial<Record<MilestoneKey, string>> = {}
): TimelineForecast | null => {
  if (!startISO) return null;
  const pick = (key: MilestoneKey, computed: Date): Date => {
    const ov = overrides[key];
    return ov ? parseISODate(ov) : computed;
  };

  let cursor = parseISODate(startISO);
  let repairStart: Date | null = null, repairEnd: Date | null = null;
  if (showRepairWindow) {
    repairStart = pick("repairStart", cursor);
    cursor = repairStart;
    repairEnd = pick("repairEnd", addBusinessDays(cursor, FORECAST_RULES.repairBusinessDays));
    cursor = repairEnd;
  }
  let cleaningDay: Date | null = null;
  if (cleaningNeeded) {
    cleaningDay = pick("cleaningDay", addBusinessDays(cursor, FORECAST_RULES.cleaningBusinessDays));
    cursor = cleaningDay;
  }
  const photosScheduled = pick("photosScheduled", addBusinessDays(cursor, FORECAST_RULES.photoScheduleBusinessDays));
  cursor = photosScheduled;
  const photosBack = pick("photosBack", addCalendarDays(photosScheduled, FORECAST_RULES.photoEditCalendarDays));
  cursor = photosBack;
  const goLive = pick("goLive", photosBack);
  cursor = goLive;
  const showingsBegin = goLive;
  const openHouse = pick("openHouse", nextSaturdayOnOrAfter(goLive));
  return { showRepairWindow, repairStart, repairEnd, cleaningDay, photosScheduled, photosBack, goLive, showingsBegin, openHouse };
};

// v20.14.4 — same compress-before-upload helper as RepairConsultSheet. Keeps
// front-of-house + walkthrough photos small before they hit the server, on
// top of the server's own sharp resize pass.
async function fileToImageData(file: File, opts: { maxDim?: number; quality?: number } = {}): Promise<{ imageData: string; mimeType: string } | null> {
  const maxDim = opts.maxDim ?? 1800;
  const quality = opts.quality ?? 0.82;
  let processed: File | Blob = file;
  if (file.type === "image/heic" || file.type === "image/heif" || file.name.toLowerCase().match(/\.(heic|heif)$/)) {
    try {
      const heic2any = (await import("heic2any")).default;
      const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
      processed = Array.isArray(converted) ? converted[0] : converted;
    } catch { return null; }
  }
  try {
    const bitmap = await createImageBitmap(processed as Blob, { imageOrientation: "from-image" } as any);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const [meta, imageData] = dataUrl.split(",");
    const mimeType = meta.match(/:(.*?);/)?.[1] ?? "image/jpeg";
    return { imageData, mimeType };
  } catch {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        const [meta, imageData] = dataUrl.split(",");
        const mimeType = meta.match(/:(.*?);/)?.[1] ?? "image/jpeg";
        resolve({ imageData, mimeType });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(processed);
    });
  }
}

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
// v20.26.0 — compact date input used inside the Timeline Forecast table so
// every row is individually editable without breaking the table layout.
const forecastDateInputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(200,170,90,0.25)",
  padding: "3px 6px", borderRadius: 6, fontSize: 12.5, color: "#fff", outline: "none", colorScheme: "dark",
  fontFamily: "inherit", width: "100%",
};

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

const NOT_MOVING_OPTIONS: { key: string; label: string }[] = [
  { key: "pending_repair_quote", label: "Not ready — pending repair quote" },
  { key: "other_reason", label: "Not ready — other reason" },
  { key: "listed_other_agent", label: "Listed with another agent" },
  { key: "not_interested", label: "Not interested" },
];

// v20.21.0 — Condition Capture. Replaces the old plain Yes/No "Needs Repairs?"
// toggle. The agent is standing in the house right now looking at actual
// condition — capture real scope data per pillar on the spot (checked + a
// size tier + a free-text note) instead of a bare flag. This feeds the
// Repair Consult prefill so the follow-up quote starts pre-scoped instead of
// from zero. The four "pillar" trades are Alex's core money-makers; Junk Out
// and Flooring ride along as the next-easiest add-ons — same walkthrough,
// same data capture, no extra step for the agent.
type PillarTier = "small" | "medium" | "large";
type PillarKey = "pressure_wash" | "lawn" | "paint" | "deep_clean" | "junk_out" | "flooring";
// v20.27.0 — `details` captures WHICH specific areas/scope-modes apply,
// checked on the spot during the walkthrough (evidence-driven, per Alex:
// "photos are evidence of a need"). S/M/L still sets the overall scale;
// details tell the Repair Consult prefill exactly which catalog line items
// to auto-check instead of guessing a fixed bundle from tier alone. Optional
// — leaving details empty falls back to the old tier-only bundle so nothing
// breaks for consults saved before this existed.
type PillarState = { checked: boolean; tier: PillarTier | ""; notes: string; details: string[] };
const EMPTY_PILLAR: PillarState = { checked: false, tier: "", notes: "", details: [] };

const PILLAR_DEFS: { key: PillarKey; label: string; group: "pillar" | "addon"; tiers: { key: PillarTier; label: string }[]; details?: { key: string; label: string }[] }[] = [
  {
    key: "pressure_wash", label: "Pressure / Soft Washing", group: "pillar",
    tiers: [
      { key: "small", label: "Small — driveway & walkways only" },
      { key: "medium", label: "Medium — house + driveway + walkways" },
      { key: "large", label: "Large — full property incl. roof soft wash" },
    ],
    details: [
      { key: "house", label: "House / Siding" },
      { key: "driveway", label: "Driveway" },
      { key: "patio", label: "Patio" },
      { key: "walkway", label: "Walkway" },
      { key: "roof", label: "Roof (soft wash)" },
      { key: "fence", label: "Fence" },
    ],
  },
  {
    key: "lawn", label: "Lawn & Landscaping", group: "pillar",
    tiers: [
      { key: "small", label: "Small — mow / edge / blow" },
      { key: "medium", label: "Medium — + hedge trim & bed weeding" },
      { key: "large", label: "Large — full reset: mulch, dead plant removal" },
    ],
    details: [
      { key: "mowing", label: "Mow / Edge / Blow" },
      { key: "hedge_trim", label: "Hedge / Shrub Trim" },
      { key: "weed_pull", label: "Weed Pull (Beds)" },
      { key: "mulching", label: "Mulching" },
      { key: "tree_removal", label: "Small Tree/Hedge Removal" },
    ],
  },
  {
    key: "paint", label: "Touch-Up / Painting", group: "pillar",
    tiers: [
      { key: "small", label: "Small — 1 room touch-up (walls + trim + door)" },
      { key: "medium", label: "Medium — 3-room touch-up package" },
      { key: "large", label: "Large — whole-house touch-up or full repaint" },
    ],
    details: [
      { key: "touch_up_only", label: "Touch-Up Only" },
      { key: "whole_home_interior", label: "Whole-Home Interior Painting" },
      { key: "exterior", label: "Exterior Painting" },
      { key: "ceilings", label: "Ceilings" },
      { key: "trim_doors", label: "Trim / Doors" },
    ],
  },
  {
    key: "deep_clean", label: "Deep Cleaning", group: "pillar",
    tiers: [
      { key: "small", label: "Small — standard tidy-up clean" },
      { key: "medium", label: "Medium — deep clean (baseboards, cabinets, windows)" },
      { key: "large", label: "Large — move-out level, incl. garage/patio" },
    ],
    details: [
      { key: "standard", label: "Standard Tidy-Up" },
      { key: "deep", label: "Deep Clean (baseboards/cabinets/windows)" },
      { key: "carpets", label: "Carpet Cleaning" },
    ],
  },
  {
    key: "junk_out", label: "Junk Out", group: "addon",
    tiers: [
      { key: "small", label: "Small — partial load, single room" },
      { key: "medium", label: "Medium — full truck load" },
      { key: "large", label: "Large — multiple loads / whole-house clear-out" },
    ],
  },
  {
    key: "flooring", label: "Flooring", group: "addon",
    tiers: [
      { key: "small", label: "Small — 1–2 rooms" },
      { key: "medium", label: "Medium — several rooms / one level" },
      { key: "large", label: "Large — whole house" },
    ],
  },
];

export function ListingConsultSheet({
  leadId, agentId, initialAddress, initialClientName, initialClientEmail, initialClientPhone, onClose, onLaunchRepairConsult,
}: {
  leadId?: number | null; agentId?: number | null;
  initialAddress?: string; initialClientName?: string; initialClientEmail?: string; initialClientPhone?: string;
  onClose: () => void;
  onLaunchRepairConsult: (prefill: { address: string; name: string; email: string; phone: string; heroPhotoUrl?: string | null; galleryUrls?: string[]; flaggedPillars?: { key: PillarKey; label: string; tier: PillarTier | ""; notes: string; details: string[] }[] }) => void;
}) {
  // v20.18.0 — four-page flow: prep → walkthrough → close → lockin. Debrief
  // is gone entirely (folded into close's inline "not moving forward" branch).
  const [step, setStep] = useState<"prep" | "walkthrough" | "close" | "lockin">("prep");
  const [consultId, setConsultId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // v20.14.5 — Resume picker: this sheet is never nested inside another
  // (Repair Consult can be nested inside it, not the other way around), so
  // it always checks for a resumable in-progress consult before rendering steps.
  const [resumePhase, setResumePhase] = useState<"checking" | "picking" | "ready">("checking");
  const [resumeList, setResumeList] = useState<ResumeItem[]>([]);

  // v20.14.2 — nav-bar detach fix. Every other full-screen sheet (Repair
  // Consult, KIT modal, etc.) hides the fixed bottom nav via body.ld-modal-open
  // while it's mounted.
  useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);

  useEffect(() => {
    fetchJson(`/api/listing-consult/mine?agentId=${agentId ?? ""}`)
      .then(d => {
        const list: ResumeItem[] = d.consults || [];
        if (list.length > 0) { setResumeList(list); setResumePhase("picking"); }
        else setResumePhase("ready");
      })
      .catch(() => setResumePhase("ready"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [clientName, setClientName] = useState(initialClientName || "");
  const [clientEmail, setClientEmail] = useState(initialClientEmail || "");
  const [clientPhone, setClientPhone] = useState(initialClientPhone || "");
  const [propertyAddress, setPropertyAddress] = useState(initialAddress || "");
  const [prepChecklist, setPrepChecklist] = useState<ChecklistState>({});
  const [heroPhotoUrl, setHeroPhotoUrl] = useState<string | null>(null);
  const [uploadingHero, setUploadingHero] = useState(false);
  // v20.18.0 — gallery tag toggle UI removed; entries are plain URL strings now.
  const [galleryUrls, setGalleryUrls] = useState<string[]>([]);
  // v20.28.0 — Scope Photos is a second, distinct upload moment for
  // close-up evidence of exactly what got flagged (paint peeling, cracked
  // driveway, etc). Same underlying gallery_photos array/endpoint as the
  // general Walkthrough Photos bucket — no backend change — this is purely a
  // client-side second list so the two prompts don't visually collide.
  const [scopePhotoUrls, setScopePhotoUrls] = useState<string[]>([]);
  const [uploadingGallery, setUploadingGallery] = useState(false);
  const [galleryProgress, setGalleryProgress] = useState<{ done: number; total: number } | null>(null);

  // v20.15.0 — live FUB contact picker. Agent types a name, we search FUB's
  // cached people list server-side, tap a result to autofill phone/email.
  const [fubQuery, setFubQuery] = useState("");
  const [fubResults, setFubResults] = useState<{ id: number; name: string; email: string | null; phone: string | null; address: string | null }[]>([]);
  const [fubSearching, setFubSearching] = useState(false);
  const [fubPickedName, setFubPickedName] = useState<string | null>(null);
  // v20.18.0 — the real FUB personId, now actually captured (previously
  // discarded) so the outcome-routing FUB push can update the exact same
  // person instead of re-searching by phone/name.
  const [fubPersonId, setFubPersonId] = useState<number | null>(null);

  useEffect(() => {
    if (fubQuery.trim().length < 2 || fubPickedName) { setFubResults([]); return; }
    const t = setTimeout(async () => {
      setFubSearching(true);
      try {
        const r = await fetch(`/api/fub/contacts/search?q=${encodeURIComponent(fubQuery.trim())}`, { credentials: "include" });
        const body = await r.json().catch(() => ({ results: [] }));
        setFubResults(body.results || []);
      } catch { setFubResults([]); }
      finally { setFubSearching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [fubQuery, fubPickedName]);

  const pickFubContact = (c: { id: number; name: string; email: string | null; phone: string | null; address: string | null }) => {
    setClientName(c.name);
    if (c.email) setClientEmail(c.email);
    if (c.phone) setClientPhone(c.phone);
    if (c.address) setPropertyAddress(c.address);
    setFubPersonId(c.id);
    setFubPickedName(c.name);
    setFubQuery(c.name);
    setFubResults([]);
  };

  // ── Walkthrough & Intel (merged) ──
  const [walkthroughNotes, setWalkthroughNotes] = useState("");
  const [needsRepairs, setNeedsRepairs] = useState<"" | "yes" | "no">("");
  const [pillarFlags, setPillarFlags] = useState<Record<PillarKey, PillarState>>({
    pressure_wash: { ...EMPTY_PILLAR }, lawn: { ...EMPTY_PILLAR }, paint: { ...EMPTY_PILLAR },
    deep_clean: { ...EMPTY_PILLAR }, junk_out: { ...EMPTY_PILLAR }, flooring: { ...EMPTY_PILLAR },
  });
  const togglePillar = (key: PillarKey) =>
    setPillarFlags(prev => ({ ...prev, [key]: prev[key].checked ? { ...EMPTY_PILLAR } : { ...prev[key], checked: true } }));
  const setPillarTier = (key: PillarKey, tier: PillarTier) =>
    setPillarFlags(prev => ({ ...prev, [key]: { ...prev[key], tier } }));
  const setPillarNotes = (key: PillarKey, notes: string) =>
    setPillarFlags(prev => ({ ...prev, [key]: { ...prev[key], notes } }));
  const toggleDetail = (key: PillarKey, detailKey: string) =>
    setPillarFlags(prev => {
      const cur = prev[key].details || [];
      const details = cur.includes(detailKey) ? cur.filter(d => d !== detailKey) : [...cur, detailKey];
      return { ...prev, [key]: { ...prev[key], details } };
    });
  const flaggedPillarList = () =>
    PILLAR_DEFS.filter(d => pillarFlags[d.key]?.checked).map(d => ({
      key: d.key, label: d.label, tier: pillarFlags[d.key].tier, notes: pillarFlags[d.key].notes,
      details: pillarFlags[d.key].details || [],
    }));
  const [mortgageBalance, setMortgageBalance] = useState("");
  const [buyingToo, setBuyingToo] = useState<"" | "yes" | "no">("");
  const [buyingNotes, setBuyingNotes] = useState("");
  const [timeline, setTimeline] = useState("");

  // ── Close ──
  const [recommendedPrice, setRecommendedPrice] = useState("");
  const [finalListingPrice, setFinalListingPrice] = useState("");
  // v20.19.x — commission is two separate, auto-filled entries instead of one
  // free-text field, standard splits Brothers Group offers by default:
  // 3.0% listing side / 2.5% buyer side. Still editable per-deal.
  const [listingAgentCommission, setListingAgentCommission] = useState("3.0");
  const [buyerAgentCommission, setBuyerAgentCommission] = useState("2.5");
  const [additionalTerms, setAdditionalTerms] = useState("");
  const [whereAreWe, setWhereAreWe] = useState<"" | "ready_now" | "ready_repairs" | "not_moving">("");
  const [notMovingReason, setNotMovingReason] = useState<"" | "pending_repair_quote" | "other_reason" | "listed_other_agent" | "not_interested">("");
  const [notMovingNotes, setNotMovingNotes] = useState("");
  const [notMovingFollowUpTiming, setNotMovingFollowUpTiming] = useState("");
  const [notMovingSubmitted, setNotMovingSubmitted] = useState(false);
  const [sendingNotMoving, setSendingNotMoving] = useState(false);

  // ── Lock In ──
  // v20.26.0 — needsCleaning is now DERIVED from the Deep Cleaning pillar
  // flagged during Walkthrough (don't ask the same question twice). An agent
  // can still flip cleaningManualOverride on if reality changed by the time
  // they're on Lock It In.
  const [needsCleaning, setNeedsCleaning] = useState<"" | "yes" | "no">("");
  const [cleaningManualOverride, setCleaningManualOverride] = useState(false);
  // v20.19.x — replaced by the Timeline Forecaster: no hard cleaning/repair
  // date+time is ever locked in at this step. forecastStartDate anchors the
  // whole forward-calculated runway (defaults to today, editable if this
  // consult isn't happening the same day the seller signs).
  const [forecastStartDate, setForecastStartDate] = useState(toISO(new Date()));
  // Per-milestone manual overrides (ISO strings). Empty until an agent drags
  // a specific forecasted date — everything computes off the rule-of-thumb
  // gaps until then.
  const [forecastOverrides, setForecastOverrides] = useState<Partial<Record<MilestoneKey, string>>>({});
  const [accessKeyOrCode, setAccessKeyOrCode] = useState("");
  const [gateCode, setGateCode] = useState("");
  const [ownerNames, setOwnerNames] = useState("");
  const [ownerNames2, setOwnerNames2] = useState("");
  const [showOwner2, setShowOwner2] = useState(false);
  const [owner2Query, setOwner2Query] = useState("");
  const [owner2Results, setOwner2Results] = useState<{ id: number; name: string; email: string | null; phone: string | null }[]>([]);
  const [owner2Searching, setOwner2Searching] = useState(false);
  const [owner2Phone, setOwner2Phone] = useState("");
  const [owner2Email, setOwner2Email] = useState("");
  // v20.18.0 — replaces the old free-text "Access Phone". Access Email is
  // derived below from whichever contact is picked here.
  const [showingApprovalContact, setShowingApprovalContact] = useState<"" | "owner1" | "owner2" | "other">("");
  const [showingContactOtherName, setShowingContactOtherName] = useState("");
  const [showingContactOtherPhone, setShowingContactOtherPhone] = useState("");
  const [showingContactOtherEmail, setShowingContactOtherEmail] = useState("");
  const [showingRestrictions, setShowingRestrictions] = useState("");
  const [contractSent, setContractSent] = useState(false);
  const [sendingContract, setSendingContract] = useState(false);
  const [showContractSummary, setShowContractSummary] = useState(false);
  const [contractSendError, setContractSendError] = useState("");

  // v20.15.2 — Owner 1's legal name defaults from the client name captured
  // (and possibly FUB-picked) back on Prep the first time the agent reaches
  // Lock In — one less retype, still fully editable.
  useEffect(() => {
    if (step === "lockin" && !ownerNames && clientName) setOwnerNames(clientName);
  }, [step]);

  useEffect(() => {
    if (owner2Query.trim().length < 2) { setOwner2Results([]); return; }
    const t = setTimeout(async () => {
      setOwner2Searching(true);
      try {
        const r = await fetch(`/api/fub/contacts/search?q=${encodeURIComponent(owner2Query.trim())}`, { credentials: "include" });
        const body = await r.json().catch(() => ({ results: [] }));
        setOwner2Results(body.results || []);
      } catch { setOwner2Results([]); }
      finally { setOwner2Searching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [owner2Query]);

  const pickOwner2Contact = (c: { name: string; email: string | null; phone: string | null }) => {
    setOwner2Phone(c.phone || "");
    setOwner2Email(c.email || "");
    setOwner2Query(c.name);
    setOwner2Results([]);
  };

  // v20.18.0 — Access Email is no longer a manual field. It's derived from
  // whichever Showing Approval Contact was picked.
  const derivedShowingContact =
    showingApprovalContact === "owner1" ? { name: ownerNames || clientName, phone: clientPhone, email: clientEmail } :
    showingApprovalContact === "owner2" ? { name: ownerNames2, phone: owner2Phone, email: owner2Email } :
    showingApprovalContact === "other" ? { name: showingContactOtherName, phone: showingContactOtherPhone, email: showingContactOtherEmail } :
    { name: "", phone: "", email: "" };

  // v20.26.0 — Auto-derive needsCleaning from the Deep Cleaning pillar
  // flagged during Walkthrough, any time the pillar checkbox itself changes
  // (covers the fresh-consult path — the resume path is handled directly in
  // handleResumeConsult above). Skipped entirely once an agent manually
  // overrides on Lock It In.
  useEffect(() => {
    if (cleaningManualOverride) return;
    setNeedsCleaning(pillarFlags.deep_clean.checked ? "yes" : "no");
  }, [pillarFlags.deep_clean.checked, cleaningManualOverride]);

  // v20.19.x — Timeline Forecast: recomputed live as the agent changes the
  // start date, the repairs-first path, or the cleaning flag.
  const timelineForecast = useMemo(
    () => computeTimelineForecast(forecastStartDate, whereAreWe === "ready_repairs", needsCleaning === "yes", forecastOverrides),
    [forecastStartDate, whereAreWe, needsCleaning, forecastOverrides]
  );

  // Start date is the master anchor ("it all starts with today's date") —
  // changing it resets to the quickest-possible chain from the new date.
  const handleForecastStartChange = (v: string) => {
    setForecastStartDate(v);
    setForecastOverrides({});
  };

  // Editing one forecasted date keeps everything BEFORE it untouched and
  // clears any manual overrides AFTER it, so the rest of the chain cascades
  // forward fresh from wherever this date landed.
  const handleForecastDateEdit = (key: MilestoneKey, value: string) => {
    const order = milestoneSequence(whereAreWe === "ready_repairs", needsCleaning === "yes");
    const idx = order.indexOf(key);
    setForecastOverrides(prev => {
      const next = { ...prev };
      for (let i = idx; i < order.length; i++) delete next[order[i]];
      next[key] = value;
      return next;
    });
  };

  // v20.16.0 — Fix for the duplicate-consult creation bug (double POST on the
  // very first "Next" tap). Refs mutate in place and are shared across every
  // closure regardless of which render created them, so gating on a ref
  // instead of state closes the race.
  const consultIdRef = useRef<number | null>(null);
  const creatingPromiseRef = useRef<Promise<number> | null>(null);
  const ensureConsult = async (): Promise<number> => {
    if (consultIdRef.current) return consultIdRef.current;
    if (creatingPromiseRef.current) return creatingPromiseRef.current;
    const p = (async () => {
      setCreating(true);
      try {
        const d = await fetchJson("/api/listing-consult", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId, agentId, clientName, clientEmail, clientPhone, propertyAddress }),
        });
        consultIdRef.current = d.id;
        setConsultId(d.id);
        return d.id as number;
      } finally { setCreating(false); creatingPromiseRef.current = null; }
    })();
    creatingPromiseRef.current = p;
    return p;
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

  // v20.15.0 — hero + gallery photo upload, mirrors RepairConsultSheet exactly.
  const handlePhotoPick = async (file: File, kind: "hero" | "gallery") => {
    // v20.28.0 — ensureConsult() moved INSIDE the try block. Previously it ran
    // before setBusy(true)/try, so any failure (expired session, network
    // hiccup, server validation) threw silently with zero UI feedback —
    // agent picks a photo, taps upload, nothing happens, no error, no spinner.
    const setBusy = kind === "hero" ? setUploadingHero : setUploadingGallery;
    setBusy(true);
    try {
      const id = await ensureConsult();
      const conv = await fileToImageData(file);
      if (!conv) { setError("Couldn't read that photo. Try another."); return; }
      const d = await fetchJson(`/api/listing-consult/${id}/photo`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: conv.imageData, mimeType: conv.mimeType, kind }),
      });
      if (kind === "hero") setHeroPhotoUrl(d.url);
      else setGalleryUrls(prev => [...prev, d.url]);
    } catch (e: any) { setError(e.message || "Photo upload failed. Check your connection and try again."); }
    finally { setBusy(false); }
  };

  const handleBulkGalleryUpload = async (files: FileList, bucket: "walkthrough" | "scope" = "walkthrough") => {
    // v20.28.0 — same ensureConsult()-outside-try fix as handlePhotoPick.
    // setUploadingGallery(true) now fires FIRST so the spinner always shows
    // immediately, and a failed ensureConsult() surfaces a real error instead
    // of a silent no-op. `bucket` just controls which client-side thumbnail
    // list the new URL also lands in — every photo still lands in the one
    // gallery_photos array server-side (that's the full evidence set handed
    // to Repair Consult and Lock It In).
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;
    setUploadingGallery(true);
    setGalleryProgress({ done: 0, total: fileArr.length });
    try {
      const id = await ensureConsult();
      for (let i = 0; i < fileArr.length; i++) {
        try {
          const conv = await fileToImageData(fileArr[i]);
          if (conv) {
            const d = await fetchJson(`/api/listing-consult/${id}/photo`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ imageData: conv.imageData, mimeType: conv.mimeType, kind: "gallery", bucket }),
            });
            setGalleryUrls(prev => [...prev, d.url]);
            if (bucket === "scope") setScopePhotoUrls(prev => [...prev, d.url]);
          }
        } catch (e: any) { setError(e.message || `Photo ${i + 1} of ${fileArr.length} failed to upload — the rest kept going.`); }
        setGalleryProgress({ done: i + 1, total: fileArr.length });
      }
    } catch (e: any) {
      setError(e.message || "Couldn't start the upload — check your connection and try again.");
    } finally {
      setUploadingGallery(false);
      setGalleryProgress(null);
    }
  };

  const handleArchiveConsult = async (id: number) => {
    const prev = resumeList;
    setResumeList(list => list.filter(it => it.id !== id));
    try {
      await fetchJson(`/api/listing-consult/${id}/archive`, { method: "POST" });
    } catch (e: any) {
      setResumeList(prev);
      setError(e.message || "Failed to remove that consult.");
    }
  };

  // v20.18.0 — hydration rewritten for the 4-step flow. No step ever resolves
  // to "debrief" — it doesn't exist anymore. A consult whose Close outcome
  // was "not moving forward" has already flipped its DB status away from
  // in_progress (so /mine won't surface it for resume), but we guard here too.
  const handleResumeConsult = async (id: number) => {
    setResumePhase("ready"); setError("");
    try {
      const d = await fetchJson(`/api/listing-consult/${id}`);
      consultIdRef.current = d.id;
      setConsultId(d.id);
      setClientName(d.client_name || "");
      setClientEmail(d.client_email || "");
      setClientPhone(d.client_phone || "");
      setPropertyAddress(d.property_address || "");
      setHeroPhotoUrl(d.hero_photo_url || null);
      setGalleryUrls(Array.isArray(d.gallery_photos) ? d.gallery_photos : []);
      // v20.28.0 — rehydrate the Scope Photos bucket on resume so it doesn't
      // reset to 0 even though those photos were durably saved all along.
      setScopePhotoUrls(Array.isArray(d.scope_photos) ? d.scope_photos : []);

      const data = d.data || {};
      let nextStep: typeof step = "prep";

      if (data.prep) {
        setPrepChecklist(data.prep.checklist || {});
        if (data.prep.fubPersonId) setFubPersonId(data.prep.fubPersonId);
        nextStep = "walkthrough";
      }
      if (data.walkthrough) {
        setWalkthroughNotes(data.walkthrough.notes || "");
        setNeedsRepairs(data.walkthrough.needsRepairs === true ? "yes" : data.walkthrough.needsRepairs === false ? "no" : "");
        if (data.walkthrough.pillars) {
          setPillarFlags(prev => ({ ...prev, ...data.walkthrough.pillars }));
        }
        setMortgageBalance(data.walkthrough.mortgageBalance || "");
        setBuyingToo(data.walkthrough.buyingToo || "");
        setBuyingNotes(data.walkthrough.buyingNotes || "");
        setTimeline(data.walkthrough.timeline || "");
        nextStep = "close";
      }
      if (data.close) {
        setRecommendedPrice(data.close.recommendedPrice || "");
        setFinalListingPrice(data.close.finalListingPrice || "");
        setListingAgentCommission(data.close.listingAgentCommission ?? "3.0");
        setBuyerAgentCommission(data.close.buyerAgentCommission ?? "2.5");
        setAdditionalTerms(data.close.additionalTerms || "");
        setWhereAreWe(data.close.whereAreWe || "");
        if (data.close.whereAreWe === "ready_now" || data.close.whereAreWe === "ready_repairs") {
          nextStep = "lockin";
        } else {
          nextStep = "close";
        }
      }
      if (data.lockin) {
        // v20.26.0 — if a previously-saved value disagrees with what the
        // walkthrough's Deep Cleaning pillar implies, that means an agent
        // manually overrode it in an earlier session — keep the override on
        // resume instead of silently reverting to the derived value.
        const derivedFromPillar = data.walkthrough?.pillars?.deep_clean?.checked ? "yes" : "no";
        const savedCleaning = data.lockin.needsCleaning || "";
        if (savedCleaning && savedCleaning !== derivedFromPillar) setCleaningManualOverride(true);
        setNeedsCleaning(savedCleaning || derivedFromPillar);
        setForecastStartDate(data.lockin.forecastStartDate || toISO(new Date()));
        setAccessKeyOrCode(data.lockin.accessKeyOrCode || "");
        setGateCode(data.lockin.gateCode || "");
        setOwnerNames(data.lockin.ownerNames || "");
        setOwnerNames2(data.lockin.ownerNames2 || "");
        if (data.lockin.ownerNames2) setShowOwner2(true);
        setOwner2Phone(data.lockin.owner2Phone || "");
        setOwner2Email(data.lockin.owner2Email || "");
        setShowingApprovalContact(data.lockin.showingApprovalContact || "");
        setShowingContactOtherName(data.lockin.showingContactOtherName || "");
        setShowingContactOtherPhone(data.lockin.showingContactOtherPhone || "");
        setShowingContactOtherEmail(data.lockin.showingContactOtherEmail || "");
        setShowingRestrictions(data.lockin.showingRestrictions || "");
        nextStep = "lockin";
      }

      setStep(nextStep);
    } catch (e: any) {
      setError(e.message || "Failed to load that consult — starting fresh instead.");
    }
  };

  const handlePrepNext = async () => {
    if (!propertyAddress.trim()) { setError("Property address is required."); return; }
    setError(""); setSaving(true);
    try {
      await ensureConsult();
      await saveSection("prep", { checklist: prepChecklist, fubPersonId });
      setStep("walkthrough");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleWalkthroughNext = async () => {
    setError(""); setSaving(true);
    try {
      const anyFlagged = Object.values(pillarFlags).some(p => p.checked);
      // v20.23.0 — pillars flagged in the walkthrough must flip the LOCAL
      // needsRepairs state too, not just the saved payload. Lock-It-In's
      // "Repairs Flagged During Walkthrough" banner AND its "Launch Repair
      // Consult" button both gate on this local state — without this, an
      // agent who flags pillars but never touches the Lock-It-In Yes/No
      // toggle would see neither, with no way to reach Repair Consult at all.
      if (anyFlagged && needsRepairs !== "yes") setNeedsRepairs("yes");
      await saveSection("walkthrough", { notes: walkthroughNotes, needsRepairs: anyFlagged || needsRepairs === "yes", pillars: pillarFlags, mortgageBalance, buyingToo, buyingNotes, timeline });
      setStep("close");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleOpenRepairConsult = async () => {
    setError(""); setSaving(true);
    try {
      await ensureConsult();
      await saveSection("walkthrough", { notes: walkthroughNotes, needsRepairs: true, pillars: pillarFlags, mortgageBalance, buyingToo, buyingNotes, timeline });
      onLaunchRepairConsult({ address: propertyAddress, name: clientName, email: clientEmail, phone: clientPhone, heroPhotoUrl, galleryUrls, flaggedPillars: flaggedPillarList() });
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  // v20.15.2 — second chance to flag repairs on Lock It In. Covers the case
  // where nothing looked obvious during the walkthrough but something came
  // up by the end of the appointment. v20.21.0 — no specific pillar to check
  // here (walkthrough is over), so this stays a plain flag; the Repair
  // Consult agent will ask the follow-up questions live.
  const handleLockinRepairFlag = async (v: "yes" | "no") => {
    setNeedsRepairs(v);
    if (v === "yes") {
      try { await saveSection("walkthrough", { notes: walkthroughNotes, needsRepairs: true, pillars: pillarFlags, mortgageBalance, buyingToo, buyingNotes, timeline }); }
      catch (e: any) { setError(e.message || "Failed to save."); }
    }
  };

  // v20.18.0 — Close only advances to Lock In for the two "ready" paths.
  // Outcome routing (FUB Active, Lead Depot signed lead, TC notify) does NOT
  // fire here — it fires only when "Send Listing Contract" is confirmed on
  // Lock In, since that's the real point of no return.
  const handleCloseNext = async () => {
    if (whereAreWe !== "ready_now" && whereAreWe !== "ready_repairs") { setError("Select where things stand before continuing."); return; }
    setError(""); setSaving(true);
    try {
      await saveSection("close", { whereAreWe, recommendedPrice, finalListingPrice, listingAgentCommission, buyerAgentCommission, additionalTerms });
      setStep("lockin");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  // v20.18.0 — inline "not moving forward" submit. Replaces the old
  // standalone Debrief page entirely. Ends the flow — no Lock In reached.
  const handleNotMovingSubmit = async () => {
    if (!notMovingReason) { setError("Select a reason before submitting."); return; }
    setError(""); setSendingNotMoving(true);
    try {
      const id = await ensureConsult();
      await saveSection("close", { whereAreWe: "not_moving", recommendedPrice, finalListingPrice, listingAgentCommission, buyerAgentCommission, additionalTerms }, id);
      await fetchJson(`/api/listing-consult/${id}/not-moving`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: notMovingReason, notes: notMovingNotes, followUpTiming: notMovingFollowUpTiming }),
      });
      setNotMovingSubmitted(true);
    } catch (e: any) { setError(e.message || "Failed to submit."); }
    finally { setSendingNotMoving(false); }
  };

  // v20.18.0 — validate required fields, save Lock In section, then show the
  // summary card. Nothing is sent to FUB/TC/Lead Depot until the summary is
  // confirmed (handleConfirmSendContract).
  const handleReviewContract = async () => {
    const missing: string[] = [];
    if (!ownerNames.trim()) missing.push("Owner 1 Legal Name");
    if (!propertyAddress.trim()) missing.push("Property Address");
    if (!finalListingPrice.trim()) missing.push("Final Listing Price");
    if (!accessKeyOrCode.trim()) missing.push("Access Key/Code");
    if (!showingApprovalContact) missing.push("Showing Approval Contact");
    if (showingApprovalContact === "other" && !showingContactOtherName.trim()) missing.push("Showing Contact Name");
    if (needsCleaning === "") missing.push("Cleaning Booked? (Yes/No)");
    if (missing.length) { setContractSendError(`Missing: ${missing.join(", ")}`); return; }
    setContractSendError(""); setError(""); setSaving(true);
    try {
      await saveSection("lockin", {
        needsCleaning, forecastStartDate,
        // Forecasted runway — informational only, never a hard commitment.
        // Saved as plain ISO dates so the TC email and any future summary can
        // render them without recomputing.
        repairWindowStart: timelineForecast?.repairStart ? toISO(timelineForecast.repairStart) : null,
        repairWindowEnd: timelineForecast?.repairEnd ? toISO(timelineForecast.repairEnd) : null,
        forecastCleaningDate: timelineForecast?.cleaningDay ? toISO(timelineForecast.cleaningDay) : null,
        photosScheduledDate: timelineForecast ? toISO(timelineForecast.photosScheduled) : null,
        photosBackDate: timelineForecast ? toISO(timelineForecast.photosBack) : null,
        goLiveDate: timelineForecast ? toISO(timelineForecast.goLive) : null,
        showingsBeginDate: timelineForecast ? toISO(timelineForecast.showingsBegin) : null,
        openHouseDate: timelineForecast ? toISO(timelineForecast.openHouse) : null,
        accessKeyOrCode, gateCode, ownerNames, ownerNames2, owner2Phone, owner2Email,
        showingApprovalContact, showingContactOtherName, showingContactOtherPhone, showingContactOtherEmail,
        showingRestrictions,
        showingContactName: derivedShowingContact.name,
        accessEmail: derivedShowingContact.email,
      });
      setShowContractSummary(true);
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleConfirmSendContract = async () => {
    if (!consultId) return;
    setSendingContract(true); setError("");
    try {
      await fetchJson(`/api/listing-consult/${consultId}/send-contract`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      setContractSent(true);
      setShowContractSummary(false);
    } catch (e: any) { setError(e.message || "Failed to send contract."); }
    finally { setSendingContract(false); }
  };

  const stepOrder = ["prep", "walkthrough", "close", (whereAreWe === "ready_now" || whereAreWe === "ready_repairs") ? "lockin" : null].filter(Boolean) as string[];
  const stepLabels: Record<string, string> = { prep: "Prep", walkthrough: "Walkthrough & Intel", close: "Present & Close", lockin: "Lock In" };
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

        {resumePhase === "checking" && <ResumeCheckingSpinner />}

        {resumePhase === "picking" && (
          <ConsultResumePicker
            title="Listing Consult"
            subtitle="Pick up an in-progress consult, or start a new one."
            items={resumeList}
            onResume={handleResumeConsult}
            onStartNew={() => setResumePhase("ready")}
            onArchive={handleArchiveConsult}
          />
        )}

        {resumePhase === "ready" && (
        <>
        {step === "prep" && (
          <>
            {header("Before You Arrive", "Property + client info, quick prep checklist")}
            <label style={labelStyle}>Find in FUB</label>
            <div style={{ position: "relative", marginBottom: 6 }}>
              <input
                style={inputStyle}
                value={fubQuery}
                onChange={e => { setFubQuery(e.target.value); setFubPickedName(null); setFubPersonId(null); }}
                placeholder="Type client name to search Follow Up Boss…"
                autoFocus
              />
              {fubSearching && (
                <Loader2 size={14} className="animate-spin" style={{ position: "absolute", right: 12, top: 13, color: GOLD }} />
              )}
              {fubResults.length > 0 && (
                <div style={{
                  position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20,
                  background: "#1a1815", border: "1px solid rgba(200,170,90,0.35)", borderRadius: 8,
                  maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                }}>
                  {fubResults.map(c => (
                    <button key={c.id} type="button" onClick={() => pickFubContact(c)} style={{
                      display: "block", width: "100%", textAlign: "left", padding: "9px 12px", cursor: "pointer",
                      background: "transparent", border: "none", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#fff",
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{[c.phone, c.email].filter(Boolean).join(" · ") || "No phone/email on file"}</div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>{c.address || "No address on file"}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.35)", marginTop: -2, marginBottom: 14 }}>
              Start here — selecting a match autofills name, phone, email, and their current home address below. You can still edit any of it. If FUB shows a nickname, you'll enter their full legal name separately on the Lock In step.
            </p>
            <label style={labelStyle}>Property Address</label>
            <input style={{ ...inputStyle, marginBottom: 14 }} value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} placeholder="123 Main St, Fernandina Beach, FL" />
            <label style={labelStyle}>Client Name</label>
            <input style={{ ...inputStyle, marginBottom: 14 }} value={clientName} onChange={e => { setClientName(e.target.value); setFubPickedName(null); }} placeholder="Client full name" />
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
            <label style={labelStyle}>Front of House Photo</label>
            <div style={{ marginBottom: 14 }}>
              {heroPhotoUrl ? (
                <div style={{ position: "relative" }}>
                  <img src={heroPhotoUrl} style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: 8 }} />
                  <label style={{ position: "absolute", bottom: 8, right: 8, background: "rgba(0,0,0,0.7)", borderRadius: 8, padding: "6px 10px", fontSize: 11, color: "#fff", cursor: "pointer" }}>
                    Retake
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => e.target.files?.[0] && handlePhotoPick(e.target.files[0], "hero")} />
                  </label>
                </div>
              ) : (
                <label style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  height: 120, borderRadius: 8, border: "1px dashed rgba(200,170,90,0.4)", cursor: "pointer", gap: 6,
                }}>
                  {uploadingHero ? <Loader2 size={22} className="animate-spin" style={{ color: GOLD }} /> : <Camera size={22} style={{ color: GOLD }} />}
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{uploadingHero ? "Uploading…" : "Tap to take or choose a photo"}</span>
                  <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => e.target.files?.[0] && handlePhotoPick(e.target.files[0], "hero")} />
                </label>
              )}
            </div>
            <label style={labelStyle}>Before-You-Arrive Checklist</label>
            {PREP_ITEMS.map(item => (
              <Chip key={item} label={item} checked={!!prepChecklist[item]} onToggle={() => toggleChip(prepChecklist, setPrepChecklist, item)} />
            ))}
            {navButtons({ onNext: handlePrepNext, nextBusy: creating || saving, nextDisabled: !propertyAddress.trim() })}
          </>
        )}

        {step === "walkthrough" && (
          <>
            {header("Walkthrough & Intel", "Interior & exterior notes, condition, and the numbers behind the decision")}
            <label style={labelStyle}>Interior / Exterior Notes</label>
            <textarea style={{ ...textareaStyle, marginBottom: 14 }} value={walkthroughNotes} onChange={e => setWalkthroughNotes(e.target.value)} placeholder="Condition, updates, anything notable while walking through" />
            <label style={labelStyle}>Condition Check — What Does This Home Need?</label>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -2, marginBottom: 10 }}>
              Check anything you're seeing right now and pick a size — this is scoping, not a quote. The Repair Consult (once they sign) is where we lock in real numbers.
            </p>
            {PILLAR_DEFS.map(def => {
              const st = pillarFlags[def.key];
              return (
                <div key={def.key} style={{ ...cardStyle, marginBottom: 10, padding: 12 }}>
                  <button type="button" onClick={() => togglePillar(def.key)} style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    background: "none", border: "none", cursor: "pointer", padding: 0,
                    color: st.checked ? GOLD : "rgba(255,255,255,0.85)", fontSize: 13.5, fontWeight: st.checked ? 700 : 600,
                  }}>
                    <span style={{
                      width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                      border: st.checked ? "none" : "1.5px solid rgba(255,255,255,0.3)",
                      background: st.checked ? GOLD : "transparent",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {st.checked && <CheckCircle2 size={14} style={{ color: "#0c0b0a" }} />}
                    </span>
                    {def.label}
                    {def.group === "addon" && (
                      <span style={{ fontSize: 9.5, color: "rgba(255,255,255,0.35)", fontWeight: 600, marginLeft: "auto", textTransform: "uppercase" }}>Add-On</span>
                    )}
                  </button>
                  {st.checked && (
                    <div style={{ marginTop: 10, paddingLeft: 28 }}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                        {def.tiers.map(t => (
                          <button key={t.key} type="button" onClick={() => setPillarTier(def.key, t.key)} title={t.label} style={{
                            flex: 1, padding: "8px 6px", borderRadius: 7, cursor: "pointer", fontSize: 10.5, fontWeight: 700,
                            background: st.tier === t.key ? GOLD : "rgba(255,255,255,0.06)",
                            border: st.tier === t.key ? "none" : "1px solid rgba(255,255,255,0.15)",
                            color: st.tier === t.key ? "#0c0b0a" : "rgba(255,255,255,0.75)",
                          }}>{t.key === "small" ? "S" : t.key === "medium" ? "M" : "L"}</button>
                        ))}
                      </div>
                      {st.tier && (
                        <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", margin: "0 0 8px" }}>
                          {def.tiers.find(t => t.key === st.tier)?.label}
                        </p>
                      )}
                      {def.details && def.details.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <p style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(255,255,255,0.35)", letterSpacing: "0.06em", textTransform: "uppercase", margin: "0 0 5px" }}>
                            What needs it? (check what applies)
                          </p>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                            {def.details.map(dtl => {
                              const isOn = (st.details || []).includes(dtl.key);
                              return (
                                <button key={dtl.key} type="button" onClick={() => toggleDetail(def.key, dtl.key)} style={{
                                  display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 6, cursor: "pointer",
                                  fontSize: 11, fontWeight: 600, background: isOn ? "rgba(200,170,90,0.16)" : "rgba(255,255,255,0.05)",
                                  border: isOn ? `1px solid ${GOLD}` : "1px solid rgba(255,255,255,0.15)",
                                  color: isOn ? GOLD : "rgba(255,255,255,0.65)",
                                }}>
                                  {isOn && <CheckCircle2 size={11} />}
                                  {dtl.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      <input style={{ ...inputStyle, fontSize: 12 }} value={st.notes} onChange={e => setPillarNotes(def.key, e.target.value)}
                        placeholder="Specifics — which rooms, sqft, condition notes…" />
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ marginBottom: 4 }} />
            {flaggedPillarList().length > 0 && (
              <div style={{ ...cardStyle, marginBottom: 14, border: `1px solid rgba(200,170,90,0.35)` }}>
                <label style={labelStyle}>Scope Photos — Evidence ({scopePhotoUrls.length})</label>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -2, marginBottom: 10 }}>
                  A second, separate moment — while you're standing right there, grab close-ups of exactly what you just flagged: {flaggedPillarList().map(p => p.label + (p.details.length ? ` (${p.details.join(", ").replace(/_/g, " ")})` : "")).join(" · ")}. These become the repair quote evidence — walkthrough shots above cover the whole property, these cover the specific problem spots.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {scopePhotoUrls.map((url, i) => (
                    <img key={i} src={url} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6, display: "block", border: `1px solid ${GOLD}` }} />
                  ))}
                  <label style={{
                    width: 72, height: 72, borderRadius: 6, border: "1px dashed rgba(200,170,90,0.6)",
                    display: "flex", alignItems: "center", justifyContent: "center", cursor: uploadingGallery ? "default" : "pointer", opacity: uploadingGallery ? 0.6 : 1,
                  }}>
                    {uploadingGallery ? <Loader2 size={16} className="animate-spin" style={{ color: GOLD }} /> : <Camera size={16} style={{ color: GOLD }} />}
                    <input type="file" accept="image/*" multiple disabled={uploadingGallery} style={{ display: "none" }}
                      onChange={e => { if (e.target.files && e.target.files.length > 0) handleBulkGalleryUpload(e.target.files, "scope"); e.target.value = ""; }} />
                  </label>
                </div>
              </div>
            )}
            <div style={cardStyle}>
              <label style={labelStyle}>Walkthrough Photos ({galleryUrls.length})</label>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -2, marginBottom: 10 }}>
                All 4 sides + yard, every room, then close-up + wide shots of anything you're flagging above. Shoot live as you walk or add from your camera after — bulk-select and upload as many at once as you want. Rule of thumb: if it's not photographed, it can't be quoted.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {galleryUrls.map((url, i) => (
                  <img key={i} src={url} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6, display: "block" }} />
                ))}
                <label style={{
                  width: 72, height: 72, borderRadius: 6, border: "1px dashed rgba(200,170,90,0.4)",
                  display: "flex", alignItems: "center", justifyContent: "center", cursor: uploadingGallery ? "default" : "pointer", opacity: uploadingGallery ? 0.6 : 1,
                }}>
                  {uploadingGallery ? <Loader2 size={16} className="animate-spin" style={{ color: GOLD }} /> : <Camera size={16} style={{ color: GOLD }} />}
                  <input type="file" accept="image/*" multiple disabled={uploadingGallery} style={{ display: "none" }}
                    onChange={e => { if (e.target.files && e.target.files.length > 0) handleBulkGalleryUpload(e.target.files); e.target.value = ""; }} />
                </label>
              </div>
              {uploadingGallery && galleryProgress && (
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 8 }}>
                  Uploading photo {Math.min(galleryProgress.done + 1, galleryProgress.total)} of {galleryProgress.total}…
                </p>
              )}
            </div>
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
            {navButtons({ onBack: () => setStep("prep"), onNext: handleWalkthroughNext, nextBusy: saving })}
          </>
        )}

        {step === "close" && (
          <>
            {header("Present & Close", "The price, and where things stand")}
            <label style={labelStyle}>Recommended List Price (optional)</label>
            <input style={{ ...inputStyle, marginBottom: 14 }} value={recommendedPrice} onChange={e => setRecommendedPrice(e.target.value)} placeholder="$" />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Final Listing Price (what the seller agreed to)</label>
              {!!recommendedPrice.trim() && (
                <button type="button" onClick={() => setFinalListingPrice(recommendedPrice)} style={{
                  background: "none", border: "none", color: GOLD, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0,
                }}>Same as Recommended</button>
              )}
            </div>
            <input style={{ ...inputStyle, marginBottom: 14 }} value={finalListingPrice} onChange={e => setFinalListingPrice(e.target.value)} placeholder="$" />

            <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Listing Agent Commission</label>
                <div style={{ position: "relative" }}>
                  <input style={{ ...inputStyle, paddingRight: 26 }} value={listingAgentCommission} onChange={e => setListingAgentCommission(e.target.value)} placeholder="3.0" inputMode="decimal" />
                  <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.4)", fontSize: 13, pointerEvents: "none" }}>%</span>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Buyer's Agent Commission</label>
                <div style={{ position: "relative" }}>
                  <input style={{ ...inputStyle, paddingRight: 26 }} value={buyerAgentCommission} onChange={e => setBuyerAgentCommission(e.target.value)} placeholder="2.5" inputMode="decimal" />
                  <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.4)", fontSize: 13, pointerEvents: "none" }}>%</span>
                </div>
              </div>
            </div>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", margin: "0 0 18px" }}>Auto-filled at the Brothers Group standard split — adjust here if this deal is different.</p>

            <label style={labelStyle}>Additional Terms & Conditions (optional)</label>
            <textarea style={{ ...textareaStyle, marginBottom: 18 }} value={additionalTerms} onChange={e => setAdditionalTerms(e.target.value)} placeholder="Anything else that needs to be written into the listing agreement" />

            <label style={labelStyle}>Where Are We?</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {[
                { key: "ready_now", label: "Ready — start now" },
                { key: "ready_repairs", label: "Ready — repairs first" },
                { key: "not_moving", label: "Not moving forward" },
              ].map(o => (
                <button key={o.key} type="button" onClick={() => setWhereAreWe(o.key as any)} style={{
                  textAlign: "left", padding: "12px 14px", borderRadius: 10, cursor: "pointer", fontSize: 13.5, fontWeight: 700,
                  background: whereAreWe === o.key ? "rgba(200,170,90,0.14)" : "rgba(255,255,255,0.04)",
                  border: whereAreWe === o.key ? "1px solid rgba(200,170,90,0.5)" : "1px solid rgba(255,255,255,0.1)",
                  color: whereAreWe === o.key ? GOLD : "rgba(255,255,255,0.8)",
                }}>{o.label}</button>
              ))}
            </div>

            {whereAreWe === "not_moving" && !notMovingSubmitted && (
              <div style={cardStyle}>
                <label style={labelStyle}>Consult Result</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  {NOT_MOVING_OPTIONS.map(o => (
                    <button key={o.key} type="button" onClick={() => setNotMovingReason(o.key as any)} style={{
                      textAlign: "left", padding: "10px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
                      background: notMovingReason === o.key ? "rgba(200,170,90,0.14)" : "rgba(255,255,255,0.04)",
                      border: notMovingReason === o.key ? "1px solid rgba(200,170,90,0.5)" : "1px solid rgba(255,255,255,0.1)",
                      color: notMovingReason === o.key ? GOLD : "rgba(255,255,255,0.8)",
                    }}>{o.label}</button>
                  ))}
                </div>
                {(notMovingReason === "pending_repair_quote" || notMovingReason === "other_reason") && (
                  <>
                    <label style={labelStyle}>Follow-up Timing</label>
                    <input style={{ ...inputStyle, marginBottom: 12 }} value={notMovingFollowUpTiming} onChange={e => setNotMovingFollowUpTiming(e.target.value)} placeholder="e.g. 2 weeks, after repair quote, next spring" />
                  </>
                )}
                <label style={labelStyle}>Notes (optional)</label>
                <textarea style={textareaStyle} value={notMovingNotes} onChange={e => setNotMovingNotes(e.target.value)} placeholder="Anything worth remembering for next time" />
                <button type="button" onClick={handleNotMovingSubmit} disabled={!notMovingReason || sendingNotMoving} style={{
                  width: "100%", marginTop: 14, padding: "12px 18px", borderRadius: 10,
                  background: GOLD, border: "none", color: "#0c0b0a", fontSize: 13.5, fontWeight: 700,
                  cursor: !notMovingReason || sendingNotMoving ? "not-allowed" : "pointer", opacity: !notMovingReason || sendingNotMoving ? 0.5 : 1,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}>
                  {sendingNotMoving ? <Loader2 size={15} className="animate-spin" /> : null}
                  Submit
                </button>
              </div>
            )}

            {whereAreWe === "not_moving" && notMovingSubmitted && (
              <div style={{ padding: 12, borderRadius: 10, background: "rgba(126,212,154,0.1)", color: "#7ed49a", fontSize: 12.5, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <CheckCircle2 size={16} /> Logged. Office has been notified.
              </div>
            )}

            {whereAreWe === "not_moving" ? (
              notMovingSubmitted && (
                <button onClick={onClose} style={{
                  width: "100%", padding: "12px 18px", borderRadius: 10, background: "transparent",
                  border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 600, cursor: "pointer",
                }}>Done</button>
              )
            ) : (
              navButtons({ onBack: () => setStep("walkthrough"), onNext: handleCloseNext, nextBusy: saving, nextDisabled: !whereAreWe, nextLabel: "Lock It In" })
            )}
          </>
        )}

        {step === "lockin" && (
          <>
            {header("Lock It In", "Cleaning, access, and the final contract send")}

            <label style={labelStyle}>Cleaning Before Photos</label>
            {!cleaningManualOverride ? (
              <div style={{ ...cardStyle, marginBottom: 14 }}>
                <p style={{ fontSize: 13, color: "#fff", margin: 0, fontWeight: 600 }}>
                  {needsCleaning === "yes"
                    ? `Yes — flagged as Deep Cleaning (${{ small: "Small", medium: "Medium", large: "Large" }[pillarFlags.deep_clean.tier || "small"]}) during the walkthrough.`
                    : "No — Deep Cleaning wasn't flagged during the walkthrough."}
                </p>
                {needsCleaning === "yes" && (
                  <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)", margin: "6px 0 0" }}>
                    Noted — cleaning will show up as an option on the instant quote once the contract sends. We're realtors, not cleaning schedulers.
                  </p>
                )}
                <button type="button" onClick={() => setCleaningManualOverride(true)} style={{
                  marginTop: 8, background: "none", border: "none", padding: 0, cursor: "pointer",
                  fontSize: 11, color: GOLD, textDecoration: "underline", fontWeight: 600,
                }}>
                  Something changed? Override
                </button>
              </div>
            ) : (
              <div style={{ marginBottom: 14 }}>
                <div style={{ marginBottom: 8 }}>
                  {segmented(needsCleaning, [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], v => setNeedsCleaning(v as any))}
                </div>
                {needsCleaning === "yes" && (
                  <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)", margin: "0 0 8px" }}>
                    Noted — cleaning will show up as an option on the instant quote once the contract sends. We're realtors, not cleaning schedulers.
                  </p>
                )}
                <button type="button" onClick={() => setCleaningManualOverride(false)} style={{
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  fontSize: 11, color: "rgba(255,255,255,0.4)", textDecoration: "underline",
                }}>
                  Use walkthrough flag instead
                </button>
              </div>
            )}

            {whereAreWe === "ready_repairs" && (
              <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)", margin: "0 0 14px" }}>
                Repairs are locked in — we'll send the instant quote for what we feel the home needs. Scheduling the actual work happens after the contract, not here.
              </p>
            )}

            {timelineForecast && (
              <div style={cardStyle}>
                <label style={labelStyle}>Timeline Forecast</label>
                <div style={{ marginBottom: 10 }}>
                  <label style={{ ...labelStyle, fontSize: 10.5 }}>Start Date</label>
                  <input type="date" style={inputStyle} value={forecastStartDate} onChange={e => handleForecastStartChange(e.target.value)} />
                </div>
                <table style={{ width: "100%", fontSize: 12.5, color: "rgba(255,255,255,0.85)", borderCollapse: "collapse" }}>
                  <tbody>
                    {timelineForecast.showRepairWindow && (
                      <>
                        <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "4px 0" }}>Repairs Start</td><td style={{ padding: "4px 0" }}><input type="date" style={forecastDateInputStyle} value={toISO(timelineForecast.repairStart!)} onChange={e => handleForecastDateEdit("repairStart", e.target.value)} /></td></tr>
                        <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "4px 0" }}>Repairs End</td><td style={{ padding: "4px 0" }}><input type="date" style={forecastDateInputStyle} value={toISO(timelineForecast.repairEnd!)} onChange={e => handleForecastDateEdit("repairEnd", e.target.value)} /></td></tr>
                      </>
                    )}
                    {needsCleaning === "yes" && timelineForecast.cleaningDay && (
                      <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "4px 0" }}>Cleaning</td><td style={{ padding: "4px 0" }}><input type="date" style={forecastDateInputStyle} value={toISO(timelineForecast.cleaningDay)} onChange={e => handleForecastDateEdit("cleaningDay", e.target.value)} /></td></tr>
                    )}
                    <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "4px 0" }}>Photos Scheduled</td><td style={{ padding: "4px 0" }}><input type="date" style={forecastDateInputStyle} value={toISO(timelineForecast.photosScheduled)} onChange={e => handleForecastDateEdit("photosScheduled", e.target.value)} /></td></tr>
                    <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "4px 0" }}>Photo/Video Back</td><td style={{ padding: "4px 0" }}><input type="date" style={forecastDateInputStyle} value={toISO(timelineForecast.photosBack)} onChange={e => handleForecastDateEdit("photosBack", e.target.value)} /></td></tr>
                    <tr><td style={{ color: GOLD, padding: "6px 0", fontWeight: 700 }}>Go-Live</td><td style={{ padding: "6px 0", fontWeight: 700, color: GOLD }}><input type="date" style={{ ...forecastDateInputStyle, color: GOLD, fontWeight: 700 }} value={toISO(timelineForecast.goLive)} onChange={e => handleForecastDateEdit("goLive", e.target.value)} /></td></tr>
                    <tr><td style={{ color: GOLD, padding: "6px 0", fontWeight: 700 }}>Open House</td><td style={{ padding: "6px 0", fontWeight: 700, color: GOLD }}><input type="date" style={{ ...forecastDateInputStyle, color: GOLD, fontWeight: 700 }} value={toISO(timelineForecast.openHouse)} onChange={e => handleForecastDateEdit("openHouse", e.target.value)} /></td></tr>
                  </tbody>
                </table>
                <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.35)", margin: "8px 0 0", fontStyle: "italic" }}>Every date above is editable — tap any of them to override. Forecasted from the start date, this goes out with the contract; nothing here is booked yet.</p>
              </div>
            )}

            {needsRepairs === "yes" ? (
              <div style={cardStyle}>
                <label style={labelStyle}>Repairs Flagged During Walkthrough</label>
                {flaggedPillarList().length > 0 ? (
                  <div style={{ marginTop: 2 }}>
                    {flaggedPillarList().map(p => (
                      <div key={p.key} style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                        <span style={{ color: GOLD, fontWeight: 700 }}>{p.label}</span>
                        {p.tier && <span style={{ marginLeft: 6, textTransform: "uppercase", fontSize: 10, color: "rgba(255,255,255,0.45)" }}>{p.tier}</span>}
                        {p.notes && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 1 }}>{p.notes}</div>}
                      </div>
                    ))}
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 8, marginBottom: 0 }}>
                      We'll scope it and build the real quote once they've signed on — right after the contract sends below.
                    </p>
                  </div>
                ) : (
                  <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)", marginTop: -2, marginBottom: 0 }}>
                    Noted — the home will need at least some touch-up (pressure wash, deep clean, lawn cut, or more) to show its best.
                    {" "}We'll scope it and build the real quote once they've signed on — right after the contract sends below.
                  </p>
                )}
              </div>
            ) : (
              <div style={cardStyle}>
                <label style={labelStyle}>Anything Come Up Needing Repair?</label>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -2, marginBottom: 10 }}>
                  Didn't flag anything during the walkthrough — if something came up by the end of the visit, flag it now while they're still saying yes.
                </p>
                {segmented(needsRepairs, [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], v => handleLockinRepairFlag(v as "yes" | "no"))}
              </div>
            )}

            <label style={{ ...labelStyle, marginTop: 10 }}>Access</label>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <input style={inputStyle} value={accessKeyOrCode} onChange={e => setAccessKeyOrCode(e.target.value)} placeholder="Key or Code?" />
              <input style={inputStyle} value={gateCode} onChange={e => setGateCode(e.target.value)} placeholder="Gate Code?" />
            </div>
            <input style={{ ...inputStyle, marginBottom: showOwner2 ? 8 : 6 }} value={ownerNames} onChange={e => setOwnerNames(e.target.value)} placeholder={showOwner2 ? "Owner 1 Full Legal Name" : "Owner Full Legal Name"} />
            {showOwner2 ? (
              <>
                <label style={{ ...labelStyle, marginTop: 2 }}>Find Owner 2 in FUB</label>
                <div style={{ position: "relative", marginBottom: 8 }}>
                  <input style={inputStyle} value={owner2Query} onChange={e => setOwner2Query(e.target.value)} placeholder="Type owner name to search Follow Up Boss…" />
                  {owner2Searching && (
                    <Loader2 size={14} className="animate-spin" style={{ position: "absolute", right: 12, top: 13, color: GOLD }} />
                  )}
                  {owner2Results.length > 0 && (
                    <div style={{
                      position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20,
                      background: "#1a1815", border: "1px solid rgba(200,170,90,0.35)", borderRadius: 8,
                      maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    }}>
                      {owner2Results.map(c => (
                        <button key={c.id} type="button" onClick={() => pickOwner2Contact(c)} style={{
                          display: "block", width: "100%", textAlign: "left", padding: "9px 12px", cursor: "pointer",
                          background: "transparent", border: "none", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#fff",
                        }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{[c.phone, c.email].filter(Boolean).join(" · ") || "No phone/email on file"}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input style={{ ...inputStyle, marginBottom: 8 }} value={ownerNames2} onChange={e => setOwnerNames2(e.target.value)} placeholder="Owner 2 Full Legal Name" />
                <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                  <input style={inputStyle} value={owner2Phone} onChange={e => setOwner2Phone(e.target.value)} placeholder="Owner 2 Phone" />
                  <input style={inputStyle} value={owner2Email} onChange={e => setOwner2Email(e.target.value)} placeholder="Owner 2 Email" />
                </div>
              </>
            ) : (
              <button type="button" onClick={() => setShowOwner2(true)} style={{
                background: "none", border: "none", color: GOLD, fontSize: 12, fontWeight: 600, cursor: "pointer",
                padding: 0, marginBottom: 12, display: "block",
              }}>+ Add Second Owner</button>
            )}

            <label style={{ ...labelStyle, marginTop: 12 }}>Showing Approval Contact</label>
            <div style={{ marginBottom: 10 }}>
              {segmented(showingApprovalContact, [
                { key: "owner1", label: "Owner 1" },
                ...(showOwner2 ? [{ key: "owner2", label: "Owner 2" }] : []),
                { key: "other", label: "Other" },
              ], v => setShowingApprovalContact(v as any))}
            </div>
            {showingApprovalContact === "other" && (
              <>
                <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                  <input style={inputStyle} value={showingContactOtherName} onChange={e => setShowingContactOtherName(e.target.value)} placeholder="Name" />
                  <input style={inputStyle} value={showingContactOtherPhone} onChange={e => setShowingContactOtherPhone(e.target.value)} placeholder="Phone" />
                </div>
                <input style={{ ...inputStyle, marginBottom: 10 }} value={showingContactOtherEmail} onChange={e => setShowingContactOtherEmail(e.target.value)} placeholder="Email" />
              </>
            )}
            <label style={labelStyle}>Showing Restrictions (optional)</label>
            <input style={{ ...inputStyle, marginBottom: 10 }} value={showingRestrictions} onChange={e => setShowingRestrictions(e.target.value)} placeholder="e.g. 24-hr notice, no showings after 6pm, dog on premises" />
            <label style={labelStyle}>Access Email</label>
            <input style={{ ...inputStyle, marginBottom: 16, opacity: 0.6 }} value={derivedShowingContact.email} readOnly placeholder="Auto-filled from Showing Approval Contact" />

            {contractSendError && (
              <div style={{ padding: 10, marginBottom: 12, borderRadius: 8, background: "rgba(255,120,120,0.1)", color: "#ffb0b0", fontSize: 12.5 }}>{contractSendError}</div>
            )}

            {!contractSent ? (
              navButtons({ onBack: () => setStep("close"), onNext: handleReviewContract, nextBusy: saving, nextLabel: "Review & Send Listing Contract" })
            ) : (
              <>
                <div style={{ padding: 12, borderRadius: 10, background: "rgba(126,212,154,0.1)", color: "#7ed49a", fontSize: 12.5, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                  <CheckCircle2 size={16} /> Contract sent — TC notified to open the file.
                </div>
                {needsRepairs === "yes" && (
                  <div style={{ ...cardStyle, marginBottom: 14 }}>
                    <label style={labelStyle}>They're Committed — Price The Touch-Up</label>
                    <button type="button" onClick={handleOpenRepairConsult} disabled={saving} style={{
                      width: "100%", padding: "12px 14px", borderRadius: 10, cursor: saving ? "default" : "pointer",
                      background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)",
                      color: "#fff", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    }}>
                      {saving ? <Loader2 size={15} className="animate-spin" /> : <Wrench size={15} style={{ color: GOLD }} />}
                      Open Repair Consult
                    </button>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 8, marginBottom: 0 }}>
                      Now that the listing agreement is sent, scope items and build the real instant quote. Nate or Alex still has to approve it before it goes to the client.
                    </p>
                  </div>
                )}
                <button onClick={onClose} style={{
                  width: "100%", padding: "12px 18px", borderRadius: 10, background: "transparent",
                  border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 600, cursor: "pointer",
                }}>Done</button>
              </>
            )}
          </>
        )}
        </>
        )}
      </div>

      {showContractSummary && (
        <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={() => setShowContractSummary(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.8)" }} />
          <div style={{ position: "relative", zIndex: 1, background: "#141414", border: "1px solid rgba(200,170,90,0.4)", borderRadius: 16, padding: 22, maxWidth: 380, width: "100%", maxHeight: "80dvh", overflowY: "auto" }}>
            <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 20, color: "#fff", margin: "0 0 12px" }}>Confirm & Send</h3>
            <table style={{ width: "100%", fontSize: 12.5, color: "rgba(255,255,255,0.85)", borderCollapse: "collapse" }}>
              <tbody>
                <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", width: 100, verticalAlign: "top" }}>Address</td><td style={{ padding: "5px 0" }}>{propertyAddress}</td></tr>
                <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", verticalAlign: "top" }}>Owner(s)</td><td style={{ padding: "5px 0" }}>{[ownerNames, ownerNames2].filter(Boolean).join(" & ") || "—"}</td></tr>
                <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", verticalAlign: "top" }}>Final Price</td><td style={{ padding: "5px 0" }}>{finalListingPrice || "—"}</td></tr>
                <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", verticalAlign: "top" }}>Commission</td><td style={{ padding: "5px 0" }}>{listingAgentCommission || "3.0"}% listing / {buyerAgentCommission || "2.5"}% buyer's</td></tr>
                {!!additionalTerms.trim() && (
                  <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", verticalAlign: "top" }}>Add'l Terms</td><td style={{ padding: "5px 0" }}>{additionalTerms}</td></tr>
                )}
                <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", verticalAlign: "top" }}>Timeline</td><td style={{ padding: "5px 0" }}>{timeline || "—"}</td></tr>
                <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", verticalAlign: "top" }}>Path</td><td style={{ padding: "5px 0" }}>{whereAreWe === "ready_repairs" ? "Ready — repairs first" : "Ready — start now"}</td></tr>
              </tbody>
            </table>
            {error && (
              <div style={{ padding: 10, marginTop: 12, borderRadius: 8, background: "rgba(255,120,120,0.1)", color: "#ffb0b0", fontSize: 12.5 }}>{error}</div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={() => setShowContractSummary(false)} style={{
                flex: "0 0 auto", padding: "12px 18px", borderRadius: 10, background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.75)", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>Back</button>
              <button onClick={handleConfirmSendContract} disabled={sendingContract} style={{
                flex: 1, padding: "12px 18px", borderRadius: 10, background: GOLD, border: "none", color: "#0c0b0a",
                fontSize: 13.5, fontWeight: 700, cursor: sendingContract ? "not-allowed" : "pointer", opacity: sendingContract ? 0.6 : 1,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              }}>
                {sendingContract ? <Loader2 size={15} className="animate-spin" /> : null} Confirm & Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
