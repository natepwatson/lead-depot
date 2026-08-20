// v20.13.0 — Repair Consult. Full-screen wizard an agent runs during a listing
// walkthrough: capture the front-of-house hero photo upfront, check off simple
// in-house repairs (auto-priced by sqft/linear-ft/each) plus anything that
// needs a licensed vendor, then bulk-upload every other walkthrough photo in
// one final step right before generating the branded quote. Scheduling is NOT
// discussed here — sequence is signed -> deposit received -> THEN a start
// date is scheduled from the admin Consults panel. In-house quote emails
// Alex+Nate+Denise immediately; "Send to Client" delivers the branded
// proposal + accept link; "Request Vendor Quotes" fires trade-specific
// quote-request emails with photos to our preferred vendors.
import { useEffect, useMemo, useState } from "react";
import { Camera, Loader2, CheckCircle2, ChevronRight, ChevronLeft, X } from "lucide-react";
import { ConsultResumePicker, ResumeCheckingSpinner, type ResumeItem } from "./ConsultResumePicker";

type RepairItem = {
  id: number; key: string; category: "in_house" | "vendor"; trade: string; name: string;
  unit: "sqft" | "linear_ft" | "each" | "flat";
  default_rate: number | null; min_charge: number; two_story_eligible: number;
  sequence_order: number; instruction: string | null;
};

type CheckedState = {
  checked: boolean; quantity: string; twoStory: boolean;
  photos: string[]; measurementNotes: string;
};

