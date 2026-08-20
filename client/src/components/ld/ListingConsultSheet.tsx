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
import { useState, useEffect, useRef } from "react";
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

const NOT_MOVING_OPTIONS: { key: string; label: string }[] = [
  { key: "pending_repair_quote", label: "Not ready — pending repair quote" },
  { key: "other_reason", label: "Not ready — other reason" },
  { key: "listed_other_agent", label: "Listed with another agent" },
  { key: "not_interested", label: "Not interested" },
];

export function ListingConsultSheet({
  leadId, agentId, initialAddress, initialClientName, initialClientEmail, initialClientPhone, onClose, onLaunchRepairConsult,
}: {
  leadId?: number | null; agentId?: number | null;
  initialAddress?: string; initialClientName?: string; initialClientEmail?: string; initialClientPhone?: string;
  onClose: () => void;
  onLaunchRepairConsult: (prefill: { address: string; name: string; email: string; phone: string; heroPhotoUrl?: string | null; galleryUrls?: string[] }) => void;
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
  const [mortgageBalance, setMortgageBalance] = useState("");
  const [buyingToo, setBuyingToo] = useState<"" | "yes" | "no">("");
  const [buyingNotes, setBuyingNotes] = useState("");
  const [timeline, setTimeline] = useState("");

  // ── Close ──
  const [recommendedPrice, setRecommendedPrice] = useState("");
  const [finalListingPrice, setFinalListingPrice] = useState("");
  const [commissionTerms, setCommissionTerms] = useState("");
  const [whereAreWe, setWhereAreWe] = useState<"" | "ready_now" | "ready_repairs" | "not_moving">("");
  const [notMovingReason, setNotMovingReason] = useState<"" | "pending_repair_quote" | "other_reason" | "listed_other_agent" | "not_interested">("");
  const [notMovingNotes, setNotMovingNotes] = useState("");
  const [notMovingFollowUpTiming, setNotMovingFollowUpTiming] = useState("");
  const [notMovingSubmitted, setNotMovingSubmitted] = useState(false);
  const [sendingNotMoving, setSendingNotMoving] = useState(false);

  // ── Lock In ──
  const [needsCleaning, setNeedsCleaning] = useState<"" | "yes" | "no">("");
  const [cleaningDate, setCleaningDate] = useState("");
  const [cleaningTime, setCleaningTime] = useState("");
  const [repairDate, setRepairDate] = useState("");
  const [repairTime, setRepairTime] = useState("");
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
        setMortgageBalance(data.walkthrough.mortgageBalance || "");
        setBuyingToo(data.walkthrough.buyingToo || "");
        setBuyingNotes(data.walkthrough.buyingNotes || "");
        setTimeline(data.walkthrough.timeline || "");
        nextStep = "close";
      }
      if (data.close) {
        setRecommendedPrice(data.close.recommendedPrice || "");
        setFinalListingPrice(data.close.finalListingPrice || "");
        setCommissionTerms(data.close.commissionTerms || "");
        setWhereAreWe(data.close.whereAreWe || "");
        if (data.close.whereAreWe === "ready_now" || data.close.whereAreWe === "ready_repairs") {
          nextStep = "lockin";
        } else {
          nextStep = "close";
        }
      }
      if (data.lockin) {
        setNeedsCleaning(data.lockin.needsCleaning || "");
        setCleaningDate(data.lockin.cleaningDate || "");
        setCleaningTime(data.lockin.cleaningTime || "");
        setRepairDate(data.lockin.repairDate || "");
        setRepairTime(data.lockin.repairTime || "");
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
      await saveSection("walkthrough", { notes: walkthroughNotes, needsRepairs: needsRepairs === "yes", mortgageBalance, buyingToo, buyingNotes, timeline });
      setStep("close");
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const handleOpenRepairConsult = async () => {
    setError(""); setSaving(true);
    try {
      await ensureConsult();
      await saveSection("walkthrough", { notes: walkthroughNotes, needsRepairs: true, mortgageBalance, buyingToo, buyingNotes, timeline });
      onLaunchRepairConsult({ address: propertyAddress, name: clientName, email: clientEmail, phone: clientPhone, heroPhotoUrl, galleryUrls });
    } catch (e: any) { setError(e.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  // v20.15.2 — second chance to flag repairs on Lock It In. Covers the case
  // where nothing looked obvious during the walkthrough but something came
  // up by the end of the appointment.
  const handleLockinRepairFlag = async (v: "yes" | "no") => {
    setNeedsRepairs(v);
    if (v === "yes") {
      try { await saveSection("walkthrough", { notes: walkthroughNotes, needsRepairs: true, mortgageBalance, buyingToo, buyingNotes, timeline }); }
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
      await saveSection("close", { whereAreWe, recommendedPrice, finalListingPrice, commissionTerms });
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
      await saveSection("close", { whereAreWe: "not_moving", recommendedPrice, finalListingPrice, commissionTerms }, id);
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
        needsCleaning, cleaningDate, cleaningTime,
        repairDate, repairTime,
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
            <label style={labelStyle}>Needs Repairs?</label>
            <div style={{ marginBottom: 14 }}>
              {segmented(needsRepairs, [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], v => setNeedsRepairs(v as any))}
            </div>
            {needsRepairs === "yes" && (
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: -6, marginBottom: 14 }}>
                Just a flag for now — the Repair Consult only opens once they say yes to listing, on the Lock It In step.
              </p>
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
            <label style={labelStyle}>Commission Terms (optional)</label>
            <input style={{ ...inputStyle, marginBottom: 18 }} value={commissionTerms} onChange={e => setCommissionTerms(e.target.value)} placeholder="e.g. 6% total (3% / 3%)" />

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

            <label style={labelStyle}>Does This Listing Need a Cleaning Booked Before Photos?</label>
            <div style={{ marginBottom: 14 }}>
              {segmented(needsCleaning, [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], v => setNeedsCleaning(v as any))}
            </div>
            {needsCleaning === "yes" && (
              <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                <input type="date" style={inputStyle} value={cleaningDate} onChange={e => setCleaningDate(e.target.value)} />
                <input type="time" style={inputStyle} value={cleaningTime} onChange={e => setCleaningTime(e.target.value)} />
              </div>
            )}

            {whereAreWe === "ready_repairs" && (
              <div style={cardStyle}>
                <label style={labelStyle}>Repair Date/Time</label>
                <div style={{ display: "flex", gap: 10 }}>
                  <input type="date" style={inputStyle} value={repairDate} onChange={e => setRepairDate(e.target.value)} />
                  <input type="time" style={inputStyle} value={repairTime} onChange={e => setRepairTime(e.target.value)} />
                </div>
              </div>
            )}

            {needsRepairs === "yes" ? (
              <div style={cardStyle}>
                <label style={labelStyle}>Repairs Flagged During Walkthrough</label>
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
                <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", verticalAlign: "top" }}>Commission</td><td style={{ padding: "5px 0" }}>{commissionTerms || "—"}</td></tr>
                <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", verticalAlign: "top" }}>Timeline</td><td style={{ padding: "5px 0" }}>{timeline || "—"}</td></tr>
                <tr><td style={{ color: "rgba(255,255,255,0.45)", padding: "5px 0", verticalAlign: "top" }}>Path</td><td style={{ padding: "5px 0" }}>{whereAreWe === "ready_repairs" ? "Ready — repairs first" : "Ready — start now"}</td></tr>
              </tbody>
            </table>
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
