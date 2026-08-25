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
import { useEffect, useMemo, useState, useRef } from "react";
import { Camera, Loader2, CheckCircle2, ChevronRight, ChevronLeft, ChevronDown, Star, X, Plus, Pencil, Eye } from "lucide-react";
import { ConsultResumePicker, ResumeCheckingSpinner, type ResumeItem } from "./ConsultResumePicker";
import { PdfViewerModal } from "./PdfViewerModal";
import { SmartDataPanel } from "./SmartDataPanel";
import { FubAddressChooser, type FubAddress } from "./FubAddressChooser";
import { ClientPreviewModal } from "./ClientPreviewModal";

type RepairItem = {
  id: number; key: string; category: "in_house" | "vendor"; trade: string; name: string;
  unit: "sqft" | "linear_ft" | "each" | "flat";
  default_rate: number | null; min_charge: number; two_story_eligible: number;
  sequence_order: number; instruction: string | null;
};

type CheckedState = {
  checked: boolean; quantity: string; twoStory: boolean;
  photos: string[]; measurementNotes: string;
  // v20.32.17 — Vendor Quote Upload: agent already has an instant quote from
  // the vendor (texted, emailed, verbal) and wants an on-the-spot client
  // price without waiting on a formal dispatch. Only meaningful on vendor
  // (category === "vendor") items — ignored for in-house items.
  hasVendorQuote: boolean; vendorQuoteAmount: string;
};

// v20.19.0 — bundled discount packages. itemKeys are auto-checked in-house
// items; vendorItemKeys (rare — only smoke_remediation today) are auto-checked
// vendor trades so they ride along into the same dispatch pass.
type RepairPackage = {
  key: string; name: string; description: string; tier: "small" | "medium" | "large" | "largest";
  discountPct: number; itemKeys: string[]; vendorItemKeys: string[] | null;
};

const TIER_LABELS: Record<string, string> = { small: "Small", medium: "Medium", large: "Large", largest: "Largest" };
const TIER_ORDER = ["small", "medium", "large", "largest"];

// v20.22.0 — Predetermined catalog mappings, one per walkthrough pillar tier
// (key matches ListingConsultSheet's PillarKey; tier is "small"/"medium"/
// "large" from the walkthrough). Quantities are sensible stated-maximum
// DEFAULTS for an average ~2,000 sqft single-story home — not a measurement
// of the actual property. They give the agent a fast, defined starting
// point (per the standing every-item-needs-a-defined-line rule) that gets
// auto-checked into the checklist below; the agent still adjusts quantities
// to match what they actually saw before generating the quote. Flooring has
// no entry on purpose: the walkthrough tier alone (1-2 rooms / several
// rooms / whole house) doesn't tell us LVP vs. carpet vs. wood refinish,
// and those are vendor-quoted items never summed into our own total —
// guessing the type would misdirect a vendor dispatch, so flooring stays
// guidance-only (banner below) until the agent picks the right vendor item.
// v20.26.0 — 5 real tiers per pillar (minimum/small/medium/large/maximum),
// not 3. The scope slider has 5 stops; before this fix, PILLAR_TIER_ORDER
// only had 3 entries (small/medium/large), so a pillar flagged "small" or
// "large" during the walkthrough had 2 of its 4 possible slider moves
// clamp to the SAME tier — the price visibly did nothing on half the
// slider. "minimum" and "maximum" are real, distinct scope levels built
// from the same existing catalog items (no new items/rates introduced),
// each qty a defined-maximum default per the standing scope-cap rule.
const PILLAR_ITEM_MAP: Record<string, Record<string, { itemKey: string; qty: number }[]>> = {
  pressure_wash: {
    minimum: [{ itemKey: "pressure_wash_hard", qty: 400 }],
    small: [{ itemKey: "pressure_wash_hard", qty: 700 }],
    medium: [{ itemKey: "pressure_wash_hard", qty: 700 }, { itemKey: "pressure_wash_ext", qty: 1800 }],
    large: [{ itemKey: "pressure_wash_hard", qty: 700 }, { itemKey: "pressure_wash_ext", qty: 1800 }, { itemKey: "soft_wash_roof", qty: 2200 }],
    maximum: [{ itemKey: "pressure_wash_hard", qty: 900 }, { itemKey: "pressure_wash_ext", qty: 2400 }, { itemKey: "soft_wash_roof", qty: 2800 }],
  },
  lawn: {
    minimum: [{ itemKey: "lawn_mow", qty: 5000 }],
    small: [{ itemKey: "lawn_mow", qty: 8000 }],
    medium: [{ itemKey: "lawn_mow", qty: 8000 }, { itemKey: "hedge_trim", qty: 150 }, { itemKey: "weed_pull", qty: 200 }],
    large: [{ itemKey: "lawn_mow", qty: 8000 }, { itemKey: "hedge_trim", qty: 150 }, { itemKey: "weed_pull", qty: 200 }, { itemKey: "mulching", qty: 300 }, { itemKey: "tree_hedge_removal", qty: 1 }],
    maximum: [{ itemKey: "lawn_mow", qty: 8000 }, { itemKey: "hedge_trim", qty: 250 }, { itemKey: "weed_pull", qty: 350 }, { itemKey: "mulching", qty: 500 }, { itemKey: "tree_hedge_removal", qty: 2 }],
  },
  paint: {
    minimum: [{ itemKey: "paint_int_body", qty: 150 }],
    small: [{ itemKey: "paint_int_body", qty: 350 }, { itemKey: "paint_int_trim", qty: 50 }],
    medium: [{ itemKey: "paint_int_body", qty: 1000 }, { itemKey: "paint_int_trim", qty: 150 }],
    large: [{ itemKey: "paint_int_body", qty: 2400 }, { itemKey: "paint_int_trim", qty: 300 }, { itemKey: "paint_int_ceiling", qty: 2000 }],
    maximum: [{ itemKey: "paint_int_body", qty: 3200 }, { itemKey: "paint_int_trim", qty: 400 }, { itemKey: "paint_int_ceiling", qty: 2600 }],
  },
  deep_clean: {
    minimum: [{ itemKey: "rough_clean", qty: 1200 }],
    small: [{ itemKey: "rough_clean", qty: 2000 }],
    medium: [{ itemKey: "deep_clean", qty: 2000 }],
    large: [{ itemKey: "deep_clean", qty: 2500 }, { itemKey: "carpet_clean", qty: 800 }],
    maximum: [{ itemKey: "deep_clean", qty: 3000 }, { itemKey: "carpet_clean", qty: 1200 }],
  },
  junk_out: {
    minimum: [],
    small: [{ itemKey: "junk_small", qty: 1 }],
    medium: [{ itemKey: "junk_small", qty: 2 }],
    // v20.32.5 — walkthrough label calls large "multiple loads / whole-house
    // clear-out" — 1x junk_large under-priced that scope. 2x/3x define the
    // real caps (defined-line rule) instead of leaving it a placeholder.
    large: [{ itemKey: "junk_large", qty: 2 }],
    maximum: [{ itemKey: "junk_large", qty: 3 }],
  },
  // v20.32.5 — Flooring fallback bundle (used only when the agent flagged
  // Flooring with NO material detail checked — e.g. older consults saved
  // before the lvp/carpet/tile/refinish details existed). Defaults to LVP,
  // the most common resale-prep flooring ask, so something real always gets
  // flagged for the vendor instead of nothing. Flat vendor item — qty is a
  // placeholder (never priced/summed), the real number always comes from
  // the vendor's own quote.
  flooring: {
    minimum: [{ itemKey: "v_floor_lvp", qty: 1 }],
    small: [{ itemKey: "v_floor_lvp", qty: 1 }],
    medium: [{ itemKey: "v_floor_lvp", qty: 1 }],
    large: [{ itemKey: "v_floor_lvp", qty: 1 }],
    maximum: [{ itemKey: "v_floor_lvp", qty: 1 }],
  },
};

// v20.27.0 — Detail-driven auto-check. When the walkthrough agent checked
// specific area/scope-mode boxes (House/Driveway/Patio for pressure wash,
// Whole-Home Interior vs. Touch-Up Only vs. Exterior for paint, etc. — see
// PILLAR_DEFS.details in ListingConsultSheet.tsx), those exact catalog items
// get auto-checked instead of the whole fixed tier bundle. This is strictly
// MORE precise than tier alone: the photos + checked details are the
// evidence of the actual need, and the tier/slider still sets how big each
// of those items is. If an agent flags a pillar with NO details (older
// consults, or a fast flag with no time to break it down), this map is
// skipped entirely and PILLAR_ITEM_MAP's tier-only bundle above is used —
// fully backward compatible.
const DETAIL_ITEM_MAP: Record<string, Record<string, string[]>> = {
  pressure_wash: {
    house: ["pressure_wash_ext"],
    driveway: ["pressure_wash_hard"],
    patio: ["pressure_wash_hard"],
    walkway: ["pressure_wash_hard"],
    roof: ["soft_wash_roof"],
  },
  lawn: {
    mowing: ["lawn_mow"],
    hedge_trim: ["hedge_trim"],
    weed_pull: ["weed_pull"],
    mulching: ["mulching"],
    tree_removal: ["tree_hedge_removal"],
  },
  paint: {
    touch_up_only: ["paint_int_body", "paint_int_trim"],
    whole_home_interior: ["paint_int_body", "paint_int_trim", "paint_int_ceiling"],
    exterior: ["paint_ext_body", "paint_ext_trim"],
    ceilings: ["paint_int_ceiling"],
    trim_doors: ["paint_int_trim"],
  },
  deep_clean: {
    standard: ["rough_clean"],
    deep: ["deep_clean"],
    carpets: ["carpet_clean"],
  },
  // v20.32.5 — which flooring material was actually flagged during the
  // walkthrough drives which vendor trade gets called — LVP, carpet, tile,
  // and wood refinish are different vendors with different quotes.
  flooring: {
    lvp: ["v_floor_lvp"],
    carpet: ["v_floor_carpet"],
    tile: ["v_tile_install"],
    refinish: ["v_floor_refinish"],
  },
};

