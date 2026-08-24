// v20.32.13 — "Inspections+" buyer tool. Lives inside the new "Place an Offer"
// bottom-nav chooser (BuyerChooserSheet), alongside "Write an Offer". Picks
// the client from FUB, checks off which inspections to order, sets the
// needed-by timing and inspection contingency expiration date, and sends the
// client a branded order summary email with a single-stage typed-name e-sign
// link. Mirrors WriteOfferSheet's dark/gold modal styling and FUB search
// pattern exactly.
import { useState, useEffect } from "react";
import { CheckCircle2, X, Loader2, ClipboardCheck } from "lucide-react";
import { FubAddressChooser, type FubAddress } from "./FubAddressChooser";

const fetchJson = async (url: string, opts: RequestInit = {}) => {
  const r = await fetch(url, { credentials: "include", ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
};

const GOLD = "#c8aa5a";
const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12, padding: 14, marginBottom: 14,
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
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: "0.06em", textTransform: "uppercase",
  marginBottom: 10, marginTop: 4,
};

type FubContact = { id: number; name: string; email: string | null; phone: string | null; address: string | null; addresses?: FubAddress[] };
type CatalogItem = { key: string; name: string; clientPrice: number; sequenceOrder: number };
type InspectionVendor = { id: number; name: string; phone: string | null; email: string | null };
type PricePreviewItem = { key: string; name: string; clientPrice: number; vendorCost: number | null; source: "vendor_tier" | "flat_catalog" };

export function InspectionsPlusSheet({
  agentId, onClose,
}: {
  agentId?: number;
  onClose: () => void;
}) {
  useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);

  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // ── Step 1: client + property ──
  const [clientQuery, setClientQuery] = useState("");
  const [clientResults, setClientResults] = useState<FubContact[]>([]);
  const [clientSearching, setClientSearching] = useState(false);
  const [pickedContact, setPickedContact] = useState<FubContact | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [propertyAddress, setPropertyAddress] = useState("");

  useEffect(() => {
    if (clientQuery.trim().length < 2) { setClientResults([]); return; }
    const t = setTimeout(async () => {
      setClientSearching(true);
      try {
        const r = await fetch(`/api/fub/contacts/search?q=${encodeURIComponent(clientQuery.trim())}`, { credentials: "include" });
        const d = await r.json().catch(() => ({ results: [] }));
        setClientResults(d.results || []);
      } catch { setClientResults([]); }
      finally { setClientSearching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [clientQuery]);

  // v20.32.14 — hold off autofilling the property address when the picked
  // client has more than one property on file; surface a chooser instead.
  const [fubAddressChoices, setFubAddressChoices] = useState<FubAddress[]>([]);

  const pickContact = (c: FubContact) => {
    setPickedContact(c);
    setClientName(c.name);
    setClientQuery(c.name);
    setClientEmail(c.email || "");
    setClientPhone(c.phone || "");
    const addrs = c.addresses || [];
    if (addrs.length > 1) {
      setFubAddressChoices(addrs);
    } else {
      setFubAddressChoices([]);
      if (c.address) setPropertyAddress(c.address);
    }
    setClientResults([]);
  };

  // ── Step 2: inspections + timing ──
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [neededBy, setNeededBy] = useState<"asap" | "specific">("asap");
  const [neededByDate, setNeededByDate] = useState("");
  const [contingencyDate, setContingencyDate] = useState("");

  // v20.32.13 Part 1 — optional vendor + sqft, resolves sqft-tiered pricing
  // (e.g. Jason Brown's inspection fee ladder) instead of the flat catalog
  // price. Leaving vendor unselected keeps the flat catalog price exactly
  // as before — fully backward compatible.
  const [vendors, setVendors] = useState<InspectionVendor[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<string>("");
  const [subjectSqft, setSubjectSqft] = useState("");
  const [pricePreview, setPricePreview] = useState<Map<string, PricePreviewItem>>(new Map());
  const [smartDataLoading, setSmartDataLoading] = useState(false);
  const [smartDataNote, setSmartDataNote] = useState("");

  useEffect(() => {
    if (step !== 2 || catalog.length > 0) return;
    setCatalogLoading(true);
    Promise.all([
      fetchJson("/api/inspection-items"),
      fetchJson("/api/inspection-vendors").catch(() => ({ vendors: [] })),
    ])
      .then(([itemsRes, vendorsRes]) => { setCatalog(itemsRes.items || []); setVendors(vendorsRes.vendors || []); })
      .catch(() => setError("Couldn't load inspection catalog."))
      .finally(() => setCatalogLoading(false));
  }, [step]);

  // Live tiered-price preview — refetches whenever the vendor, sqft, or the
  // checked items change. Debounced so typing sqft doesn't hammer the API.
  useEffect(() => {
    if (selectedKeys.size === 0) { setPricePreview(new Map()); return; }
    if (!selectedVendorId || !subjectSqft || Number(subjectSqft) <= 0) { setPricePreview(new Map()); return; }
    const t = setTimeout(() => {
      const params = new URLSearchParams({ vendorId: selectedVendorId, sqft: subjectSqft, itemKeys: Array.from(selectedKeys).join(",") });
      fetchJson(`/api/inspection-vendor-pricing/preview?${params.toString()}`)
        .then(d => setPricePreview(new Map((d.items || []).map((i: PricePreviewItem) => [i.key, i]))))
        .catch(() => setPricePreview(new Map()));
    }, 300);
    return () => clearTimeout(t);
  }, [selectedVendorId, subjectSqft, selectedKeys]);

  // v20.32.13 — pull heated sqft from Smart Data for the entered property
  // address instead of requiring the agent to know/type it from memory.
  const autoFillSqftFromSmartData = async () => {
    if (!propertyAddress.trim()) return;
    setSmartDataLoading(true);
    setSmartDataNote("");
    try {
      const r = await fetchJson(`/api/smart-data?propertyAddress=${encodeURIComponent(propertyAddress.trim())}`);
      if (r.heatedSqft) {
        setSubjectSqft(String(r.heatedSqft));
        const sourceLabel = r.source === "county_record" ? "county record" : r.source === "sales_package" ? "sales package" : "manual entry";
        setSmartDataNote(`Filled from Smart Data (${sourceLabel}).`);
      } else {
        setSmartDataNote("No Smart Data on file for this address yet — enter sqft manually.");
      }
    } catch {
      setSmartDataNote("Couldn't reach Smart Data — enter sqft manually.");
    } finally { setSmartDataLoading(false); }
  };

  const toggleKey = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const priceFor = (item: CatalogItem) => pricePreview.get(item.key)?.clientPrice ?? item.clientPrice;
  const total = catalog.filter(c => selectedKeys.has(c.key)).reduce((s, c) => s + priceFor(c), 0);

  const canGoStep2 = clientName.trim().length > 1 && propertyAddress.trim().length > 3;
  const canSend = canGoStep2 && selectedKeys.size > 0 && clientEmail.trim().length > 3
    && (neededBy === "asap" || neededByDate) && contingencyDate;

  const handleSend = async () => {
    if (!canSend) {
      setError(
        !clientEmail.trim()
          ? "This client needs an email on file to receive the order — add one before sending."
          : selectedKeys.size === 0
          ? "Select at least one inspection to order."
          : !contingencyDate
          ? "Enter the inspection contingency expiration date."
          : "Fill in the client, property, and timing details before sending."
      );
      return;
    }
    setError(""); setSending(true);
    try {
      const created = await fetchJson("/api/inspection-orders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          fubContactId: pickedContact?.id ? String(pickedContact.id) : undefined,
          clientName: clientName.trim(),
          clientEmail: clientEmail.trim(),
          clientPhone: clientPhone.trim(),
          propertyAddress: propertyAddress.trim(),
          neededBy, neededByDate: neededBy === "specific" ? neededByDate : undefined,
          contingencyExpirationDate: contingencyDate,
          itemKeys: Array.from(selectedKeys),
          vendorId: selectedVendorId || undefined,
          subjectSqft: subjectSqft || undefined,
        }),
      });
      await fetchJson(`/api/inspection-orders/${created.id}/send`, { method: "POST" });
      setSent(true);
    } catch (e: any) {
      setError(e.message || "Failed to send Inspections+ order.");
    } finally {
      setSending(false);
    }
  };

  const fubDropdown = (
    <>
      {clientSearching && <Loader2 size={14} className="animate-spin" style={{ position: "absolute", right: 12, top: 13, color: GOLD }} />}
      {clientResults.length > 0 && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20,
          background: "#1a1815", border: "1px solid rgba(200,170,90,0.35)", borderRadius: 8,
          maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {clientResults.map(c => (
            <button key={c.id} type="button" onClick={() => pickContact(c)} style={{
              display: "block", width: "100%", textAlign: "left", padding: "9px 12px", cursor: "pointer",
              background: "transparent", border: "none", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#fff",
            }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
                {(c.addresses?.length || 0) > 1 ? `${c.addresses!.length} properties on file — pick one next` : (c.address || [c.phone, c.email].filter(Boolean).join(" · ") || "No details on file")}
              </div>
            </button>
          ))}
        </div>
      )}
    </>
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

        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ClipboardCheck size={20} style={{ color: GOLD }} />
            <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 24, fontWeight: 400, color: "#fff", margin: 0 }}>Inspections+</h2>
          </div>
          <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>
            Order inspections for a buyer client — sends them a branded approval link to e-sign.
          </p>
        </div>

        {error && (
          <div style={{ padding: 10, marginBottom: 14, borderRadius: 8, background: "rgba(255,120,120,0.1)", color: "#ffb0b0", fontSize: 12.5 }}>
            {error}
          </div>
        )}

        {sent ? (
          <>
            <div style={{ padding: 12, borderRadius: 10, background: "rgba(126,212,154,0.1)", color: "#7ed49a", fontSize: 12.5, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
              <CheckCircle2 size={16} /> Sent to {clientName} for approval — you'll get a copy once they sign.
            </div>
            <button onClick={onClose} style={{
              width: "100%", padding: "12px 18px", borderRadius: 10, background: "transparent",
              border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>Done</button>
          </>
        ) : step === 1 ? (
          <>
            <div style={sectionTitleStyle}>Client</div>
            <div style={cardStyle}>
              <label style={labelStyle}>Find Client in FUB</label>
              <div style={{ position: "relative", marginBottom: 8 }}>
                <input style={inputStyle} value={clientQuery} onChange={e => setClientQuery(e.target.value)} placeholder="Type client name to search Follow Up Boss…" />
                {fubDropdown}
              </div>
              <label style={labelStyle}>Client Name</label>
              <input style={{ ...inputStyle, marginBottom: 10 }} value={clientName} onChange={e => setClientName(e.target.value)} placeholder="Full name" />
              <div style={{ display: "flex", gap: 10 }}>
                <input style={inputStyle} value={clientPhone} onChange={e => setClientPhone(e.target.value)} placeholder="Phone" />
                <input style={inputStyle} value={clientEmail} onChange={e => setClientEmail(e.target.value)} placeholder="Email (required to send)" />
              </div>
            </div>

            <div style={sectionTitleStyle}>Property</div>
            <div style={cardStyle}>
              {fubAddressChoices.length > 0 && (
                <FubAddressChooser
                  clientName={clientName || "This client"}
                  addresses={fubAddressChoices}
                  onPick={(addr) => { setPropertyAddress(addr); setFubAddressChoices([]); }}
                  onManual={() => setFubAddressChoices([])}
                />
              )}
              <label style={labelStyle}>Property Address</label>
              <input style={inputStyle} value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} placeholder="123 Main St, Fernandina Beach, FL" />
            </div>

            <button type="button" onClick={() => canGoStep2 ? setStep(2) : setError("Enter the client name and property address to continue.")} style={{
              width: "100%", padding: "14px 18px", borderRadius: 10, marginTop: 8,
              background: GOLD, border: "none", color: "#0c0b0a", fontSize: 14, fontWeight: 700, cursor: "pointer",
            }}>Next — Choose Inspections</button>
          </>
        ) : (
          <>
            <div style={sectionTitleStyle}>Which Inspections?</div>
            <div style={cardStyle}>
              {catalogLoading ? (
                <div style={{ display: "flex", justifyContent: "center", padding: 12 }}><Loader2 size={16} className="animate-spin" style={{ color: GOLD }} /></div>
              ) : (
                catalog.map(item => {
                  const checked = selectedKeys.has(item.key);
                  return (
                    <button key={item.key} type="button" onClick={() => toggleKey(item.key)} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                      padding: "10px 12px", marginBottom: 8, borderRadius: 8, cursor: "pointer",
                      background: checked ? "rgba(200,170,90,0.12)" : "rgba(255,255,255,0.04)",
                      border: checked ? `1px solid ${GOLD}` : "1px solid rgba(255,255,255,0.1)",
                    }}>
                      <span style={{ fontSize: 13.5, color: "#fff", fontWeight: checked ? 700 : 500, textAlign: "left" }}>{item.name}</span>
                      <span style={{ fontSize: 13, color: checked ? GOLD : "rgba(255,255,255,0.5)", fontWeight: 700 }}>${priceFor(item).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    </button>
                  );
                })
              )}
              {selectedKeys.size > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", fontWeight: 700 }}>Total</span>
                  <span style={{ fontSize: 15, color: GOLD, fontWeight: 700 }}>${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              )}
            </div>

            <div style={sectionTitleStyle}>Vendor & Property Size <span style={{ color: "rgba(255,255,255,0.35)", fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>(optional — for sqft-tiered vendor pricing)</span></div>
            <div style={cardStyle}>
              <label style={labelStyle}>Vendor</label>
              <select
                style={{ ...inputStyle, marginBottom: 10, appearance: "auto" }}
                value={selectedVendorId}
                onChange={e => setSelectedVendorId(e.target.value)}
              >
                <option value="">Flat catalog price (no vendor selected)</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <label style={labelStyle}>Subject Property Sqft</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="number" inputMode="numeric" style={inputStyle} value={subjectSqft}
                  onChange={e => setSubjectSqft(e.target.value)} placeholder="e.g. 2200"
                  disabled={!selectedVendorId}
                />
                {/* v20.32.13 — Smart Data auto-fill. Pulls heated sqft captured from
                    county records / sales package / manual entry for this property
                    instead of requiring the agent to look it up or retype it. */}
                <button type="button" disabled={!selectedVendorId || !propertyAddress.trim() || smartDataLoading}
                  onClick={autoFillSqftFromSmartData}
                  style={{
                    padding: "0 10px", borderRadius: 6, whiteSpace: "nowrap", fontSize: 11, fontWeight: 600, cursor: "pointer",
                    background: "rgba(200,170,90,0.12)", border: "1px solid rgba(200,170,90,0.4)", color: "#e8d8a8",
                    opacity: (!selectedVendorId || !propertyAddress.trim()) ? 0.5 : 1,
                  }}
                >{smartDataLoading ? "…" : "From Smart Data"}</button>
              </div>
              {smartDataNote && (
                <p style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 4, marginBottom: 0 }}>{smartDataNote}</p>
              )}
              {selectedVendorId && (
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 8, marginBottom: 0 }}>
                  Enter the heated/cooled sqft to pull this vendor's real tiered pricing above. Leave blank to keep the flat catalog price.
                </p>
              )}
            </div>

            <div style={sectionTitleStyle}>Timing</div>
            <div style={cardStyle}>
              <label style={labelStyle}>Needed By</label>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {(["asap", "specific"] as const).map(opt => (
                  <button key={opt} type="button" onClick={() => setNeededBy(opt)} style={{
                    flex: 1, padding: "10px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700,
                    background: neededBy === opt ? GOLD : "rgba(255,255,255,0.06)",
                    border: neededBy === opt ? "none" : "1px solid rgba(255,255,255,0.15)",
                    color: neededBy === opt ? "#0c0b0a" : "rgba(255,255,255,0.75)",
                  }}>{opt === "asap" ? "ASAP" : "Specific Date"}</button>
                ))}
              </div>
              {neededBy === "specific" && (
                <input type="date" style={{ ...inputStyle, marginBottom: 10 }} value={neededByDate} onChange={e => setNeededByDate(e.target.value)} />
              )}
              <label style={labelStyle}>Inspection Contingency Expiration Date</label>
              <input type="date" style={inputStyle} value={contingencyDate} onChange={e => setContingencyDate(e.target.value)} />
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button type="button" onClick={() => setStep(1)} style={{
                flex: "0 0 auto", padding: "14px 18px", borderRadius: 10,
                background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>Back</button>
              <button type="button" onClick={handleSend} disabled={!canSend || sending} style={{
                flex: 1, padding: "14px 18px", borderRadius: 10,
                background: GOLD, border: "none", color: "#0c0b0a", fontSize: 14, fontWeight: 700,
                cursor: !canSend || sending ? "not-allowed" : "pointer", opacity: !canSend || sending ? 0.5 : 1,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}>
                {sending ? <Loader2 size={16} className="animate-spin" /> : <ClipboardCheck size={16} />}
                Send to Client
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
