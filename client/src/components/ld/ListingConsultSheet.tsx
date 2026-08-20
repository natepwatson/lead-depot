// v20.14.0 — Listing Consult. Full-screen wizard that walks an agent through
// the entire Seller Meet & Greet appointment (per Brothers Group's printed
// Listing Flow, page 1) without needing to stay glued to their phone — a
// handful of quick taps/fields per step, big checklist chips, minimal typing.
// The repair-scoping question lives inside Step 2 (Preview the Home) and can
// hand off into the existing Repair Consult tool mid-appointment; the parent
// (AgentView) is responsible for swapping back to this sheet when that closes.
import { useState, useEffect } from "react";
import { CheckCircle2, ChevronRight, ChevronLeft, X, Wrench, Loader2, Camera } from "lucide-react";
import { ConsultResumePicker, ResumeCheckingSpinner, type ResumeItem } from "./ConsultResumePicker";

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
// v20.15.0 — removed the standalone "CMA Pricing & Pay-at-Close Reno" step
// (was an instructional 4-tier reference table). This tool is for quick
// intel-gathering during the appointment, not for walking the client through
// educational content on-screen — that conversation happens live, off-app.
// The functional fields that step actually captured (recommended price,
// reviewed-comps confirmation) moved into the Close step below.

export function ListingConsultSheet({
  leadId, agentId, initialAddress, initialClientName, initialClientEmail, initialClientPhone, onClose, onLaunchRepairConsult,
}: {
  leadId?: number | null; agentId?: number | null;
  initialAddress?: string; initialClientName?: string; initialClientEmail?: string; initialClientPhone?: string;
  onClose: () => void;
  onLaunchRepairConsult: (prefill: { address: string; name: string; email: string; phone: string; heroPhotoUrl?: string | null }) => void;
}) {
  const [step, setStep] = useState<"prep" | "preview" | "intel" | "presentation" | "close" | "lockin" | "debrief">("prep");
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
  // while it's mounted. This sheet was missing it, so typing into any of its
  // many text fields opened the iOS keyboard, which resizes the visualViewport
  // but not the layout viewport — leaving the nav's position:fixed;bottom:0
  // to "float" up into the middle of the screen. Matches RepairConsultSheet's
  // effect exactly.
  useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);

  // v20.14.5 — check for a resumable in-progress consult on every mount.
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
  // v20.15.0 — front-of-house photo captured right on the Prep step (the
  // first page of the appointment), and the full interior/exterior
  // walkthrough gallery captured on the Preview step — mirrors
  // RepairConsultSheet's hero + gallery pattern so both tools feel like one
  // continuous consultation.
  const [heroPhotoUrl, setHeroPhotoUrl] = useState<string | null>(null);
  const [uploadingHero, setUploadingHero] = useState(false);
  const [galleryUrls, setGalleryUrls] = useState<string[]>([]);
  const [uploadingGallery, setUploadingGallery] = useState(false);
  const [galleryProgress, setGalleryProgress] = useState<{ done: number; total: number } | null>(null);

  // v20.15.0 — live FUB contact picker. Agent types a name, we search FUB's
  // cached people list server-side, tap a result to autofill phone/email.
  // Full legal name (which may differ from FUB's nickname/display name)
  // stays a separate, always-manual field on the Lock In step.
  const [fubQuery, setFubQuery] = useState("");
  const [fubResults, setFubResults] = useState<{ id: number; name: string; email: string | null; phone: string | null }[]>([]);
  const [fubSearching, setFubSearching] = useState(false);
  const [fubPickedName, setFubPickedName] = useState<string | null>(null);

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

  const pickFubContact = (c: { name: string; email: string | null; phone: string | null }) => {
    setClientName(c.name);
    if (c.email) setClientEmail(c.email);
    if (c.phone) setClientPhone(c.phone);
    setFubPickedName(c.name);
    setFubQuery(c.name);
    setFubResults([]);
  };

  // v20.15.0 — Lock In's Access Phone/Email were a separate blank state from
  // the client contact info gathered on Prep, forcing the agent to retype
  // what they already entered (or picked from FUB). Default them once, the
  // first time the agent reaches Lock In, without stomping anything they've
  // already typed there themselves.
  useEffect(() => {
    if (step === "lockin") {
      if (!accessPhone && clientPhone) setAccessPhone(clientPhone);
      if (!accessEmail && clientEmail) setAccessEmail(clientEmail);
    }
  }, [step]);

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
  const [reviewedComps, setReviewedComps] = useState(false);

  const [readyToStart, setReadyToStart] = useState<"" | "yes" | "no">("");
  // v20.14.4 — the price the seller actually agreed to list at, captured once
  // they say yes — distinct from recommendedPrice above, which is the agent's
  // CMA-driven suggestion before the negotiation happens.
  const [finalListingPrice, setFinalListingPrice] = useState("");
  const [startTiming, setStartTiming] = useState<"" | "now" | "later">("");
  const [repairsOrReady, setRepairsOrReady] = useState<"" | "repairs" | "ready">("");
  const [holdingBack, setHoldingBack] = useState("");

  const [lockinSchedule, setLockinSchedule] = useState<ChecklistState>({});
  // v20.14.4 — optional target date per Lock In schedule item, captured live
  // at the appointment so nothing has to be chased down after the fact.
  const [lockinScheduleDates, setLockinScheduleDates] = useState<Record<string, string>>({});
  // v20.15.1 — optional target time alongside the date, so the schedule row
  // captures a real appointment window, not just a day.
  const [lockinScheduleTimes, setLockinScheduleTimes] = useState<Record<string, string>>({});
  const [accessKeyOrCode, setAccessKeyOrCode] = useState("");
  const [gateCode, setGateCode] = useState("");
  const [ownerNames, setOwnerNames] = useState("");
  // v20.14.4 — most listings have two owners on title; second is optional.
  const [ownerNames2, setOwnerNames2] = useState("");
  const [showOwner2, setShowOwner2] = useState(false);
  // v20.15.1 — Owner 2 phone/email, sourced from FUB search first (same
  // pattern as the Write Offer buyer search) with manual entry as fallback.
  const [owner2Query, setOwner2Query] = useState("");
  const [owner2Results, setOwner2Results] = useState<{ id: number; name: string; email: string | null; phone: string | null }[]>([]);
  const [owner2Searching, setOwner2Searching] = useState(false);
  const [owner2Phone, setOwner2Phone] = useState("");
  const [owner2Email, setOwner2Email] = useState("");
  const [accessPhone, setAccessPhone] = useState("");
  const [accessEmail, setAccessEmail] = useState("");
  const [contractSent, setContractSent] = useState(false);

  // v20.15.1 — Owner 2 FUB search. Mirrors the Write Offer buyer pattern:
  // the search box only autofills phone/email, never the legal-name field
  // below it — FUB's display name can be a nickname, but the Lock In step
  // needs the name exactly as it should appear on the contract.
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

  // v20.15.0 — hero + gallery photo upload, mirrors RepairConsultSheet exactly.
  const handlePhotoPick = async (file: File, kind: "hero" | "gallery") => {
    const id = await ensureConsult();
    const setBusy = kind === "hero" ? setUploadingHero : setUploadingGallery;
    setBusy(true);
    try {
      const conv = await fileToImageData(file);
      if (!conv) { setError("Couldn't read that photo. Try another."); setBusy(false); return; }
      const d = await fetchJson(`/api/listing-consult/${id}/photo`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: conv.imageData, mimeType: conv.mimeType, kind }),
      });
      if (kind === "hero") setHeroPhotoUrl(d.url);
      else setGalleryUrls(prev => [...prev, d.url]);
    } catch (e: any) { setError(e.message || "Photo upload failed."); }
    finally { setBusy(false); }
  };

  const handleBulkGalleryUpload = async (files: FileList) => {
    const id = await ensureConsult();
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;
    setUploadingGallery(true);
    setGalleryProgress({ done: 0, total: fileArr.length });
    for (let i = 0; i < fileArr.length; i++) {
      try {
        const conv = await fileToImageData(fileArr[i]);
        if (conv) {
          const d = await fetchJson(`/api/listing-consult/${id}/photo`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageData: conv.imageData, mimeType: conv.mimeType, kind: "gallery" }),
          });
          setGalleryUrls(prev => [...prev, d.url]);
        }
      } catch (e: any) { setError(e.message || `Photo ${i + 1} of ${fileArr.length} failed to upload — the rest kept going.`); }
      setGalleryProgress({ done: i + 1, total: fileArr.length });
    }
    setUploadingGallery(false);
    setGalleryProgress(null);
  };

  // v20.14.5 — Hydrate every field from a previously-started consult (the
  // section-by-section `data` JSON blob + top-level row) so resuming feels
  // like the appointment never paused. Determines which step to land on by
  // walking the sections from most-advanced to least.
  // v20.14.6 — Lock In's six granular access fields are now persisted
  // individually (see handleLockinNext) and hydrated below, closing the gap
  // flagged in v20.14.5. Consults saved before v20.14.6 won't have these keys
  // in their stored `data.lockin` — they'll simply come back blank, same as
  // before, with no error.
  // v20.14.6 — Archive (soft-delete) a consult straight from the resume
  // picker without opening it. Optimistically drops it from the local list;
  // if the request fails, put it back and surface the error.
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

  const handleResumeConsult = async (id: number) => {
    setResumePhase("ready"); setError("");
    try {
      const d = await fetchJson(`/api/listing-consult/${id}`);
      setConsultId(d.id);
      setClientName(d.client_name || "");
      setClientEmail(d.client_email || "");
      setClientPhone(d.client_phone || "");
      setPropertyAddress(d.property_address || "");
      setHeroPhotoUrl(d.hero_photo_url || null);
      setGalleryUrls(Array.isArray(d.gallery_photos) ? d.gallery_photos : []);

      const data = d.data || {};
      let nextStep: typeof step = "prep";

      if (data.prep) { setPrepChecklist(data.prep.checklist || {}); nextStep = "preview"; }
      if (data.preview) {
        setPreviewNotes(data.preview.notes || "");
        setNeedsRepairs(data.preview.needsRepairs === true ? "yes" : data.preview.needsRepairs === false ? "no" : "");
        setRepairNotes(data.preview.repairNotes || "");
        nextStep = "intel";
      }
      if (data.intel) {
        setDesiredPrice(data.intel.desiredPrice || "");
        setMotivation(data.intel.motivation || "");
        setMortgageBalance(data.intel.mortgageBalance || "");
        setBuyingToo(data.intel.buyingToo || "");
        setBuyingNotes(data.intel.buyingNotes || "");
        setTimeline(data.intel.timeline || "");
        nextStep = "presentation";
      }
      if (data.presentation) { setPresentationChecklist(data.presentation.covered || {}); nextStep = "close"; }
      if (data.pricing) {
        setRecommendedPrice(data.pricing.recommendedPrice || "");
        setReviewedComps(!!data.pricing.reviewedComps);
      }
      if (data.close) {
        setReadyToStart(data.close.readyToStart || "");
        setStartTiming(data.close.startTiming || "");
        setRepairsOrReady(data.close.repairsOrReady || "");
        setHoldingBack(data.close.holdingBack || "");
        setFinalListingPrice(data.close.finalListingPrice || "");
        nextStep = data.close.readyToStart === "yes" ? "lockin" : "debrief";
      }
      if (data.lockin) {
        setLockinSchedule(data.lockin.schedule || {});
        setLockinScheduleDates(data.lockin.scheduleDates || {});
        setLockinScheduleTimes(data.lockin.scheduleTimes || {});
        setContractSent(!!data.lockin.contractSent);
        // v20.14.6 — restore the six granular access fields when present.
        setAccessKeyOrCode(data.lockin.accessKeyOrCode || "");
        setGateCode(data.lockin.gateCode || "");
        setOwnerNames(data.lockin.ownerNames || "");
        setOwnerNames2(data.lockin.ownerNames2 || "");
        if (data.lockin.ownerNames2) setShowOwner2(true);
        // v20.15.1 — restore Owner 2 phone/email.
        setOwner2Phone(data.lockin.owner2Phone || "");
        setOwner2Email(data.lockin.owner2Email || "");
        // Use the freshly-fetched row values (d.client_phone/email), not the
        // clientPhone/clientEmail state vars — those setState calls above
        // haven't flushed yet inside this same synchronous function body.
        setAccessPhone(data.lockin.accessPhone || d.client_phone || "");
        setAccessEmail(data.lockin.accessEmail || d.client_email || "");
        nextStep = "debrief";
      }
      // data.debrief is never present on a resumable consult — submitting the
      // debrief atomically flips status to 'debriefed', which /mine filters out.

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
      onLaunchRepairConsult({ address: propertyAddress, name: clientName, email: clientEmail, phone: clientPhone, heroPhotoUrl });
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
      setStep("close");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  // v20.15.0 — pricing + close merged into one save/step. Was two taps
  // (Pricing tiers reference page, then Close) for what is really one
  // decision point in the appointment: what price did they agree to, and
  // are they ready to move.
  const handleCloseNext = async () => {
    setError(""); setSaving(true);
    try {
      await saveSection("pricing", { recommendedPrice, reviewedComps });
      await saveSection("close", { readyToStart, startTiming, repairsOrReady, holdingBack, finalListingPrice });
      setStep(readyToStart === "yes" ? "lockin" : "debrief");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleLockinNext = async () => {
    setError(""); setSaving(true);
    try {
      const owner1Contact = [accessPhone, accessEmail].filter(Boolean).join(" / ");
      const owner2Contact = [owner2Phone, owner2Email].filter(Boolean).join(" / ");
      await saveSection("lockin", {
        schedule: lockinSchedule,
        scheduleDates: lockinScheduleDates,
        scheduleTimes: lockinScheduleTimes,
        // v20.14.6 — persist the raw access fields too (not just the derived
        // accessNotes summary) so a resumed consult can refill each input
        // instead of coming back blank. accessNotes stays as-is — it's what
        // the debrief email actually reads.
        accessKeyOrCode, gateCode, ownerNames, ownerNames2, accessPhone, accessEmail,
        owner2Phone, owner2Email,
        accessNotes: [
          accessKeyOrCode && `Key/Code: ${accessKeyOrCode}`,
          gateCode && `Gate: ${gateCode}`,
          ownerNames && `Owners: ${[ownerNames, ownerNames2].filter(Boolean).join(" & ")}`,
          owner1Contact && `Owner 1: ${owner1Contact}`,
          showOwner2 && owner2Contact && `Owner 2: ${owner2Contact}`,
        ].filter(Boolean).join(" · "),
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

  const stepOrder = ["prep", "preview", "intel", "presentation", "close", readyToStart === "yes" ? "lockin" : null, "debrief"].filter(Boolean) as string[];
  const stepLabels: Record<string, string> = { prep: "Prep", preview: "Preview", intel: "Intel", presentation: "Present", close: "Close", lockin: "Lock In", debrief: "Debrief" };
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
            <label style={labelStyle}>Property Address</label>
            <input style={{ ...inputStyle, marginBottom: 14 }} value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} placeholder="123 Main St, Fernandina Beach, FL" />
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
            <label style={labelStyle}>Find in FUB</label>
            <div style={{ position: "relative", marginBottom: 6 }}>
              <input
                style={inputStyle}
                value={fubQuery}
                onChange={e => { setFubQuery(e.target.value); setFubPickedName(null); }}
                placeholder="Type client name to search Follow Up Boss…"
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
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.35)", marginTop: -2, marginBottom: 14 }}>
              Selecting a match autofills name, phone, and email below — you can still edit any of it. If FUB shows a nickname, you'll enter their full legal name separately on the Lock In step.
            </p>
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
                <input style={{ ...inputStyle }} value={repairNotes} onChange={e => setRepairNotes(e.target.value)} placeholder="What you're seeing — mention the repair program, don't scope it yet" />
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 8, marginBottom: 0 }}>
                  Just a flag for now — the Repair Consult only opens once they say yes to listing, on the Lock It In step.
                </p>
              </div>
            )}
            <div style={cardStyle}>
              <label style={labelStyle}>Walkthrough Photos ({galleryUrls.length})</label>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -2, marginBottom: 10 }}>
                Get one of every room, plus close-ups of anything you'd flag in the repair notes above. Shoot them live as you walk, or with your own camera and add them here after — either way, bulk-select and upload as many at once as you want.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {galleryUrls.map((u, i) => <img key={i} src={u} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6 }} />)}
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

        {step === "close" && (
          <>
            {header("Price & Close", "What they agreed to, and are they ready?")}
            <Chip label="Reviewed Comps with Client" checked={reviewedComps} onToggle={() => setReviewedComps(!reviewedComps)} />
            <label style={labelStyle}>Recommended List Price (optional)</label>
            <input style={{ ...inputStyle, marginBottom: 14 }} value={recommendedPrice} onChange={e => setRecommendedPrice(e.target.value)} placeholder="$" />
            <label style={labelStyle}>Final Listing Price (what the seller agreed to)</label>
            <input style={{ ...inputStyle, marginBottom: 14 }} value={finalListingPrice} onChange={e => setFinalListingPrice(e.target.value)} placeholder="$" />
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
            {navButtons({ onBack: () => setStep("presentation"), onNext: handleCloseNext, nextBusy: saving, nextLabel: readyToStart === "yes" ? "Lock It In" : "Continue to Debrief" })}
          </>
        )}

        {step === "lockin" && (
          <>
            {header("Lock It In", "Schedule + access — moves fast once signed")}
            {needsRepairs === "yes" && (
              <div style={cardStyle}>
                <label style={labelStyle}>Repairs Flagged During Walkthrough</label>
                {repairNotes && (
                  <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: -2, marginBottom: 10 }}>{repairNotes}</p>
                )}
                <button type="button" onClick={handleOpenRepairConsult} disabled={saving} style={{
                  width: "100%", padding: "12px 14px", borderRadius: 10, cursor: saving ? "default" : "pointer",
                  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)",
                  color: "#fff", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                }}>
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Wrench size={15} style={{ color: GOLD }} />}
                  Open Repair Consult
                </button>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 8, marginBottom: 0 }}>
                  They said yes — scope items and build an instant quote to help close while you're still in the room. Nate or Alex still has to approve it before it goes to the client.
                </p>
              </div>
            )}
            <label style={labelStyle}>Schedule</label>
            {LOCKIN_SCHEDULE_ITEMS.map(item => {
              const checked = !!lockinSchedule[item];
              return (
                <div key={item} style={{ display: "flex", gap: 6, alignItems: "stretch", marginBottom: 8 }}>
                  <button type="button" onClick={() => toggleChip(lockinSchedule, setLockinSchedule, item)} style={{
                    display: "flex", alignItems: "center", gap: 6, flex: "1 1 42%", minWidth: 0, textAlign: "left",
                    padding: "8px 8px", borderRadius: 8, cursor: "pointer",
                    background: checked ? "rgba(200,170,90,0.14)" : "rgba(255,255,255,0.04)",
                    border: checked ? "1px solid rgba(200,170,90,0.5)" : "1px solid rgba(255,255,255,0.1)",
                    color: checked ? GOLD : "rgba(255,255,255,0.8)", fontSize: 12, fontWeight: checked ? 700 : 500,
                  }}>
                    <span style={{
                      width: 15, height: 15, borderRadius: 4, flexShrink: 0,
                      border: checked ? "none" : "1.5px solid rgba(255,255,255,0.3)",
                      background: checked ? GOLD : "transparent",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {checked && <CheckCircle2 size={10} style={{ color: "#0c0b0a" }} />}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item}</span>
                  </button>
                  <input
                    type="date"
                    style={{ ...inputStyle, flex: "1 1 30%", minWidth: 0, padding: "7px 6px", fontSize: 11.5 }}
                    value={lockinScheduleDates[item] || ""}
                    onChange={e => setLockinScheduleDates(prev => ({ ...prev, [item]: e.target.value }))}
                  />
                  <input
                    type="time"
                    style={{ ...inputStyle, flex: "1 1 28%", minWidth: 0, padding: "7px 6px", fontSize: 11.5 }}
                    value={lockinScheduleTimes[item] || ""}
                    onChange={e => setLockinScheduleTimes(prev => ({ ...prev, [item]: e.target.value }))}
                  />
                </div>
              );
            })}
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
        </>
        )}
      </div>
    </div>
  );
}