const fetchJson = async (url: string, opts: RequestInit = {}) => {
  const r = await fetch(url, { credentials: "include", ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
};

const TRADE_LABELS: Record<string, string> = {
  junk_removal: "Junk Removal", handyman: "Handyman", pressure_washing: "Pressure Washing",
  painting_exterior: "Exterior Painting", landscaping: "Landscaping", painting_interior: "Interior Painting",
  cleaning: "Cleaning",
  tile_install: "Tile Installation", cabinet_install: "Cabinet Installation", cabinetry_painting: "Cabinetry Painting",
  roofing: "Roofing", electrical: "Electrical", plumbing: "Plumbing", hvac: "HVAC",
  stucco_masonry: "Stucco & Masonry", carpentry: "Carpentry", wdo: "WDO / Termite",
  windows: "Windows", backflow: "Backflow Prevention", flooring_wood_refinish: "Wood Floor Refinishing",
  flooring_lvp: "LVP Flooring", flooring_carpet: "Carpet Installation", appliances: "Appliances",
  countertops: "Countertops", retexture: "Re-Texturing", shower_doors: "Frameless Shower Doors",
  irrigation: "Irrigation", fencing: "Fencing", pool_equipment: "Pool Equipment", septic: "Septic",
  water_heater: "Water Heater", tree_removal_large: "Large Tree Removal", structural: "Structural / Foundation",
  mold_remediation: "Mold Remediation", chimney: "Chimney", solar: "Solar", water_damage: "Water Damage Restoration",
  garage_door: "Garage Door", hardscape: "Hardscape / Pavers",
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

// Reads + compresses a photo BEFORE it's sent to the server. Phone-camera
// photos (especially HEIC→JPEG converted ones) can run several megabytes,
// which was pushing base64 payloads past the old body-size limit and causing
// intermittent "failed to load" upload errors. Downscaling here fixes that at
// the source and keeps the DB footprint small, on top of the server's own
// resize pass.
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
    // createImageBitmap decodes with EXIF orientation already applied, so the
    // canvas pixels come out right-side-up with no separate rotation step.
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
    // Fallback for browsers without createImageBitmap/canvas support — ship
    // the original file as-is; the server's own sharp resize pass still applies.
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

export function RepairConsultSheet({
  leadId, agentId, initialAddress, initialClientName, initialClientEmail, initialClientPhone, onClose, manageNavVisibility = true,
  nestedFromListing = false, prefillHeroPhotoUrl = null,
}: {
  leadId?: number | null; agentId?: number | null;
  initialAddress?: string; initialClientName?: string; initialClientEmail?: string; initialClientPhone?: string;
  onClose: () => void;
  // v20.14.2 — when this sheet is opened NESTED inside another full-screen
  // sheet that already keeps body.ld-modal-open set for its own lifetime
  // (e.g. the Listing Consult repair hand-off), the parent already owns nav
  // visibility. Default true preserves the standalone-tab behavior (this
  // sheet manages the class itself); pass false for the nested case so
  // closing this overlay doesn't prematurely reveal the nav while the parent
  // sheet is still open underneath.
  manageNavVisibility?: boolean;
  // v20.14.4 — when launched FROM Listing Consult, property/client info and
  // the front-of-house hero photo were already captured on Listing Consult's
  // own first page. Skip re-asking for any of it here — jump straight to the
  // repair checklist so this feels like a continuation of the same
  // consultation, not a separate tool. prefillHeroPhotoUrl is handed to the
  // repair_consult record directly at creation time.
  nestedFromListing?: boolean;
  prefillHeroPhotoUrl?: string | null;
}) {
  const [step, setStep] = useState<"info" | "checklist" | "gallery" | "review">(nestedFromListing ? "checklist" : "info");
  const [consultId, setConsultId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  // v20.14.5 — Resume picker: nested-from-listing skips straight to "ready"
  // (that flow already carries its own state from the parent Listing Consult
  // and creates its own record immediately). Standalone opens check for any
  // in-progress consult this agent already started before rendering steps.
  const [resumePhase, setResumePhase] = useState<"checking" | "picking" | "ready">(nestedFromListing ? "ready" : "checking");
  const [resumeList, setResumeList] = useState<ResumeItem[]>([]);

  const [clientName, setClientName] = useState(initialClientName || "");
  const [clientEmail, setClientEmail] = useState(initialClientEmail || "");
  const [clientPhone, setClientPhone] = useState(initialClientPhone || "");
  const [propertyAddress, setPropertyAddress] = useState(initialAddress || "");

  // v20.15.2 — same live FUB contact picker as Listing Consult's Before You
  // Arrive step. Only relevant when the agent is starting a standalone Repair
  // Consult (not nested from a Listing Consult, which already carries this
  // info) — search a name, autofill everything FUB already knows.
  const [fubQuery, setFubQuery] = useState("");
  const [fubResults, setFubResults] = useState<{ id: number; name: string; email: string | null; phone: string | null; address: string | null }[]>([]);
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

  const pickFubContact = (c: { name: string; email: string | null; phone: string | null; address: string | null }) => {
    setClientName(c.name);
    if (c.email) setClientEmail(c.email);
    if (c.phone) setClientPhone(c.phone);
    if (c.address) setPropertyAddress(c.address);
    setFubPickedName(c.name);
    setFubQuery(c.name);
    setFubResults([]);
  };

  const [heroPhotoUrl, setHeroPhotoUrl] = useState<string | null>(prefillHeroPhotoUrl || null);
  const [galleryUrls, setGalleryUrls] = useState<{ url: string; tag: "overview" | "repair_scope" }[]>([]);
  // v20.15.2 — which tag new bulk-uploaded photos get; mirrors ListingConsultSheet.
  const [galleryTagMode, setGalleryTagMode] = useState<"overview" | "repair_scope">("repair_scope");
  const [uploadingHero, setUploadingHero] = useState(false);
  const [uploadingGallery, setUploadingGallery] = useState(false);
  const [galleryProgress, setGalleryProgress] = useState<{ done: number; total: number } | null>(null);

  const [catalog, setCatalog] = useState<RepairItem[]>([]);
  const [checked, setChecked] = useState<Record<string, CheckedState>>({});
  const [catalogLoading, setCatalogLoading] = useState(true);

  // v20.13.0 — start window/date/time are no longer captured in this wizard;
  // scheduling happens later from the admin panel once deposit is received.

  const [submittingItems, setSubmittingItems] = useState(false);
  const [totals, setTotals] = useState<{ subtotal: number; total: number } | null>(null);
  const [quoteResult, setQuoteResult] = useState<{ pdfUrl: string; acceptUrl: string; total: number } | null>(null);
  const [generatingQuote, setGeneratingQuote] = useState(false);
  const [sendingToClient, setSendingToClient] = useState(false);
  const [clientSent, setClientSent] = useState(false);
  const [dispatchingVendors, setDispatchingVendors] = useState(false);
  const [vendorDispatchResult, setVendorDispatchResult] = useState<{ sent: number; tradesWithoutVendor?: string[] } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!manageNavVisibility) return; // parent sheet already owns nav visibility
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, [manageNavVisibility]);

  useEffect(() => {
    fetchJson("/api/repair-items")
      .then(d => setCatalog(d.items || []))
      .catch(() => setError("Couldn't load the repair catalog. Try again."))
      .finally(() => setCatalogLoading(false));
  }, []);

  // v20.14.5 — check for resumable consults on standalone opens only.
  useEffect(() => {
    if (nestedFromListing) return;
    fetchJson(`/api/repair-consult/mine?agentId=${agentId ?? ""}`)
      .then(d => {
        const list: ResumeItem[] = d.consults || [];
        if (list.length > 0) { setResumeList(list); setResumePhase("picking"); }
        else setResumePhase("ready");
      })
      .catch(() => setResumePhase("ready"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v20.14.4 — nested-from-listing: create the linked repair_consult record
  // immediately on mount (carrying over the already-known info + hero photo)
  // instead of waiting for an "info" step the agent never sees.
  useEffect(() => {
    if (nestedFromListing) { ensureConsult().catch(e => setError(e.message || "Failed to start repair consult.")); }
  }, [nestedFromListing]);

  const inHouseItems = useMemo(() => catalog.filter(i => i.category === "in_house").sort((a, b) => a.sequence_order - b.sequence_order), [catalog]);
  const vendorItems = useMemo(() => catalog.filter(i => i.category === "vendor").sort((a, b) => a.sequence_order - b.sequence_order), [catalog]);

  const groupedByTrade = (items: RepairItem[]) => {
    const map = new Map<string, RepairItem[]>();
    for (const it of items) {
      if (!map.has(it.trade)) map.set(it.trade, []);
      map.get(it.trade)!.push(it);
    }
    return [...map.entries()];
  };

  const DEFAULT_ITEM_STATE: CheckedState = { checked: false, quantity: "1", twoStory: false, photos: [], measurementNotes: "" };
  const setItemState = (key: string, patch: Partial<CheckedState>) => {
    setChecked(prev => {
      const base = prev[key] || DEFAULT_ITEM_STATE;
      return { ...prev, [key]: { ...base, ...patch } };
    });
  };

  const ensureConsult = async (): Promise<number> => {
    if (consultId) return consultId;
    setCreating(true);
    try {
      const d = await fetchJson("/api/repair-consult", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, agentId, clientName, clientEmail, clientPhone, propertyAddress, heroPhotoUrl: prefillHeroPhotoUrl || null }),
      });
      setConsultId(d.id);
      return d.id;
    } finally { setCreating(false); }
  };

  // v20.14.6 — Archive (soft-delete) a consult straight from the resume
  // picker without opening it. Optimistically drops it from the local list;
  // if the request fails, put it back and surface the error.
  const handleArchiveConsult = async (id: number) => {
    const prev = resumeList;
    setResumeList(list => list.filter(it => it.id !== id));
    try {
      await fetchJson(`/api/repair-consult/${id}/archive`, { method: "POST" });
    } catch (e: any) {
      setResumeList(prev);
      setError(e.message || "Failed to remove that consult.");
    }
  };

  // v20.14.5 — Hydrate every wizard field from a previously-started consult
  // (row + checklist items) so resuming feels like the tab never closed.
  const handleResumeConsult = async (id: number) => {
    setResumePhase("ready"); setError("");
    try {
      const d = await fetchJson(`/api/repair-consult/${id}`);
      setConsultId(d.id);
      setClientName(d.client_name || "");
      setClientEmail(d.client_email || "");
      setClientPhone(d.client_phone || "");
      setPropertyAddress(d.property_address || "");
      setHeroPhotoUrl(d.hero_photo_url || null);
      setGalleryUrls(Array.isArray(d.property_photos) ? d.property_photos.map((p: any) => typeof p === "string" ? { url: p, tag: "overview" } : p) : []);

      const items: any[] = d.items || [];
      if (items.length > 0) {
        const nextChecked: Record<string, CheckedState> = {};
        for (const it of items) {
          let photos: string[] = [];
          try { photos = it.photos ? JSON.parse(it.photos) : []; } catch { photos = []; }
          nextChecked[it.item_key] = {
            checked: true,
            quantity: String(it.quantity ?? 1),
            twoStory: !!it.two_story,
            photos,
            measurementNotes: it.measurement_notes || "",
          };
        }
        setChecked(nextChecked);
      }

      if (d.subtotal || d.total) setTotals({ subtotal: d.subtotal || 0, total: d.total || 0 });

      if (d.quote_token) {
        // Quote already generated — jump to Review with the send/dispatch
        // actions available. pdfUrl/acceptUrl aren't persisted server-side
        // (only the total is needed to render this card), so leave them blank.
        setQuoteResult({ pdfUrl: "", acceptUrl: "", total: d.total || 0 });
        if (d.status === "sent") setClientSent(true);
        setStep("review");
      } else if (items.length > 0) {
        setStep("gallery");
      } else {
        setStep("checklist");
      }
    } catch (e: any) {
      setError(e.message || "Failed to load that consult — starting fresh instead.");
    }
  };

  const handleInfoNext = async () => {
    if (!propertyAddress.trim()) { setError("Property address is required."); return; }
    setError("");
    try { await ensureConsult(); setStep("checklist"); }
    catch (e: any) { setError(e.message || "Failed to start consult."); }
  };

  const handlePhotoPick = async (file: File, kind: "hero" | "gallery") => {
    const id = await ensureConsult();
    const setBusy = kind === "hero" ? setUploadingHero : setUploadingGallery;
    setBusy(true);
    try {
      const conv = await fileToImageData(file);
      if (!conv) { setError("Couldn't read that photo. Try another."); setBusy(false); return; }
      const d = await fetchJson(`/api/repair-consult/${id}/photo`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: conv.imageData, mimeType: conv.mimeType, kind, tag: kind === "gallery" ? galleryTagMode : undefined }),
      });
      if (kind === "hero") setHeroPhotoUrl(d.url);
      else setGalleryUrls(prev => [...prev, { url: d.url, tag: galleryTagMode }]);
    } catch (e: any) { setError(e.message || "Photo upload failed."); }
    finally { setBusy(false); }
  };

  // Bulk end-of-walkthrough upload — agent shoots photos with the phone's own
  // camera throughout the walkthrough, then picks them all at once here from
  // their photo library. Uploaded one at a time (each already downscaled by
  // fileToImageData) so a single oversized file can't block the rest.
  const handleBulkGalleryUpload = async (files: FileList) => {
    const id = await ensureConsult();
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;
    const tag = galleryTagMode;
    setUploadingGallery(true);
    setGalleryProgress({ done: 0, total: fileArr.length });
    for (let i = 0; i < fileArr.length; i++) {
      try {
        const conv = await fileToImageData(fileArr[i]);
        if (conv) {
          const d = await fetchJson(`/api/repair-consult/${id}/photo`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageData: conv.imageData, mimeType: conv.mimeType, kind: "gallery", tag }),
          });
          setGalleryUrls(prev => [...prev, { url: d.url, tag }]);
        }
      } catch (e: any) { setError(e.message || `Photo ${i + 1} of ${fileArr.length} failed to upload — the rest kept going.`); }
      setGalleryProgress({ done: i + 1, total: fileArr.length });
    }
    setUploadingGallery(false);
    setGalleryProgress(null);
  };

  // v20.15.2 — re-tag a photo after the fact (tap its badge to flip Overview ↔ Repair Scope).
  const handleToggleGalleryTag = async (url: string) => {
    const current = galleryUrls.find(p => p.url === url);
    if (!current || !consultId) return;
    const nextTag: "overview" | "repair_scope" = current.tag === "repair_scope" ? "overview" : "repair_scope";
    setGalleryUrls(prev => prev.map(p => p.url === url ? { ...p, tag: nextTag } : p));
    try {
      await fetchJson(`/api/repair-consult/${consultId}/photo-tag`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, tag: nextTag }),
      });
    } catch { setGalleryUrls(prev => prev.map(p => p.url === url ? { ...p, tag: current.tag } : p)); }
  };

  const selectedCount = Object.values(checked).filter(c => c.checked).length;

  // v20.13.0 — Deposit Required Gate: scheduling is no longer discussed here.
  // Sequence is now signed -> deposit received -> THEN start date is scheduled
  // from the admin Consults panel. This step goes straight from checklist to
  // the final photo gallery.
  const handleChecklistNext = async () => {
    const id = await ensureConsult();
    setSubmittingItems(true);
    setError("");
    try {
      const items = Object.entries(checked)
        .filter(([, v]) => v.checked)
        .map(([itemKey, v]) => ({
          itemKey, quantity: Number(v.quantity) || 1, twoStory: v.twoStory,
          photos: v.photos, measurementNotes: v.measurementNotes || undefined,
        }));
      if (items.length === 0) { setError("Check off at least one repair item before continuing."); setSubmittingItems(false); return; }
      const d = await fetchJson(`/api/repair-consult/${id}/items`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
      });
      setTotals({ subtotal: d.subtotal, total: d.total });
      setStep("gallery");
    } catch (e: any) { setError(e.message || "Failed to save checklist."); }
    finally { setSubmittingItems(false); }
  };

  const handleGenerateQuote = async () => {
    if (!consultId) return;
    setGeneratingQuote(true); setError("");
    try {
      const d = await fetchJson(`/api/repair-consult/${consultId}/generate-quote`, { method: "POST" });
      setQuoteResult({ pdfUrl: d.pdfUrl, acceptUrl: d.acceptUrl, total: d.total });
    } catch (e: any) { setError(e.message || "Failed to generate quote."); }
    finally { setGeneratingQuote(false); }
  };

  const handleSendToClient = async () => {
    if (!consultId) return;
    setSendingToClient(true); setError("");
    try {
      await fetchJson(`/api/repair-consult/${consultId}/send-to-client`, { method: "POST" });
      setClientSent(true);
    } catch (e: any) { setError(e.message || "Failed to send to client."); }
    finally { setSendingToClient(false); }
  };

  const handleDispatchVendors = async () => {
    if (!consultId) return;
    setDispatchingVendors(true); setError("");
    try {
      const d = await fetchJson(`/api/repair-consult/${consultId}/dispatch-vendors`, { method: "POST" });
      setVendorDispatchResult({ sent: d.sent, tradesWithoutVendor: d.tradesWithoutVendor });
    } catch (e: any) { setError(e.message || "Failed to send vendor requests."); }
    finally { setDispatchingVendors(false); }
  };

  const hasVendorSelections = Object.entries(checked).some(([k, v]) => v.checked && vendorItems.some(vi => vi.key === k));
  const hasInHouseSelections = Object.entries(checked).some(([k, v]) => v.checked && inHouseItems.some(ii => ii.key === k));

  const stepIndex = { info: 0, checklist: 1, gallery: 2, review: 3 }[step];

  const header = (title: string, sub: string) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 24, fontWeight: 400, color: "#fff", margin: 0 }}>{title}</h2>
          <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>{sub}</p>
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, marginTop: 14 }}>
        {["Info", "Checklist", "Gallery", "Review"].map((s, i) => (
          <div key={s} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= stepIndex ? GOLD : "rgba(255,255,255,0.1)" }} />
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
            title="Repair Consult"
            subtitle="Pick up an in-progress consult, or start a new one."
            items={resumeList}
            onResume={handleResumeConsult}
            onStartNew={() => setResumePhase("ready")}
            onArchive={handleArchiveConsult}
          />
        )}

        {resumePhase === "ready" && (
        <>
        {step === "info" && (
          <>
            {header("Repair Consult", "Property + client info, front of house photo")}
            <label style={labelStyle}>Find in FUB</label>
            <div style={{ position: "relative", marginBottom: 6 }}>
              <input
                style={inputStyle}
                value={fubQuery}
                onChange={e => { setFubQuery(e.target.value); setFubPickedName(null); }}
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
              Start here — selecting a match autofills name, phone, email, and their current home address below.
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
            <div style={cardStyle}>
              <label style={labelStyle}>Front of House (Hero Photo)</label>
              {heroPhotoUrl ? (
                <div style={{ position: "relative" }}>
                  <img src={heroPhotoUrl} style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: 8 }} />
                  <label style={{ position: "absolute", bottom: 8, right: 8, background: "rgba(0,0,0,0.7)", borderRadius: 8, padding: "6px 10px", fontSize: 11, color: "#fff", cursor: "pointer" }}>
                    Retake
                    {/* v20.14.4 — no `capture` attr: lets the agent pick an already-taken photo
                        from their camera roll (full-scope-later workflow) OR take a new one live —
                        OS shows both options. */}
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
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: -2, marginBottom: 4 }}>
              Snap interior and detail photos as you walk through, or shoot them all with your phone's own camera and pick them from your camera roll later — either way, you'll bulk-upload the full set together at the end, right before sending the quote.
            </p>
            {navButtons({ onNext: handleInfoNext, nextBusy: creating, nextDisabled: !propertyAddress.trim() })}
          </>
        )}

        {step === "checklist" && (
          <>
            {header("Repair Checklist", `${selectedCount} item${selectedCount === 1 ? "" : "s"} selected`)}
            {catalogLoading ? (
              <div style={{ padding: 30, textAlign: "center" }}><Loader2 size={20} className="animate-spin" style={{ color: GOLD }} /></div>
            ) : (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", margin: "4px 0 10px" }}>In-House (Instant Quote)</p>
                {groupedByTrade(inHouseItems).map(([trade, items]) => (
                  <div key={trade} style={{ marginBottom: 12 }}>
                    <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", marginBottom: 6, fontWeight: 700, letterSpacing: "0.06em" }}>{TRADE_LABELS[trade] || trade}</p>
                    {items.map(it => {
                      const st = checked[it.key];
                      return (
                        <div key={it.key} style={cardStyle}>
                          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                            <input type="checkbox" checked={!!st?.checked} onChange={e => setItemState(it.key, { checked: e.target.checked })} style={{ marginTop: 3, width: 18, height: 18, accentColor: GOLD }} />
                            <div style={{ flex: 1 }}>
                              <p style={{ fontSize: 13.5, color: "#fff", fontWeight: 600, margin: 0 }}>{it.name}</p>
                              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "2px 0 0" }}>
                                {it.unit === "flat" ? `$${it.default_rate?.toFixed(2)} flat` : `$${it.default_rate?.toFixed(2)}/${it.unit === "each" ? "ea" : it.unit.replace("_", " ")} · min $${it.min_charge}`}
                              </p>
                            </div>
                          </label>
                          {st?.checked && (
                            <div style={{ marginTop: 10, paddingLeft: 28 }}>
                              {it.unit !== "flat" && (
                                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                                  <input type="number" min={0} step="any" value={st.quantity} onChange={e => setItemState(it.key, { quantity: e.target.value })}
                                    style={{ ...inputStyle, width: 90 }} />
                                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>{it.unit === "each" ? "count" : it.unit.replace("_", " ")}</span>
                                </div>
                              )}
                              {!!it.two_story_eligible && (
                                <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
                                  <input type="checkbox" checked={st.twoStory} onChange={e => setItemState(it.key, { twoStory: e.target.checked })} style={{ accentColor: GOLD }} />
                                  Two-story (+25% surcharge)
                                </label>
                              )}
                              <input placeholder="Measurement notes (optional)" value={st.measurementNotes} onChange={e => setItemState(it.key, { measurementNotes: e.target.value })}
                                style={{ ...inputStyle, fontSize: 12.5 }} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}

                <p style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase", margin: "16px 0 10px" }}>Needs a Licensed Vendor</p>
                {groupedByTrade(vendorItems).map(([trade, items]) => (
                  <div key={trade} style={{ marginBottom: 12 }}>
                    {items.map(it => {
                      const st = checked[it.key];
                      return (
                        <div key={it.key} style={cardStyle}>
                          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                            <input type="checkbox" checked={!!st?.checked} onChange={e => setItemState(it.key, { checked: e.target.checked })} style={{ marginTop: 3, width: 18, height: 18, accentColor: "rgba(255,255,255,0.6)" }} />
                            <p style={{ fontSize: 13.5, color: "#fff", fontWeight: 600, margin: 0 }}>{TRADE_LABELS[trade] || it.name}</p>
                          </label>
                          {st?.checked && (
                            <div style={{ marginTop: 10, paddingLeft: 28 }}>
                              <input placeholder="Notes for the vendor (scope, measurements, etc.)" value={st.measurementNotes} onChange={e => setItemState(it.key, { measurementNotes: e.target.value })}
                                style={{ ...inputStyle, fontSize: 12.5 }} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </>
            )}
            {navButtons({ onBack: nestedFromListing ? undefined : () => setStep("info"), onNext: handleChecklistNext, nextDisabled: selectedCount === 0, nextBusy: submittingItems, nextLabel: "Continue to Photos" })}
          </>
        )}

        {step === "gallery" && (
          <>
            {header("Walkthrough Photos", "Bulk-upload everything you shot on your phone — right before the quote goes out")}
            <div style={cardStyle}>
              <label style={labelStyle}>Interior / Additional Photos ({galleryUrls.length})</label>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -2, marginBottom: 10 }}>
                Close-up + wide shot of every item you're pricing, plus general room/exterior context. Rule of thumb: if it's not photographed, it can't be quoted.
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {(["repair_scope", "overview"] as const).map(t => (
                  <button key={t} type="button" onClick={() => setGalleryTagMode(t)} style={{
                    flex: 1, padding: "8px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700,
                    background: galleryTagMode === t ? GOLD : "rgba(255,255,255,0.06)",
                    border: galleryTagMode === t ? "none" : "1px solid rgba(255,255,255,0.15)",
                    color: galleryTagMode === t ? "#0c0b0a" : "rgba(255,255,255,0.75)",
                  }}>{t === "repair_scope" ? "Tag next as: Repair Scope" : "Tag next as: Overview"}</button>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {galleryUrls.map((p, i) => (
                  <button key={i} type="button" onClick={() => handleToggleGalleryTag(p.url)} title="Tap to switch Overview / Repair Scope" style={{
                    position: "relative", width: 72, height: 72, padding: 0, border: "none", borderRadius: 6, cursor: "pointer", background: "none",
                  }}>
                    <img src={p.url} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6, display: "block" }} />
                    <span style={{
                      position: "absolute", bottom: 3, left: 3, right: 3, borderRadius: 4, padding: "2px 0",
                      fontSize: 8.5, fontWeight: 700, textAlign: "center", letterSpacing: "0.02em",
                      background: p.tag === "repair_scope" ? "rgba(200,60,40,0.85)" : "rgba(0,0,0,0.6)",
                      color: p.tag === "repair_scope" ? "#fff" : "rgba(255,255,255,0.8)",
                    }}>{p.tag === "repair_scope" ? "REPAIR" : "OVERVIEW"}</span>
                  </button>
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
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 8 }}>
                {uploadingGallery && galleryProgress
                  ? `Uploading photo ${Math.min(galleryProgress.done + 1, galleryProgress.total)} of ${galleryProgress.total}\u2026`
                  : "Select multiple photos from your camera roll at once. Optional, but photos make the quote stand out and help vendors scope licensed-trade work."}
              </p>
            </div>
            {navButtons({ onBack: () => setStep("checklist"), onNext: () => setStep("review"), nextDisabled: uploadingGallery, nextLabel: "Review & Quote" })}
          </>
        )}

        {step === "review" && (
          <>
            {header("Review & Send", propertyAddress)}
            {totals && (
              <div style={{ ...cardStyle, background: "rgba(200,170,90,0.06)", border: "1px solid rgba(200,170,90,0.25)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)" }}>In-House Subtotal</span>
                  <span style={{ fontSize: 12.5, color: "#fff" }}>${totals.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Total</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: GOLD }}>${totals.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 6 }}>50% deposit to begin / 50% on completion</p>
              </div>
            )}

            {hasInHouseSelections && (
              <div style={{ marginBottom: 14 }}>
                {!quoteResult ? (
                  navButtons({ onNext: handleGenerateQuote, nextBusy: generatingQuote, nextLabel: "Generate In-House Quote" })
                ) : (
                  <>
                    <div style={{ padding: 12, borderRadius: 10, background: "rgba(126,212,154,0.1)", color: "#7ed49a", fontSize: 12.5, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                      <CheckCircle2 size={16} /> Quote generated — sent to Alex & Nate for review.
                    </div>
                    {clientEmail ? (
                      <button onClick={handleSendToClient} disabled={sendingToClient || clientSent} style={{
                        width: "100%", padding: "12px 18px", borderRadius: 10, background: clientSent ? "rgba(126,212,154,0.15)" : GOLD,
                        border: "none", color: clientSent ? "#7ed49a" : "#0c0b0a", fontSize: 13.5, fontWeight: 700,
                        cursor: clientSent ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 8,
                      }}>
                        {sendingToClient ? <Loader2 size={15} className="animate-spin" /> : clientSent ? <CheckCircle2 size={15} /> : null}
                        {clientSent ? "Sent to Client" : "Send Branded Quote to Client"}
                      </button>
                    ) : (
                      <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)" }}>No client email on file — quote is with Alex/Nate to send manually or you can go back and add one.</p>
                    )}
                  </>
                )}
              </div>
            )}

            {hasVendorSelections && (
              <div style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Vendor Quote Requests</p>
                {!vendorDispatchResult ? (
                  <button onClick={handleDispatchVendors} disabled={dispatchingVendors} style={{
                    width: "100%", padding: "12px 18px", borderRadius: 10, background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.2)", color: "#fff", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  }}>
                    {dispatchingVendors && <Loader2 size={15} className="animate-spin" />}
                    Send Vendor Quote Requests
                  </button>
                ) : (
                  <div style={{ padding: 12, borderRadius: 10, background: "rgba(126,212,154,0.1)", color: "#7ed49a", fontSize: 12.5 }}>
                    Sent {vendorDispatchResult.sent} vendor request{vendorDispatchResult.sent === 1 ? "" : "s"}.
                    {vendorDispatchResult.tradesWithoutVendor && vendorDispatchResult.tradesWithoutVendor.length > 0 && (
                      <p style={{ marginTop: 6, color: "#ffcf7a" }}>
                        No vendor on file for: {vendorDispatchResult.tradesWithoutVendor.map(t => TRADE_LABELS[t] || t).join(", ")}. Add one in Admin → Vendor Directory.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <button onClick={onClose} style={{
              width: "100%", padding: "12px 18px", borderRadius: 10, background: "transparent",
              border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 600, cursor: "pointer", marginTop: 6,
            }}>Done</button>
          </>
        )}
        </>
        )}
      </div>
    </div>
  );
}