// v20.27.0 — Per-item qty defaults across all 5 tiers, used when auto-
// checking via DETAIL_ITEM_MAP above. Same defined-maximum-default
// philosophy as PILLAR_ITEM_MAP: reasonable starting points for an average
// ~2,000 sqft single-story home, always agent-editable before the quote
// generates — never a measurement of the actual property.
const ITEM_QTY_BY_TIER: Record<string, Record<string, number>> = {
  pressure_wash_hard: { minimum: 400, small: 700, medium: 700, large: 700, maximum: 900 },
  pressure_wash_ext: { minimum: 1200, small: 1500, medium: 1800, large: 1800, maximum: 2400 },
  soft_wash_roof: { minimum: 1500, small: 1800, medium: 2000, large: 2200, maximum: 2800 },
  lawn_mow: { minimum: 5000, small: 8000, medium: 8000, large: 8000, maximum: 8000 },
  hedge_trim: { minimum: 75, small: 100, medium: 150, large: 150, maximum: 250 },
  weed_pull: { minimum: 75, small: 100, medium: 200, large: 200, maximum: 350 },
  mulching: { minimum: 100, small: 150, medium: 200, large: 300, maximum: 500 },
  tree_hedge_removal: { minimum: 1, small: 1, medium: 1, large: 1, maximum: 2 },
  paint_int_body: { minimum: 150, small: 350, medium: 1000, large: 2400, maximum: 3200 },
  paint_int_trim: { minimum: 30, small: 50, medium: 150, large: 300, maximum: 400 },
  paint_int_ceiling: { minimum: 400, small: 800, medium: 1400, large: 2000, maximum: 2600 },
  paint_ext_body: { minimum: 400, small: 800, medium: 1500, large: 2400, maximum: 3200 },
  paint_ext_trim: { minimum: 50, small: 100, medium: 200, large: 300, maximum: 400 },
  rough_clean: { minimum: 1200, small: 2000, medium: 2000, large: 2500, maximum: 3000 },
  deep_clean: { minimum: 800, small: 1400, medium: 2000, large: 2500, maximum: 3000 },
  carpet_clean: { minimum: 200, small: 400, medium: 600, large: 800, maximum: 1200 },
  // v20.32.5 — flooring vendor items are unit:"flat" with no rate, so qty
  // never affects price — it only needs to be a real number so the
  // detail-driven auto-check (which skips itemKeys with qty===undefined)
  // doesn't silently drop the flagged vendor line.
  v_floor_lvp: { minimum: 1, small: 1, medium: 1, large: 1, maximum: 1 },
  v_floor_carpet: { minimum: 1, small: 1, medium: 1, large: 1, maximum: 1 },
  v_tile_install: { minimum: 1, small: 1, medium: 1, large: 1, maximum: 1 },
  v_floor_refinish: { minimum: 1, small: 1, medium: 1, large: 1, maximum: 1 },
};

// v20.32.5 — Flooring is always vendor-quoted (materials vary too widely for
// an in-house rate). Since there's no dollar figure to hand the vendor, give
// them a defined sqft range instead of a blank line — same language as the
// walkthrough tier labels in ListingConsultSheet.tsx's PILLAR_DEFS.
const FLOORING_SQFT_NOTE: Record<string, string> = {
  minimum: "Approx. 1 room, under 150 sqft — vendor to confirm exact measurement on site.",
  small: "Approx. 150–400 sqft (1–2 rooms) — vendor to confirm exact measurement on site.",
  medium: "Approx. 400–1,200 sqft (several rooms / one level) — vendor to confirm exact measurement on site.",
  large: "Approx. 1,200–2,500 sqft (whole house) — vendor to confirm exact measurement on site.",
  maximum: "Approx. 2,500+ sqft (whole house, max scope) — vendor to confirm exact measurement on site.",
};

// v20.26.0 — Scope slider mechanics. Pillar tiers now run
// minimum -> small -> medium -> large -> maximum (see PILLAR_ITEM_MAP
// above) so all 5 slider stops map to a distinct, real preset for any
// pillar flagged at small/medium/large during the walkthrough.
const PILLAR_TIER_ORDER = ["minimum", "small", "medium", "large", "maximum"];
const SCOPE_SHIFT_LABELS: Record<number, string> = {
  "-2": "Bare Minimum", "-1": "Leaner Scope", "0": "As Flagged", "1": "Full Service", "2": "Max Scope",
};
function shiftPillarTier(tier: string, delta: number): string {
  const idx = PILLAR_TIER_ORDER.indexOf(tier);
  if (idx === -1) return tier;
  const next = Math.min(PILLAR_TIER_ORDER.length - 1, Math.max(0, idx + delta));
  return PILLAR_TIER_ORDER[next];
}

// v20.24.0 — Always-Included baseline catalog items (see IN_HOUSE_ITEMS
// server seed). Auto-checked on every consult regardless of pillars/slider.
const ALWAYS_INCLUDE_KEYS = ["prep_protection", "final_walkthrough_clean"];

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
  flooring_lvp: "LVP Flooring", flooring_carpet: "Carpet Installation", flooring_epoxy: "Epoxy Flooring", appliances: "Appliances",
  countertops: "Countertops", retexture: "Re-Texturing", shower_doors: "Frameless Shower Doors",
  irrigation: "Irrigation", fencing: "Fencing", pool_equipment: "Pool Equipment", septic: "Septic",
  water_heater: "Water Heater", tree_removal_large: "Large Tree Removal", structural: "Structural / Foundation",
  mold_remediation: "Mold Remediation", chimney: "Chimney", solar: "Solar", water_damage: "Water Damage Restoration",
  garage_door: "Garage Door", hardscape: "Hardscape / Pavers", land_clearing: "Land Clearing",
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
  nestedFromListing = false, prefillHeroPhotoUrl = null, prefillGalleryUrls = null, prefillFlaggedPillars = null,
  initialConsultId = null, dealSide = "seller",
}: {
  leadId?: number | null; agentId?: number | null;
  initialAddress?: string; initialClientName?: string; initialClientEmail?: string; initialClientPhone?: string;
  onClose: () => void;
  // v20.33.0 — which side of the deal this consult is for. Sellers can only
  // repair/inspect property they already own (their FUB address is a valid
  // candidate for the subject property). Buyers are inspecting/repairing a
  // property they don't own yet (their FUB address is just their current
  // home) — never a candidate. Defaults to "seller" for existing callers.
  dealSide?: "buyer" | "seller";
  // v20.30.0 — Admin Repair Program panel: open THIS sheet already pointed at
  // an existing consult (any agent's), skipping the resume picker entirely,
  // so Alex can view/edit the full scope from the admin side at any point —
  // before or after a quote has been generated, approved, or sent.
  initialConsultId?: number | null;
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
  // v20.19.0 — Listing Consult's own walkthrough photos, carried over so the
  // agent isn't asked to shoot/pick the same walkthrough twice. Treated as
  // Repair Scope evidence by default (they were taken during the same visit
  // where repairs were flagged). When present + nested, the gallery step is
  // skipped entirely — straight to Review.
  prefillGalleryUrls?: string[] | null;
  // v20.21.0 — the Condition Check pillars flagged during Listing Consult's
  // walkthrough step (checked pillar + size tier + note). Guidance only —
  // does NOT auto-check any catalog item, since the exact tier-to-catalog
  // mapping is still Alex's call. Rendered as a banner atop the checklist so
  // the agent isn't re-diagnosing condition they already looked at minutes ago.
  prefillFlaggedPillars?: { key: string; label: string; tier: string; notes: string; details?: string[] }[] | null;
}) {
  const [step, setStep] = useState<"info" | "checklist" | "gallery" | "review">(nestedFromListing ? "checklist" : "info");
  const [consultId, setConsultId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  // v20.14.5 — Resume picker: nested-from-listing skips straight to "ready"
  // (that flow already carries its own state from the parent Listing Consult
  // and creates its own record immediately). Standalone opens check for any
  // in-progress consult this agent already started before rendering steps.
  const [resumePhase, setResumePhase] = useState<"checking" | "picking" | "ready">((nestedFromListing || initialConsultId) ? "ready" : "checking");
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
  const [fubResults, setFubResults] = useState<{ id: number; name: string; email: string | null; phone: string | null; address: string | null; addresses?: FubAddress[] }[]>([]);
  const [fubSearching, setFubSearching] = useState(false);
  const [fubPickedName, setFubPickedName] = useState<string | null>(null);
  // v20.32.14 — when the picked FUB contact owns more than one property,
  // hold off autofilling Property Address and show a chooser instead.
  const [fubAddressChoices, setFubAddressChoices] = useState<FubAddress[]>([]);
  // v20.33.0 — seller-side-only escape hatch: if this consult is actually
  // about a DIFFERENT property than the one auto-filled/chosen above (e.g.
  // the seller owns more than one place and picked the wrong one, or wants
  // to override), type it here. Blank means "the address above is correct."
  const [subjectAddressOverride, setSubjectAddressOverride] = useState("");
  const effectiveAddress = (subjectAddressOverride.trim() || propertyAddress.trim());

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

  const pickFubContact = (c: { name: string; email: string | null; phone: string | null; address: string | null; addresses?: FubAddress[] }) => {
    setClientName(c.name);
    if (c.email) setClientEmail(c.email);
    if (c.phone) setClientPhone(c.phone);
    // v20.33.0 — buyers can't repair/inspect a home they don't own yet, so a
    // buyer's FUB address (their current home) is never a candidate for the
    // subject property. Never auto-fill and never show the property chooser
    // on the buyer side — always leave it blank for manual entry.
    if (dealSide === "buyer") {
      setFubAddressChoices([]);
    } else {
      // v20.32.14 — a client can own multiple properties (out-of-state home,
      // local vacant lot, etc.). Only auto-fill when there's exactly one
      // address on file — otherwise show a chooser so the agent picks the
      // right property instead of always getting whichever FUB lists first.
      const addrs = c.addresses || [];
      if (addrs.length > 1) {
        setFubAddressChoices(addrs);
      } else {
        setFubAddressChoices([]);
        if (c.address) setPropertyAddress(c.address);
      }
    }
    setFubPickedName(c.name);
    setFubQuery(c.name);
    setFubResults([]);
  };

  const [heroPhotoUrl, setHeroPhotoUrl] = useState<string | null>(prefillHeroPhotoUrl || null);
  const [galleryUrls, setGalleryUrls] = useState<{ url: string; tag: "overview" | "repair_scope" }[]>(
    (prefillGalleryUrls || []).map(url => ({ url, tag: "repair_scope" as const }))
  );
  // v20.19.0 — true only when the gallery step was auto-skipped because
  // Listing Consult's own walkthrough photos already cover it. Drives the
  // "reuse" note on Review and lets the agent still add more if they want.
  const [gallerySkipped, setGallerySkipped] = useState(false);
  // v20.15.2 — which tag new bulk-uploaded photos get; mirrors ListingConsultSheet.
  const [galleryTagMode, setGalleryTagMode] = useState<"overview" | "repair_scope">("repair_scope");
  const [uploadingHero, setUploadingHero] = useState(false);
  const [uploadingGallery, setUploadingGallery] = useState(false);
  const [galleryProgress, setGalleryProgress] = useState<{ done: number; total: number } | null>(null);

  const [catalog, setCatalog] = useState<RepairItem[]>([]);
  const [checked, setChecked] = useState<Record<string, CheckedState>>({});
  const [catalogLoading, setCatalogLoading] = useState(true);
  // v20.19.0 — bundled packages (discount ladder) + free-service incentive.
  const [packages, setPackages] = useState<RepairPackage[]>([]);
  const [selectedPackageKey, setSelectedPackageKey] = useState<string | null>(null);
  const [applyingPackage, setApplyingPackage] = useState(false);
  // v20.16.0 — real usage-frequency map from past consults (item_key -> times
  // actually selected), used to surface a "Frequently Selected" shortlist and
  // to auto-expand trades that have real history. Not AI, not a guess — just
  // a count of what agents have actually picked before.
  const [popularity, setPopularity] = useState<Record<string, number>>({});
  // v20.16.0 — default-collapsed trade accordions cut the scroll/tap count on
  // first load; a trade auto-expands once it has a checked item in it (below).
  const [expandedTrades, setExpandedTrades] = useState<Record<string, boolean>>({});

  // v20.13.0 — start window/date/time are no longer captured in this wizard;
  // scheduling happens later from the admin panel once deposit is received.

  const [submittingItems, setSubmittingItems] = useState(false);
  const [totals, setTotals] = useState<{ subtotal: number; total: number; discountAmount?: number; freeItemKey?: string | null; vendorQuotedSubtotal?: number } | null>(null);
  const [quoteResult, setQuoteResult] = useState<{ pdfUrl: string; agreementPdfUrl: string; acceptUrl: string; total: number } | null>(null);
  // v20.31.0 — in-app PDF viewer state. Replaces target="_blank" links,
  // which get stuck with no way back when the app runs as an installed
  // home-screen PWA (no tabs, no browser back button in standalone mode).
  const [pdfModal, setPdfModal] = useState<{ url: string; title: string } | null>(null);
  const [generatingQuote, setGeneratingQuote] = useState(false);
  const [sendingToClient, setSendingToClient] = useState(false);
  const [clientSent, setClientSent] = useState(false);
  const [dispatchingVendors, setDispatchingVendors] = useState(false);
  const [showClientPreview, setShowClientPreview] = useState(false);
  const [vendorDispatchResult, setVendorDispatchResult] = useState<{ sent: number; tradesWithoutVendor?: string[] } | null>(null);
  const [error, setError] = useState("");
  // v20.25.0 — THE CLOSE: on-the-phone-with-client review gate. Nothing
  // auto-generates/dispatches until the agent explicitly confirms here, which
  // gives a moment to add or remove key items live with the client before
  // anything is printed, quoted, or sent.
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [savingReview, setSavingReview] = useState(false);
  // v20.30.0 — lets the scope/items list be reopened for editing AFTER a
  // quote has already been generated, instead of the old "only editable
  // once, then locked until you close the whole sheet" behavior.
  const [editingScope, setEditingScope] = useState(false);
  const [addItemQuery, setAddItemQuery] = useState("");
  // v20.26.0 — which checked item's inline editor is open on Review & Send
  // (quantity / two-story / measurement notes) — null means none expanded.
  const [editingReviewItem, setEditingReviewItem] = useState<string | null>(null);

  useEffect(() => {
    if (!manageNavVisibility) return; // parent sheet already owns nav visibility
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, [manageNavVisibility]);

  useEffect(() => {
    fetchJson("/api/repair-items")
      .then(d => { setCatalog(d.items || []); setPopularity(d.popularity || {}); })
      .catch(() => setError("Couldn't load the repair catalog. Try again."))
      .finally(() => setCatalogLoading(false));
    fetchJson("/api/repair-consult/packages")
      .then(d => setPackages(d.packages || []))
      .catch(() => {}); // non-fatal — checklist still works without packages
  }, []);

  // v20.30.0 — Admin "Edit" launch: jump straight to the given consult,
  // no resume picker, no "mine" filtering (any agent's consult is fair game
  // from the admin side).
  useEffect(() => {
    if (initialConsultId) { handleResumeConsult(initialConsultId); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConsultId]);

  // v20.14.5 — check for resumable consults on standalone opens only.
  useEffect(() => {
    if (nestedFromListing || initialConsultId) return;
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

  // v20.24.0 — Scope slider. -1 = Lean (drop down one tier per flagged
  // pillar, e.g. medium -> small), 0 = As Flagged (walkthrough tier as-is),
  // +1 = Full Service (bump up one tier, e.g. medium -> large). Only ever
  // touches items that live inside PILLAR_ITEM_MAP for the flagged pillars —
  // manual picks/edits outside that set are never affected, at any position.
  const [scopeShift, setScopeShift] = useState(0);
  const allPillarMappedKeys = useMemo(() => {
    const s = new Set<string>();
    if (prefillFlaggedPillars) {
      for (const flagged of prefillFlaggedPillars) {
        if (flagged.details && flagged.details.length > 0) {
          const detailMap = DETAIL_ITEM_MAP[flagged.key] || {};
          for (const d of flagged.details) {
            for (const itemKey of detailMap[d] || []) s.add(itemKey);
          }
        } else {
          const tiers = PILLAR_ITEM_MAP[flagged.key] || {};
          for (const tierKey of Object.keys(tiers)) {
            for (const { itemKey } of tiers[tierKey]) s.add(itemKey);
          }
        }
      }
    }
    return s;
  }, [prefillFlaggedPillars]);

  // v20.22.0 + v20.24.0 — apply PILLAR_ITEM_MAP defaults for every pillar
  // flagged during the walkthrough, at the tier the walkthrough set, shifted
  // by the scope slider. Re-fires only when the slider moves (or on mount) —
  // it clears+reapplies just the pillar-mapped keys each time, so quantities
  // the agent has hand-edited on items OUTSIDE the pillar map are never
  // clobbered, no matter how many times the slider is dragged.
  useEffect(() => {
    if (!prefillFlaggedPillars || prefillFlaggedPillars.length === 0) return;
    setChecked(prev => {
      const next = { ...prev };
      for (const key of allPillarMappedKeys) {
        if (next[key]) next[key] = { ...next[key], checked: false };
      }
      for (const flagged of prefillFlaggedPillars) {
        const tier = shiftPillarTier(flagged.tier, scopeShift);
        let flooringKeysThisPillar: string[] = [];
        if (flagged.details && flagged.details.length > 0) {
          // v20.27.0 — detail-driven: only the specific items tied to the
          // checked details get auto-checked, sized by the (shifted) tier.
          const detailMap = DETAIL_ITEM_MAP[flagged.key] || {};
          for (const d of flagged.details) {
            for (const itemKey of detailMap[d] || []) {
              const qty = ITEM_QTY_BY_TIER[itemKey]?.[tier];
              if (qty === undefined) continue;
              next[itemKey] = { ...(next[itemKey] || DEFAULT_ITEM_STATE), checked: true, quantity: String(qty) };
              if (flagged.key === "flooring") flooringKeysThisPillar.push(itemKey);
            }
          }
        } else {
          const mapped = PILLAR_ITEM_MAP[flagged.key]?.[tier] || [];
          for (const { itemKey, qty } of mapped) {
            next[itemKey] = { ...(next[itemKey] || DEFAULT_ITEM_STATE), checked: true, quantity: String(qty) };
            if (flagged.key === "flooring") flooringKeysThisPillar.push(itemKey);
          }
        }
        // v20.32.5 — Flooring has no in-house rate, so hand the vendor a
        // defined sqft range instead of a blank line (see FLOORING_SQFT_NOTE).
        if (flagged.key === "flooring") {
          const note = FLOORING_SQFT_NOTE[tier];
          for (const itemKey of flooringKeysThisPillar) {
            if (note && next[itemKey] && !next[itemKey].measurementNotes) {
              next[itemKey] = { ...next[itemKey], measurementNotes: note };
            }
          }
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillFlaggedPillars, scopeShift, allPillarMappedKeys]);

  // v20.24.0 — Always-Included baseline items (site prep/protection, final
  // walkthrough clean-up) auto-check on every consult, once catalog is
  // loaded, regardless of pillars or slider position — these are the
  // trust-building touches Alex wants on every estimate.
  const appliedAlwaysIncludeRef = useRef(false);
  useEffect(() => {
    if (appliedAlwaysIncludeRef.current) return;
    if (catalog.length === 0) return;
    appliedAlwaysIncludeRef.current = true;
    setChecked(prev => {
      const next = { ...prev };
      for (const key of ALWAYS_INCLUDE_KEYS) {
        if (!next[key]?.checked) next[key] = { ...(next[key] || DEFAULT_ITEM_STATE), checked: true, quantity: "1" };
      }
      return next;
    });
  }, [catalog]);

  const inHouseItems = useMemo(() => catalog.filter(i => i.category === "in_house").sort((a, b) => a.sequence_order - b.sequence_order), [catalog]);
  const vendorItems = useMemo(() => catalog.filter(i => i.category === "vendor").sort((a, b) => a.sequence_order - b.sequence_order), [catalog]);

  // v20.21.0 — Sign-Today incentive settings, fetched once so the sticky
  // live-total on the checklist step can preview the free-item threshold
  // before the agent ever hits "Generate Quote".
  const [incentiveSettings, setIncentiveSettings] = useState<{ active: boolean; thresholdAmount?: number; freeItemKey?: string; label?: string }>({ active: false });
  useEffect(() => {
    fetchJson("/api/repair-consult/incentive-settings").then(setIncentiveSettings).catch(() => {});
  }, []);

  // v20.32.17 — Vendor Quote Upload: markup % applied to any vendor item
  // where the agent has already entered a vendor-quoted amount. Fetched once
  // so the checklist can show a live client-price preview as the agent types.
  const [vendorQuoteSettings, setVendorQuoteSettings] = useState<{ markupPct: number }>({ markupPct: 0.20 });
  useEffect(() => {
    fetchJson("/api/vendor-quote-settings").then(setVendorQuoteSettings).catch(() => {});
  }, []);

  // v20.21.0 — Sticky Live Total. Mirrors server computeLineTotal exactly
  // (rate × qty, +25% two-story surcharge if eligible, floored at min_charge)
  // plus the same package-discount-on-eligible-subtotal logic, so the agent
  // sees the real number update live as they check items — no more waiting
  // for "Generate Quote" to find out the total. In-house items ONLY (vendor
  // trades are quoted separately and never summed in here).
  const TWO_STORY_SURCHARGE_PCT = 0.25;
  const computeLineTotalClient = (rate: number, qty: number, min: number, twoStory: boolean, twoStoryEligible: boolean) => {
    let total = rate * qty;
    if (twoStory && twoStoryEligible) total *= 1 + TWO_STORY_SURCHARGE_PCT;
    return Math.max(total, min || 0);
  };
  const liveTotals = useMemo(() => {
    const pkg = selectedPackageKey ? packages.find(p => p.key === selectedPackageKey) : null;
    let subtotal = 0;
    let packageEligibleSubtotal = 0;
    for (const item of inHouseItems) {
      const st = checked[item.key];
      if (!st?.checked) continue;
      const qty = Number(st.quantity) || 0;
      const twoStory = !!st.twoStory && !!item.two_story_eligible;
      const lineTotal = computeLineTotalClient(item.default_rate || 0, qty, item.min_charge || 0, twoStory, !!item.two_story_eligible);
      subtotal += lineTotal;
      if (pkg && pkg.itemKeys.includes(item.key)) packageEligibleSubtotal += lineTotal;
    }
    const discountPct = pkg ? pkg.discountPct : 0;
    const discountAmount = Math.round(packageEligibleSubtotal * discountPct * 100) / 100;
    const total = Math.round((subtotal - discountAmount) * 100) / 100;
    const threshold = incentiveSettings.active ? incentiveSettings.thresholdAmount || 0 : null;
    const freeItemHit = threshold !== null && total >= threshold;
    const remainingToFreeItem = threshold !== null && !freeItemHit ? Math.max(threshold - total, 0) : 0;

    // v20.32.17 — Vendor Quote Upload: live client-price preview for any
    // checked vendor item that already has an uploaded vendor quote amount.
    // Deliberately kept OUT of subtotal/total above (standing rule: vendor
    // pricing is always separate) — surfaced as its own field.
    let vendorQuotedSubtotal = 0;
    for (const item of vendorItems) {
      const st = checked[item.key];
      if (!st?.checked || !st.hasVendorQuote) continue;
      const amt = Number(st.vendorQuoteAmount) || 0;
      if (amt > 0) vendorQuotedSubtotal += Math.round(amt * (1 + (vendorQuoteSettings.markupPct || 0)) * 100) / 100;
    }

    return { subtotal, discountAmount, total, threshold, freeItemHit, remainingToFreeItem, vendorQuotedSubtotal };
  }, [checked, inHouseItems, vendorItems, selectedPackageKey, packages, incentiveSettings, vendorQuoteSettings]);

  const groupedByTrade = (items: RepairItem[]) => {
    const map = new Map<string, RepairItem[]>();
    for (const it of items) {
      if (!map.has(it.trade)) map.set(it.trade, []);
      map.get(it.trade)!.push(it);
    }
    return [...map.entries()];
  };

  const DEFAULT_ITEM_STATE: CheckedState = { checked: false, quantity: "1", twoStory: false, photos: [], measurementNotes: "", hasVendorQuote: false, vendorQuoteAmount: "" };
  const setItemState = (key: string, patch: Partial<CheckedState>) => {
    setChecked(prev => {
      const base = prev[key] || DEFAULT_ITEM_STATE;
      return { ...prev, [key]: { ...base, ...patch } };
    });
  };

  // v20.19.0 — Select (or clear) a package. Selecting auto-checks every item
  // in the bundle (in-house + the rare vendor trade like smoke_remediation's
  // v_hvac) so the agent doesn't have to hunt them down individually — they
  // can still adjust quantities/two-story/notes per item afterward.
  // Clearing a package does NOT auto-uncheck anything (avoids silently
  // dropping items the agent may have separately relied on) — it only drops
  // the discount going forward.
  const handleSelectPackage = async (pkg: RepairPackage | null) => {
    setApplyingPackage(true);
    setError("");
    try {
      const id = await ensureConsult();
      await fetchJson(`/api/repair-consult/${id}/select-package`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageKey: pkg?.key ?? null }),
      });
      setSelectedPackageKey(pkg?.key ?? null);
      if (pkg) {
        setChecked(prev => {
          const next = { ...prev };
          for (const k of [...pkg.itemKeys, ...(pkg.vendorItemKeys || [])]) {
            next[k] = { ...(next[k] || DEFAULT_ITEM_STATE), checked: true };
          }
          return next;
        });
      }
    } catch (e: any) { setError(e.message || "Failed to apply that package."); }
    finally { setApplyingPackage(false); }
  };

  // v20.16.0 — top real-usage items across both categories, for the pinned
  // "Frequently Selected" shortlist. Genuine counts from past consults only
  // (server already excludes archived + TEST-DELETE-ME gate runs) — this is
  // NOT AI-guessed, it's what agents have actually picked before.
  const frequentItems = useMemo(
    () => catalog.filter(it => (popularity[it.key] || 0) > 0).sort((a, b) => (popularity[b.key] || 0) - (popularity[a.key] || 0)).slice(0, 6),
    [catalog, popularity]
  );
  const toggleTrade = (trade: string) => setExpandedTrades(prev => ({ ...prev, [trade]: !isTradeExpanded(trade) }));
  const isTradeExpanded = (trade: string) => {
    if (trade in expandedTrades) return expandedTrades[trade];
    // auto-expand a trade group that already has a checked item in it
    // (e.g. resuming a saved consult) so nothing looks hidden/lost.
    return catalog.some(it => it.trade === trade && checked[it.key]?.checked);
  };
  const tradeHeaderRow = (trade: string, items: RepairItem[]) => {
    const checkedCount = items.filter(it => checked[it.key]?.checked).length;
    const expanded = isTradeExpanded(trade);
    return (
      <button type="button" onClick={() => toggleTrade(trade)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
        background: "none", border: "none", cursor: "pointer", padding: "4px 0 6px", textAlign: "left",
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "rgba(255,255,255,0.4)", fontWeight: 700, letterSpacing: "0.06em" }}>
          {TRADE_LABELS[trade] || trade}
          {checkedCount > 0 && (
            <span style={{ background: GOLD, color: "#0c0b0a", borderRadius: 8, fontSize: 9.5, fontWeight: 800, padding: "1px 6px" }}>{checkedCount} selected</span>
          )}
        </span>
        <ChevronDown size={14} style={{ color: "rgba(255,255,255,0.4)", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>
    );
  };

  // v20.16.0 — factored out of the trade-group loop so the same card can also
  // render inside the pinned "Frequently Selected" shortlist without
  // duplicating markup or risking the two views drifting out of sync (both
  // read/write the same `checked` state by key, so toggling either copy
  // toggles the one underlying selection).
  const renderInHouseCard = (it: RepairItem) => {
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
  };

  const renderVendorCard = (it: RepairItem) => {
    const st = checked[it.key];
    // v20.32.17 — Vendor Quote Upload: live client price = vendor's raw
    // quoted amount + admin-set markup. Mirrors the exact same formula the
    // server persists on save (server/repairConsult.ts computeLineTotal
    // path for category === "vendor").
    const quoteAmt = Number(st?.vendorQuoteAmount) || 0;
    const clientPrice = quoteAmt > 0 ? quoteAmt * (1 + (vendorQuoteSettings.markupPct || 0)) : 0;
    return (
      <div key={it.key} style={cardStyle}>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={!!st?.checked} onChange={e => setItemState(it.key, { checked: e.target.checked })} style={{ marginTop: 3, width: 18, height: 18, accentColor: "rgba(255,255,255,0.6)" }} />
          <p style={{ fontSize: 13.5, color: "#fff", fontWeight: 600, margin: 0 }}>{TRADE_LABELS[it.trade] || it.name}</p>
        </label>
        {st?.checked && (
          <div style={{ marginTop: 10, paddingLeft: 28 }}>
            <input placeholder="Notes for the vendor (scope, measurements, etc.)" value={st.measurementNotes} onChange={e => setItemState(it.key, { measurementNotes: e.target.value })}
              style={{ ...inputStyle, fontSize: 12.5 }} />

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>
              <input type="checkbox" checked={!!st.hasVendorQuote} onChange={e => setItemState(it.key, { hasVendorQuote: e.target.checked })} style={{ accentColor: GOLD }} />
              Already have a vendor quote?
            </label>

            {st.hasVendorQuote && (
              <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: "rgba(200,170,90,0.06)", border: "1px solid rgba(200,170,90,0.2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>$</span>
                  <input type="number" min={0} step="any" placeholder="Vendor's quoted amount" value={st.vendorQuoteAmount}
                    onChange={e => setItemState(it.key, { vendorQuoteAmount: e.target.value })}
                    style={{ ...inputStyle, fontSize: 12.5, width: 150 }} />
                </div>
                {clientPrice > 0 && (
                  <p style={{ fontSize: 12, color: "#7ed49a", fontWeight: 700, margin: "8px 0 0" }}>
                    Client price: ${clientPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    <span style={{ color: "rgba(255,255,255,0.4)", fontWeight: 400 }}> (+{Math.round((vendorQuoteSettings.markupPct || 0) * 100)}% our fee)</span>
                  </p>
                )}

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, padding: "6px 10px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)", fontSize: 11.5, cursor: "pointer" }}>
                  {uploadingVendorQuoteKey === it.key ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
                  {uploadingVendorQuoteKey === it.key ? "Uploading\u2026" : "Attach vendor quote photo"}
                  <input type="file" accept="image/*" style={{ display: "none" }} disabled={uploadingVendorQuoteKey === it.key}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleVendorQuotePhotoUpload(it.key, f); e.target.value = ""; }} />
                </label>

                {(st.photos || []).length > 0 && (
                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    {st.photos.map((url, i) => (
                      <div key={i} style={{ position: "relative" }}>
                        <img src={url} style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover", display: "block" }} />
                        <button onClick={() => setItemState(it.key, { photos: st.photos.filter((_, idx) => idx !== i) })}
                          style={{ position: "absolute", top: -5, right: -5, width: 16, height: 16, borderRadius: 8, background: "#ff5a5a", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                          <X size={9} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // v20.16.0 — same ref-based fix as ListingConsultSheet: gate on a ref
  // (updates in place, visible to every closure) instead of the `consultId`
  // state variable (frozen per-render), and collapse concurrent calls into
  // one in-flight promise. Defensive here since no call site currently
  // chains ensureConsult()+another ensureConsult()-calling function the way
  // ListingConsultSheet's handlePrepNext did, but this closes the same class
  // of bug against a fast double-tap and any future call site.
  const consultIdRef = useRef<number | null>(null);
  const creatingPromiseRef = useRef<Promise<number> | null>(null);
  const ensureConsult = async (): Promise<number> => {
    if (consultIdRef.current) return consultIdRef.current;
    if (creatingPromiseRef.current) return creatingPromiseRef.current;
    const p = (async () => {
      setCreating(true);
      try {
        const d = await fetchJson("/api/repair-consult", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId, agentId, clientName, clientEmail, clientPhone, propertyAddress: effectiveAddress, heroPhotoUrl: prefillHeroPhotoUrl || null }),
        });
        consultIdRef.current = d.id;
        setConsultId(d.id);
        return d.id as number;
      } finally { setCreating(false); creatingPromiseRef.current = null; }
    })();
    creatingPromiseRef.current = p;
    return p;
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
      consultIdRef.current = d.id;
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
            hasVendorQuote: it.vendor_quote_amount != null,
            vendorQuoteAmount: it.vendor_quote_amount != null ? String(it.vendor_quote_amount) : "",
          };
        }
        setChecked(nextChecked);
      }

      if (d.subtotal || d.total) setTotals({ subtotal: d.subtotal || 0, total: d.total || 0, vendorQuotedSubtotal: d.vendor_quoted_subtotal || 0 });

      if (d.quote_token) {
        // v20.30.0 — Quote already generated — jump to Review with the
        // send/dispatch actions AND the view-anytime PDF links available.
        // quotePdfUrl now points at the regenerate-on-view endpoint (no
        // approval gate) since acceptUrl isn't needed just to view/resume.
        setQuoteResult({ pdfUrl: `/api/repair-consult/${d.id}/quote-pdf`, agreementPdfUrl: d.agreementPdfUrl || "", acceptUrl: "", total: d.total || 0 });
        if (d.status === "sent") setClientSent(true);
        setReviewConfirmed(true); // already quoted in an earlier session — don't re-ask for the close
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
    if (!effectiveAddress.trim()) { setError("Property address is required."); return; }
    setError("");
    try { await ensureConsult(); setStep("checklist"); }
    catch (e: any) { setError(e.message || "Failed to start consult."); }
  };

  const handlePhotoPick = async (file: File, kind: "hero" | "gallery") => {
    // v20.28.0 — ensureConsult() moved INSIDE the try block, same fix as
    // ListingConsultSheet. Previously a failed ensureConsult() (expired
    // session, network hiccup) threw before setBusy(true)/try ever ran —
    // silent no-op, no spinner, no error, matching the "nothing happens even
    // if I wait" report.
    const setBusy = kind === "hero" ? setUploadingHero : setUploadingGallery;
    setBusy(true);
    try {
      const id = await ensureConsult();
      const conv = await fileToImageData(file);
      if (!conv) { setError("Couldn't read that photo. Try another."); return; }
      const d = await fetchJson(`/api/repair-consult/${id}/photo`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: conv.imageData, mimeType: conv.mimeType, kind, tag: kind === "gallery" ? galleryTagMode : undefined }),
      });
      if (kind === "hero") setHeroPhotoUrl(d.url);
      else setGalleryUrls(prev => [...prev, { url: d.url, tag: galleryTagMode }]);
    } catch (e: any) { setError(e.message || "Photo upload failed. Check your connection and try again."); }
    finally { setBusy(false); }
  };

  // v20.32.17 — Vendor Quote Upload: attach a photo of the raw vendor quote
  // (text message screenshot, emailed PDF-as-photo, etc.) to a checked
  // vendor item. Reuses the same photo pipeline as handlePhotoPick but posts
  // kind: "vendor_quote" (server just writes the file + returns a URL for
  // that kind — no side effects on hero/gallery state) and appends the URL
  // into that item's own photos array instead of global hero/gallery state.
  const [uploadingVendorQuoteKey, setUploadingVendorQuoteKey] = useState<string | null>(null);
  const handleVendorQuotePhotoUpload = async (itemKey: string, file: File) => {
    setUploadingVendorQuoteKey(itemKey);
    try {
      const id = await ensureConsult();
      const conv = await fileToImageData(file);
      if (!conv) { setError("Couldn't read that photo. Try another."); return; }
      const d = await fetchJson(`/api/repair-consult/${id}/photo`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: conv.imageData, mimeType: conv.mimeType, kind: "vendor_quote" }),
      });
      setItemState(itemKey, { photos: [...(checked[itemKey]?.photos || []), d.url] });
    } catch (e: any) { setError(e.message || "Vendor quote photo upload failed. Check your connection and try again."); }
    finally { setUploadingVendorQuoteKey(null); }
  };

  // Bulk end-of-walkthrough upload — agent shoots photos with the phone's own
  // camera throughout the walkthrough, then picks them all at once here from
  // their photo library. Uploaded one at a time (each already downscaled by
  // fileToImageData) so a single oversized file can't block the rest.
  const handleBulkGalleryUpload = async (files: FileList) => {
    // v20.28.0 — same ensureConsult()-outside-try fix as handlePhotoPick.
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;
    const tag = galleryTagMode;
    setUploadingGallery(true);
    setGalleryProgress({ done: 0, total: fileArr.length });
    try {
      const id = await ensureConsult();
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
    } catch (e: any) {
      setError(e.message || "Couldn't start the upload — check your connection and try again.");
    } finally {
      setUploadingGallery(false);
      setGalleryProgress(null);
    }
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
  // v20.25.0 — shared item-persistence call. Used both by the Checklist
  // step's "Continue to Photos" and by THE CLOSE confirm button on Review,
  // since adjusting items live with the client only changes local `checked`
  // state until this actually POSTs it to the server.
  const submitCurrentItems = async () => {
    const id = await ensureConsult();
    const items = Object.entries(checked)
      .filter(([, v]) => v.checked)
      .map(([itemKey, v]) => ({
        itemKey, quantity: Number(v.quantity) || 1, twoStory: v.twoStory,
        photos: v.photos, measurementNotes: v.measurementNotes || undefined,
        vendorQuoteAmount: v.hasVendorQuote && Number(v.vendorQuoteAmount) > 0 ? Number(v.vendorQuoteAmount) : undefined,
      }));
    if (items.length === 0) throw new Error("Check off at least one repair item before continuing.");
    const d = await fetchJson(`/api/repair-consult/${id}/items`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
    });
    setTotals({ subtotal: d.subtotal, total: d.total, discountAmount: d.discountAmount, freeItemKey: d.freeItemKey, vendorQuotedSubtotal: d.vendorQuotedSubtotal });
    return d;
  };

  const handleChecklistNext = async () => {
    setSubmittingItems(true);
    setError("");
    try {
      await submitCurrentItems();
      // v20.19.0 — Listing Consult already collected walkthrough photos for
      // this same visit; if that hand-off carried photos over, don't make the
      // agent shoot/pick the same set again. Straight to Review. Standalone
      // consults (or a nested one where Listing Consult had no photos yet)
      // still get the normal Gallery step.
      if (nestedFromListing && galleryUrls.length > 0) {
        setGallerySkipped(true);
        setStep("review");
      } else {
        setStep("gallery");
      }
    } catch (e: any) { setError(e.message || "Failed to save checklist."); }
    finally { setSubmittingItems(false); }
  };

  // v20.25.0 — THE CLOSE: agent taps this after reviewing add/remove changes
  // with the client on the phone. Persists whatever `checked` looks like
  // right now, THEN flips reviewConfirmed so the existing auto-generate /
  // vendor-dispatch effect can fire against the final, client-approved scope.
  const handleConfirmReview = async () => {
    setSavingReview(true);
    setError("");
    try {
      await submitCurrentItems();
      // v20.30.0 — re-editing after a quote already existed: clear the stale
      // quote/vendor-dispatch results so the auto-generate effect below fires
      // again against the just-saved scope. The server already clears office
      // approval on every fresh generate-quote call, so re-approval is always
      // required after an edit — nothing can slip out to the client stale.
      if (quoteResult) { setQuoteResult(null); setClientSent(false); }
      if (vendorDispatchResult) setVendorDispatchResult(null);
      setEditingScope(false);
      setReviewConfirmed(true);
    } catch (e: any) { setError(e.message || "Failed to save the reviewed items."); }
    finally { setSavingReview(false); }
  };

  const handleGenerateQuote = async () => {
    if (!consultId) return;
    setGeneratingQuote(true); setError("");
    try {
      const d = await fetchJson(`/api/repair-consult/${consultId}/generate-quote`, { method: "POST" });
      // v20.30.0 — link through the view-anytime endpoint (no approval gate,
      // always regenerates fresh) instead of the one-time static file path,
      // so this link keeps working even after the sheet is closed/reopened.
      setQuoteResult({ pdfUrl: `/api/repair-consult/${consultId}/quote-pdf`, agreementPdfUrl: d.agreementPdfUrl, acceptUrl: d.acceptUrl, total: d.total });
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

  // v20.19.0 — auto-fire both the in-house quote generation AND the vendor
  // dispatch the instant Review is reached, instead of making the agent tap
  // two separate buttons. This does NOT touch the Office Approval Gate —
  // generating the quote PDF and requesting vendor bids never emails the
  // client; only the separate "Send Branded Quote to Client" button (still
  // manual, still gated on admin approval) does that.
  useEffect(() => {
    if (step !== "review" || !consultId || !reviewConfirmed) return;
    if (hasInHouseSelections && !quoteResult && !generatingQuote) handleGenerateQuote();
    if (hasVendorSelections && !vendorDispatchResult && !dispatchingVendors) handleDispatchVendors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, consultId, reviewConfirmed]);

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

  // v20.26.0 — when opened as a hard transition from Listing Consult (after
  // the contract sends and repairs were flagged), this renders as its own
  // full page, not a stacked bottom-sheet overlay on top of Lock It In.
  // Listing Consult stays mounted underneath for state, but visually this
  // should read as "we left that screen and are now on the Repair Consult
  // page," not "a drawer popped up over what we were just looking at."
  return (
    <div style={nestedFromListing
      ? { position: "fixed", inset: 0, zIndex: 200, display: "flex", flexDirection: "column", background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)" }
      : { position: "fixed", inset: 0, zIndex: 200, display: "flex", flexDirection: "column", justifyContent: "flex-end" }
    }>
      {!nestedFromListing && (
        <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }} />
      )}
      <div style={nestedFromListing ? {
        position: "relative", zIndex: 1, flex: 1,
        background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
        padding: "24px 20px 40px", height: "100dvh", overflowY: "auto", boxSizing: "border-box",
      } : {
        position: "relative", zIndex: 1,
        background: "linear-gradient(180deg,#141414 0%,#0c0c0c 100%)",
        border: `1px solid rgba(200,170,90,0.3)`, borderBottom: "none",
        borderRadius: "20px 20px 0 0", padding: "24px 20px 40px",
        maxHeight: "94dvh", overflowY: "auto",
      }}>
        {nestedFromListing ? (
          <div style={{
            display: "flex", alignItems: "center", gap: 6, marginBottom: 4,
            fontSize: 11, fontWeight: 700, color: GOLD, textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            <ChevronLeft size={14} />
            <span style={{ cursor: "pointer" }} onClick={onClose}>Back to Lock It In</span>
          </div>
        ) : (
          <button type="button" onClick={onClose} aria-label="Close" style={{
            position: "absolute", top: 12, right: 12, width: 38, height: 38, borderRadius: 19,
            background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
            color: "rgba(255,255,255,0.75)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
          }}><X size={18} /></button>
        )}

        {error && (
          <div style={{ padding: 10, marginBottom: 14, borderRadius: 8, background: "rgba(255,120,120,0.1)", color: "#ffb0b0", fontSize: 12.5 }}>
            {error}
          </div>
        )}

        {resumePhase === "checking" && <ResumeCheckingSpinner />}

        {resumePhase === "picking" && (
          <ConsultResumePicker
            title="Instant Repair Quote"
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
            {header("Instant Repair Quote", "Property + client info, front of house photo")}
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
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                        {dealSide === "buyer"
                          ? (c.address ? `Current address on file: ${c.address} (not what they're buying)` : "No address on file")
                          : ((c.addresses?.length || 0) > 1 ? `${c.addresses!.length} properties on file — pick one next` : (c.address || "No address on file"))}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.35)", marginTop: -2, marginBottom: 14 }}>
              {dealSide === "buyer"
                ? "Start here — selecting a match autofills name, phone, and email. This is a buyer, so type the NEW property they're inspecting/repairing below \u2014 their FUB address is just their current home."
                : "Start here — selecting a match autofills name, phone, email, and their current home address below."}
            </p>
            {fubAddressChoices.length > 0 && (
              <FubAddressChooser
                clientName={clientName || "This client"}
                addresses={fubAddressChoices}
                onPick={(addr) => { setPropertyAddress(addr); setFubAddressChoices([]); }}
                onManual={() => setFubAddressChoices([])}
              />
            )}
            <label style={labelStyle}>Property Address{dealSide === "buyer" ? " (the property they're buying)" : ""}</label>
            <input style={{ ...inputStyle, marginBottom: 4 }} value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} placeholder="123 Main St, Fernandina Beach, FL" />
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 0, marginBottom: 14 }}>
              {dealSide === "buyer"
                ? "This is the NEW property they're purchasing — not their current home. It won't be on file in FUB yet; type it in (or a placeholder like \"0 Charles Ave\" for vacant land — use the Parcel # field below)."
                : "Not in FUB yet, or a vacant lot with no mailing address? Type the property address (or a placeholder like \"0 Charles Ave\") here manually — use the Parcel # field below for vacant land."}
            </p>
            {dealSide !== "buyer" && (
              <>
                <label style={labelStyle}>Subject Address (if different)</label>
                <input
                  style={{ ...inputStyle, marginBottom: 4 }}
                  value={subjectAddressOverride}
                  onChange={e => setSubjectAddressOverride(e.target.value)}
                  placeholder="Leave blank to use the address above"
                />
                <p style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 0, marginBottom: 14 }}>
                  If this seller owns another property and this order is actually about a different one, type it here — it'll be used instead of the address above. Leave blank if the address above is correct.
                </p>
              </>
            )}
            <SmartDataPanel propertyAddress={effectiveAddress} />
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
            {navButtons({ onNext: handleInfoNext, nextBusy: creating, nextDisabled: !effectiveAddress.trim() })}
          </>
        )}

        {step === "checklist" && (
          <>
            {header("Repair Checklist", `${selectedCount} item${selectedCount === 1 ? "" : "s"} selected`)}
            {prefillFlaggedPillars && prefillFlaggedPillars.length > 0 && (
              <div style={{ marginBottom: 16, background: "rgba(200,170,90,0.08)", border: `1px solid rgba(200,170,90,0.3)`, borderRadius: 12, padding: 12 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 8px" }}>
                  Flagged During Walkthrough
                </p>
                {prefillFlaggedPillars.map(p => (
                  <div key={p.key} style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                    <span style={{ fontWeight: 700 }}>{p.label}</span>
                    {p.tier && <span style={{ marginLeft: 6, textTransform: "uppercase", fontSize: 10, color: "rgba(255,255,255,0.5)" }}>{p.tier}</span>}
                    {p.details && p.details.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                        {p.details.map(d => (
                          <span key={d} style={{
                            fontSize: 9.5, fontWeight: 600, color: GOLD, background: "rgba(200,170,90,0.14)",
                            border: "1px solid rgba(200,170,90,0.3)", borderRadius: 5, padding: "2px 6px",
                          }}>{d.replace(/_/g, " ")}</span>
                        ))}
                      </div>
                    )}
                    {p.notes && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 1 }}>{p.notes}</div>}
                  </div>
                ))}
                <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", margin: "8px 0 0" }}>
                  {prefillFlaggedPillars.some(p => p.key !== "flooring")
                    ? "Matching items below are already checked with default quantities — adjust them to the actual scope you're seeing now."
                    : "Guidance only — check the matching items below at the actual scope you're seeing now."}
                </p>
              </div>
            )}
            {catalogLoading ? (
              <div style={{ padding: 30, textAlign: "center" }}><Loader2 size={20} className="animate-spin" style={{ color: GOLD }} /></div>
            ) : (
              <>
                {packages.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 6px" }}>Packages — Bundle & Save</p>
                    <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", margin: "0 0 10px" }}>Pick a bundle to auto-check its items and apply the discount below. Tap again to clear.</p>
                    {TIER_ORDER.map(tier => {
                      const tierPkgs = packages.filter(p => p.tier === tier);
                      if (tierPkgs.length === 0) return null;
                      return (
                        <div key={tier} style={{ marginBottom: 10 }}>
                          <p style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(255,255,255,0.35)", letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 6px" }}>{TIER_LABELS[tier]}</p>
                          {tierPkgs.map(pkg => {
                            const isSelected = selectedPackageKey === pkg.key;
                            return (
                              <button key={pkg.key} type="button" disabled={applyingPackage}
                                onClick={() => handleSelectPackage(isSelected ? null : pkg)}
                                style={{
                                  display: "block", width: "100%", textAlign: "left", cursor: applyingPackage ? "default" : "pointer",
                                  background: isSelected ? "rgba(200,170,90,0.14)" : "rgba(255,255,255,0.03)",
                                  border: isSelected ? `1px solid ${GOLD}` : "1px solid rgba(255,255,255,0.08)",
                                  borderRadius: 10, padding: 12, marginBottom: 8,
                                }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{pkg.name}</span>
                                  <span style={{ fontSize: 11.5, fontWeight: 800, color: isSelected ? GOLD : "rgba(255,255,255,0.5)" }}>{Math.round(pkg.discountPct * 100)}% off</span>
                                </div>
                                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", margin: "3px 0 0" }}>{pkg.description}</p>
                                {isSelected && <p style={{ fontSize: 10.5, color: GOLD, margin: "6px 0 0", fontWeight: 600 }}>✓ Applied — items checked below</p>}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}

                {frequentItems.length > 0 && (
                  <div style={{ marginBottom: 16, background: "rgba(200,170,90,0.06)", border: `1px solid rgba(200,170,90,0.25)`, borderRadius: 12, padding: 12 }}>
                    <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 8px" }}>
                      <Star size={12} style={{ fill: GOLD }} /> Frequently Selected
                    </p>
                    <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", margin: "-4px 0 8px" }}>Based on what's actually been picked on past consults — not a guess.</p>
                    {frequentItems.map(it => it.category === "in_house" ? renderInHouseCard(it) : renderVendorCard(it))}
                  </div>
                )}

                <p style={{ fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", margin: "4px 0 10px" }}>In-House (Instant Quote)</p>
                {groupedByTrade(inHouseItems).map(([trade, items]) => (
                  <div key={trade} style={{ marginBottom: 8 }}>
                    {tradeHeaderRow(trade, items)}
                    {isTradeExpanded(trade) && items.map(renderInHouseCard)}
                  </div>
                ))}

                <p style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase", margin: "16px 0 10px" }}>Needs a Licensed Vendor</p>
                {groupedByTrade(vendorItems).map(([trade, items]) => (
                  <div key={trade} style={{ marginBottom: 8 }}>
                    {tradeHeaderRow(trade, items)}
                    {isTradeExpanded(trade) && items.map(renderVendorCard)}
                  </div>
                ))}
              </>
            )}
            {(liveTotals.subtotal > 0 || liveTotals.vendorQuotedSubtotal > 0) && (
              <div style={{
                position: "sticky", bottom: 8, zIndex: 5, marginTop: 12, marginBottom: 4,
                background: "rgba(20,18,14,0.97)", border: `1px solid rgba(200,170,90,0.4)`, borderRadius: 12,
                padding: "10px 14px", boxShadow: "0 6px 20px rgba(0,0,0,0.5)", backdropFilter: "blur(6px)",
              }}>
                {liveTotals.subtotal > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontWeight: 600 }}>
                      In-House Subtotal{!!liveTotals.discountAmount && ` \u2212 $${liveTotals.discountAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} discount`}
                    </span>
                    <span style={{ fontSize: 17, fontWeight: 800, color: GOLD }}>
                      ${liveTotals.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
                {liveTotals.vendorQuotedSubtotal > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: liveTotals.subtotal > 0 ? 6 : 0 }}>
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontWeight: 600 }}>
                      Vendor-Coordinated
                    </span>
                    <span style={{ fontSize: 17, fontWeight: 800, color: "#7ed49a" }}>
                      ${liveTotals.vendorQuotedSubtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
                {liveTotals.subtotal > 0 && liveTotals.vendorQuotedSubtotal > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
                    <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>Grand Total</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>
                      ${(liveTotals.total + liveTotals.vendorQuotedSubtotal).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
                {liveTotals.threshold !== null && (

                  <p style={{ fontSize: 10.5, margin: "4px 0 0", color: liveTotals.freeItemHit ? "#7ed49a" : "rgba(255,255,255,0.4)", fontWeight: liveTotals.freeItemHit ? 700 : 500 }}>
                    {liveTotals.freeItemHit
                      ? `\u2713 ${incentiveSettings.label || "Sign-today incentive"} unlocked`
                      : `$${liveTotals.remainingToFreeItem.toLocaleString(undefined, { minimumFractionDigits: 2 })} more to unlock: ${incentiveSettings.label || "sign-today incentive"}`}
                  </p>
                )}
                {prefillFlaggedPillars && prefillFlaggedPillars.length > 0 && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.55)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700, marginBottom: 4 }}>
                      <span>Lean</span>
                      <span style={{ color: GOLD }}>
                        {SCOPE_SHIFT_LABELS[scopeShift as keyof typeof SCOPE_SHIFT_LABELS] || "As Flagged"}
                      </span>
                      <span>Max Scope</span>
                    </div>
                    <input
                      type="range" min={-2} max={2} step={1} value={scopeShift}
                      onChange={e => setScopeShift(Number(e.target.value))}
                      style={{ width: "100%", accentColor: GOLD, cursor: "pointer" }}
                    />
                    <p style={{ fontSize: 9.5, margin: "4px 0 0", color: "rgba(255,255,255,0.4)", lineHeight: 1.4 }}>
                      Drag to adjust the scope on flagged items {"\u2014"} the total updates live. Manually checked items are never affected.
                    </p>
                  </div>
                )}
              </div>
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
            {header("Review & Send", effectiveAddress)}
            {gallerySkipped && (
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: -4, marginBottom: 12 }}>
                Reused the walkthrough photos already captured during Listing Consult — no need to shoot them twice.
              </p>
            )}
            {reviewConfirmed && !editingScope && (
              <button
                onClick={() => setEditingScope(true)}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.75)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              >
                <Pencil size={13} /> Edit Scope / Items
              </button>
            )}

            {(!reviewConfirmed || editingScope) && (
              <div style={{ ...cardStyle, background: "rgba(90,150,220,0.07)", border: "1px solid rgba(90,150,220,0.3)", marginBottom: 14 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: "#8ab4e8", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>Review With Client</p>
                <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)", marginBottom: 12 }}>
                  Walk through it together — tap the ✕ to drop anything they'll handle themselves, or add something before you lock it in.
                </p>
                {(() => {
                  const checkedKeys = Object.entries(checked).filter(([, v]) => v.checked).map(([k]) => k);
                  const checkedItems = checkedKeys
                    .map(k => catalog.find(i => i.key === k))
                    .filter((i): i is RepairItem => !!i)
                    .sort((a, b) => a.sequence_order - b.sequence_order);
                  const uncheckedItems = catalog
                    .filter(i => !checked[i.key]?.checked)
                    .filter(i => !addItemQuery.trim() || i.name.toLowerCase().includes(addItemQuery.trim().toLowerCase()))
                    .sort((a, b) => a.sequence_order - b.sequence_order);
                  return (
                    <>
                      {checkedItems.length === 0 ? (
                        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 12 }}>Nothing selected yet.</p>
                      ) : (
                        <div style={{ marginBottom: 12 }}>
                          {checkedItems.map(item => {
                            const st = checked[item.key];
                            const isEditing = editingReviewItem === item.key;
                            return (
                              <div key={item.key} style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0" }}>
                                  <div
                                    style={{ minWidth: 0, flex: 1, cursor: "pointer" }}
                                    onClick={() => setEditingReviewItem(isEditing ? null : item.key)}
                                  >
                                    <span style={{ fontSize: 13, color: "#fff", fontWeight: 600 }}>{item.name}</span>
                                    {item.category === "vendor" && (
                                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginLeft: 6 }}>({TRADE_LABELS[item.trade] || item.trade} — vendor)</span>
                                    )}
                                    {item.unit !== "flat" && Number(st?.quantity) > 1 && (
                                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginLeft: 6 }}>× {st?.quantity}</span>
                                    )}
                                    {st?.twoStory && !!item.two_story_eligible && (
                                      <span style={{ fontSize: 10, color: GOLD, marginLeft: 6 }}>2-story</span>
                                    )}
                                  </div>
                                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                                    <button
                                      onClick={() => setEditingReviewItem(isEditing ? null : item.key)}
                                      aria-label={`Edit ${item.name}`}
                                      style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${isEditing ? GOLD : "rgba(255,255,255,0.2)"}`, background: isEditing ? "rgba(200,170,90,0.15)" : "rgba(255,255,255,0.06)", color: isEditing ? GOLD : "rgba(255,255,255,0.6)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                                    >
                                      <Pencil size={13} />
                                    </button>
                                    <button
                                      onClick={() => { setItemState(item.key, { checked: false }); if (isEditing) setEditingReviewItem(null); }}
                                      aria-label={`Remove ${item.name}`}
                                      style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid rgba(255,90,90,0.35)", background: "rgba(255,90,90,0.1)", color: "#ff7a7a", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                                    >
                                      <X size={14} />
                                    </button>
                                  </div>
                                </div>
                                {isEditing && (
                                  <div style={{ padding: "0 0 12px" }}>
                                    {item.unit !== "flat" && (
                                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                                        <input type="number" min={0} step="any" value={st?.quantity ?? "1"} onChange={e => setItemState(item.key, { quantity: e.target.value })}
                                          style={{ ...inputStyle, width: 90 }} />
                                        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>{item.unit === "each" ? "count" : item.unit.replace("_", " ")}</span>
                                      </div>
                                    )}
                                    {!!item.two_story_eligible && (
                                      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
                                        <input type="checkbox" checked={!!st?.twoStory} onChange={e => setItemState(item.key, { twoStory: e.target.checked })} style={{ accentColor: GOLD }} />
                                        Two-story (+25% surcharge)
                                      </label>
                                    )}
                                    <input placeholder="Measurement notes (optional)" value={st?.measurementNotes ?? ""} onChange={e => setItemState(item.key, { measurementNotes: e.target.value })}
                                      style={{ ...inputStyle, fontSize: 12.5 }} />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <input
                        value={addItemQuery}
                        onChange={e => setAddItemQuery(e.target.value)}
                        placeholder="+ Add an item — type to search…"
                        style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.05)", color: "#fff", fontSize: 12.5, marginBottom: addItemQuery.trim() ? 6 : 0 }}
                      />
                      {addItemQuery.trim() && (
                        <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}>
                          {uncheckedItems.length === 0 ? (
                            <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)", padding: 10 }}>No matching items.</p>
                          ) : uncheckedItems.slice(0, 12).map(item => (
                            <button
                              key={item.key}
                              onClick={() => { setItemState(item.key, { checked: true, quantity: item.unit === "flat" ? "1" : (checked[item.key]?.quantity || "1") }); setAddItemQuery(""); }}
                              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 10px", background: "transparent", border: "none", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#fff", fontSize: 12.5, cursor: "pointer", textAlign: "left" }}
                            >
                              <span>{item.name}{item.category === "vendor" ? ` (${TRADE_LABELS[item.trade] || item.trade})` : ""}</span>
                              <Plus size={14} style={{ color: GOLD, flexShrink: 0 }} />
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
                <button
                  onClick={handleConfirmReview}
                  disabled={savingReview}
                  style={{ width: "100%", marginTop: 14, padding: "12px 18px", borderRadius: 10, background: GOLD, border: "none", color: "#0c0b0a", fontSize: 13.5, fontWeight: 700, cursor: savingReview ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                >
                  {savingReview ? <Loader2 size={15} className="animate-spin" /> : null}
                  {savingReview ? "Saving…" : editingScope ? "Save Changes — Regenerate Quote" : "Looks Good — Generate Quote"}
                </button>
              </div>
            )}

            {(liveTotals.subtotal > 0 || liveTotals.vendorQuotedSubtotal > 0) && (
              <div style={{ ...cardStyle, background: "rgba(200,170,90,0.06)", border: "1px solid rgba(200,170,90,0.25)" }}>
                {liveTotals.subtotal > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)" }}>In-House Subtotal</span>
                    <span style={{ fontSize: 12.5, color: "#fff" }}>${liveTotals.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                {!!liveTotals.discountAmount && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 12.5, color: "#7ed49a" }}>Package Discount{selectedPackageKey ? ` (${packages.find(p => p.key === selectedPackageKey)?.name || selectedPackageKey})` : ""}</span>
                    <span style={{ fontSize: 12.5, color: "#7ed49a" }}>−${liveTotals.discountAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                {liveTotals.subtotal > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Total</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: GOLD }}>${liveTotals.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                {liveTotals.vendorQuotedSubtotal > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: liveTotals.subtotal > 0 ? 10 : 0, paddingTop: liveTotals.subtotal > 0 ? 10 : 0, borderTop: liveTotals.subtotal > 0 ? "1px solid rgba(255,255,255,0.15)" : "none" }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#7ed49a" }}>Vendor-Coordinated</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#7ed49a" }}>${liveTotals.vendorQuotedSubtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                {liveTotals.subtotal > 0 && liveTotals.vendorQuotedSubtotal > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Grand Total</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>${(liveTotals.total + liveTotals.vendorQuotedSubtotal).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                {liveTotals.freeItemHit && incentiveSettings.freeItemKey && (
                  <p style={{ fontSize: 11.5, color: GOLD, marginTop: 8, fontWeight: 600 }}>
                    ✓ Free: {catalog.find(i => i.key === incentiveSettings.freeItemKey)?.name || incentiveSettings.freeItemKey} (sign-today incentive)
                  </p>
                )}
                {liveTotals.total > 0 && (
                  <div style={{ marginTop: 12, background: "#0a0a0a", borderRadius: 8, padding: "12px 14px", display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ textAlign: "center", flex: 1 }}>
                      <div style={{ fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>50% To Start</div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: "#fff", marginTop: 2 }}>${(liveTotals.total / 2).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                    </div>
                    <div style={{ width: 1, background: "rgba(255,255,255,0.15)" }} />
                    <div style={{ textAlign: "center", flex: 1 }}>
                      <div style={{ fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>50% On Completion</div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: "#fff", marginTop: 2 }}>${(liveTotals.total / 2).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {reviewConfirmed && hasInHouseSelections && (
              <div style={{ marginBottom: 14 }}>
                {!quoteResult ? (
                  <div style={{ padding: 12, borderRadius: 10, background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)", fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
                    <Loader2 size={15} className="animate-spin" style={{ color: GOLD }} /> Generating in-house quote…
                  </div>
                ) : (
                  <>
                    <div style={{ padding: 12, borderRadius: 10, background: "rgba(126,212,154,0.1)", color: "#7ed49a", fontSize: 12.5, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                      <CheckCircle2 size={16} /> Quote generated — sent to Alex & Nate for review.
                    </div>
                    {(quoteResult.agreementPdfUrl || quoteResult.pdfUrl) && (
                      <button
                        onClick={() => setPdfModal({ url: quoteResult.agreementPdfUrl || quoteResult.pdfUrl, title: `${effectiveAddress} — Quote` })}
                        style={{ display: "block", width: "100%", textAlign: "center", padding: "10px 14px", borderRadius: 8, border: `1px solid ${GOLD}`, background: "transparent", color: GOLD, fontSize: 12.5, fontWeight: 700, marginBottom: 10, cursor: "pointer" }}
                      >
                        View Quote
                      </button>
                    )}
                    {!clientSent && (
                      <button type="button" onClick={() => setShowClientPreview(true)} style={{
                        width: "100%", padding: "11px 14px", borderRadius: 10, marginBottom: 8,
                        background: "transparent", border: `1px solid ${GOLD}`, color: GOLD, fontSize: 12.5, fontWeight: 700,
                        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                      }}>
                        <Eye size={14} /> Preview Before Sending
                      </button>
                    )}
                    {clientEmail ? (
                      <button onClick={handleSendToClient} disabled={sendingToClient || clientSent} style={{
                        width: "100%", padding: "12px 18px", borderRadius: 10, background: clientSent ? "rgba(126,212,154,0.15)" : GOLD,
                        border: "none", color: clientSent ? "#7ed49a" : "#0c0b0a", fontSize: 13.5, fontWeight: 700,
                        cursor: clientSent ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 8,
                      }}>
                        {sendingToClient ? <Loader2 size={15} className="animate-spin" /> : clientSent ? <CheckCircle2 size={15} /> : null}
                        {clientSent ? "Sent to Client" : "Send for Signature"}
                      </button>
                    ) : (
                      <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)" }}>No client email on file — quote is with Alex/Nate to send manually or you can go back and add one.</p>
                    )}
                  </>
                )}
              </div>
            )}

            {reviewConfirmed && hasVendorSelections && (
              <div style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Vendor Quote Requests</p>
                {!vendorDispatchResult ? (
                  <div style={{ padding: 12, borderRadius: 10, background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)", fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
                    <Loader2 size={15} className="animate-spin" style={{ color: GOLD }} /> Sending vendor quote requests…
                  </div>
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
      {pdfModal && (
        <PdfViewerModal url={pdfModal.url} title={pdfModal.title} onClose={() => setPdfModal(null)} />
      )}
      {showClientPreview && consultId && (
        <ClientPreviewModal
          kind="repair"
          id={consultId}
          title={`Preview — ${effectiveAddress || "Repair Quote"}`}
          onClose={() => setShowClientPreview(false)}
        />
      )}
    </div>
  );
}
