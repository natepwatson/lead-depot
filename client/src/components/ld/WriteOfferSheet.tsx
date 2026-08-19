// v20.8.0 — "Place an Offer" tool. Replaces the standalone Repair Quote nav
// tab. One-page form (not a multi-step wizard — this is meant to be filled
// out on the spot in a couple minutes once a buyer says they want to write)
// covering every field in Alex's "AAA WRITE AN OFFER" text template. On
// Send, composes the offer and emails it to the TC (Whittney Rocha) with
// Nate + Alex CC'd — matches server/writeOffer.ts exactly.
import { useState, useEffect } from "react";
import { CheckCircle2, X, Loader2, FileSignature } from "lucide-react";

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
const textareaStyle: React.CSSProperties = { ...inputStyle, minHeight: 60, resize: "vertical", fontFamily: "inherit" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: "0.06em", textTransform: "uppercase",
  marginBottom: 10, marginTop: 4,
};

const FINANCING_TYPES = ["Cash", "Conventional", "FHA", "VA", "USDA", "Other"];
const LENDER_PRESETS = ["Tyler Payne", "Matt Sapienza", "John O'Leary"];
const TC_LABEL = "Whittney (TC)";

function segmented(value: string, options: { key: string; label: string }[], onPick: (k: string) => void) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map(o => (
        <button key={o.key} type="button" onClick={() => onPick(o.key)} style={{
          flex: options.length > 3 ? "0 0 auto" : 1, padding: "10px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700,
          background: value === o.key ? GOLD : "rgba(255,255,255,0.06)",
          border: value === o.key ? "none" : "1px solid rgba(255,255,255,0.15)",
          color: value === o.key ? "#0c0b0a" : "rgba(255,255,255,0.75)",
        }}>{o.label}</button>
      ))}
    </div>
  );
}

export function WriteOfferSheet({
  agentName, initialAddress, onClose,
}: {
  agentName?: string;
  initialAddress?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);

  const [propertyAddress, setPropertyAddress] = useState(initialAddress || "");

  // Buyer 1 / 2 — FUB picker for contact info, full legal name always manual
  // (FUB nickname often isn't the buyer's legal name for the contract).
  const [buyer1LegalName, setBuyer1LegalName] = useState("");
  const [buyer1Phone, setBuyer1Phone] = useState("");
  const [buyer1Email, setBuyer1Email] = useState("");
  const [buyer1Query, setBuyer1Query] = useState("");
  const [buyer1Results, setBuyer1Results] = useState<{ id: number; name: string; email: string | null; phone: string | null }[]>([]);
  const [buyer1Searching, setBuyer1Searching] = useState(false);

  const [showBuyer2, setShowBuyer2] = useState(false);
  const [buyer2LegalName, setBuyer2LegalName] = useState("");
  const [buyer2Phone, setBuyer2Phone] = useState("");
  const [buyer2Email, setBuyer2Email] = useState("");
  const [buyer2Query, setBuyer2Query] = useState("");
  const [buyer2Results, setBuyer2Results] = useState<{ id: number; name: string; email: string | null; phone: string | null }[]>([]);
  const [buyer2Searching, setBuyer2Searching] = useState(false);

  const [buyersAgentName, setBuyersAgentName] = useState(agentName || "");

  const [financingType, setFinancingType] = useState("Conventional");
  const [financingTypeOther, setFinancingTypeOther] = useState("");
  const [loanApprovalPeriod, setLoanApprovalPeriod] = useState("");
  const [lender, setLender] = useState("");
  const [lenderOther, setLenderOther] = useState("");

  const [purchasePrice, setPurchasePrice] = useState("");
  const [binderDepositPct, setBinderDepositPct] = useState("1");
  const [downPaymentPct, setDownPaymentPct] = useState("");

  const [inspectionPeriodDays, setInspectionPeriodDays] = useState("10");
  const [daysToClosing, setDaysToClosing] = useState("30");
  const [possession, setPossession] = useState("At closing");

  const [sellersAgentCompensationPct, setSellersAgentCompensationPct] = useState("3");
  const [appliancesIncluded, setAppliancesIncluded] = useState("All in the home at the time of the sale");

  const [offerExpireDays, setOfferExpireDays] = useState("2");
  const [offerExpireTime, setOfferExpireTime] = useState("18:00");

  const [assignmentAllowed, setAssignmentAllowed] = useState<"yes" | "no">("no");
  const [contingentOnHomeSale, setContingentOnHomeSale] = useState<"yes" | "no">("no");

  const [additionalTerms, setAdditionalTerms] = useState(
    "Seller to compensate buyer's brokerage Momentum Realty 3.0% of the purchase price at closing."
  );

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const isCash = financingType === "Cash";
  const price = parseFloat(purchasePrice) || 0;
  const binderAmt = price * ((parseFloat(binderDepositPct) || 0) / 100);
  const downAmt = price * ((parseFloat(downPaymentPct) || 0) / 100);
  const sellerCompAmt = price * ((parseFloat(sellersAgentCompensationPct) || 0) / 100);
  const fmt = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ── FUB search — Buyer 1 ──────────────────────────────────────────────
  useEffect(() => {
    if (buyer1Query.trim().length < 2) { setBuyer1Results([]); return; }
    const t = setTimeout(async () => {
      setBuyer1Searching(true);
      try {
        const r = await fetch(`/api/fub/contacts/search?q=${encodeURIComponent(buyer1Query.trim())}`, { credentials: "include" });
        const d = await r.json().catch(() => ({ results: [] }));
        setBuyer1Results(d.results || []);
      } catch { setBuyer1Results([]); }
      finally { setBuyer1Searching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [buyer1Query]);

  // ── FUB search — Buyer 2 ──────────────────────────────────────────────
  useEffect(() => {
    if (buyer2Query.trim().length < 2) { setBuyer2Results([]); return; }
    const t = setTimeout(async () => {
      setBuyer2Searching(true);
      try {
        const r = await fetch(`/api/fub/contacts/search?q=${encodeURIComponent(buyer2Query.trim())}`, { credentials: "include" });
        const d = await r.json().catch(() => ({ results: [] }));
        setBuyer2Results(d.results || []);
      } catch { setBuyer2Results([]); }
      finally { setBuyer2Searching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [buyer2Query]);

  const pickBuyer1 = (c: { name: string; email: string | null; phone: string | null }) => {
    setBuyer1Phone(c.phone || ""); setBuyer1Email(c.email || "");
    setBuyer1Query(c.name); setBuyer1Results([]);
  };
  const pickBuyer2 = (c: { name: string; email: string | null; phone: string | null }) => {
    setBuyer2Phone(c.phone || ""); setBuyer2Email(c.email || "");
    setBuyer2Query(c.name); setBuyer2Results([]);
  };

  const canSend = propertyAddress.trim() && purchasePrice && buyer1LegalName.trim();

  const handleSend = async () => {
    if (!canSend) { setError("Property address, purchase price, and at least Buyer 1's full legal name are required."); return; }
    setError(""); setSending(true);
    try {
      await fetchJson("/api/write-offer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentName,
          propertyAddress,
          buyer1LegalName, buyer1Phone, buyer1Email,
          buyer2LegalName: showBuyer2 ? buyer2LegalName : "", buyer2Phone: showBuyer2 ? buyer2Phone : "", buyer2Email: showBuyer2 ? buyer2Email : "",
          buyersAgentName,
          financingType, financingTypeOther, loanApprovalPeriod,
          purchasePrice: price,
          binderDepositPct: parseFloat(binderDepositPct) || 0,
          downPaymentPct: parseFloat(downPaymentPct) || 0,
          inspectionPeriodDays: parseInt(inspectionPeriodDays, 10) || 10,
          daysToClosing: parseInt(daysToClosing, 10) || 30,
          possession,
          sellersAgentCompensationPct: parseFloat(sellersAgentCompensationPct) || 0,
          appliancesIncluded,
          offerExpireDays: parseInt(offerExpireDays, 10) || 2,
          offerExpireTime,
          assignmentAllowed, contingentOnHomeSale,
          additionalTerms,
          lender, lenderOther,
        }),
      });
      setSent(true);
    } catch (e: any) {
      setError(e.message || "Failed to send offer.");
    } finally {
      setSending(false);
    }
  };

  const fubDropdown = (
    results: { id: number; name: string; email: string | null; phone: string | null }[],
    onPick: (c: any) => void,
    searching: boolean
  ) => (
    <>
      {searching && <Loader2 size={14} className="animate-spin" style={{ position: "absolute", right: 12, top: 13, color: GOLD }} />}
      {results.length > 0 && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20,
          background: "#1a1815", border: "1px solid rgba(200,170,90,0.35)", borderRadius: 8,
          maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {results.map(c => (
            <button key={c.id} type="button" onClick={() => onPick(c)} style={{
              display: "block", width: "100%", textAlign: "left", padding: "9px 12px", cursor: "pointer",
              background: "transparent", border: "none", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#fff",
            }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{[c.phone, c.email].filter(Boolean).join(" · ") || "No phone/email on file"}</div>
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
            <FileSignature size={20} style={{ color: GOLD }} />
            <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 24, fontWeight: 400, color: "#fff", margin: 0 }}>Place an Offer</h2>
          </div>
          <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>
            Fill this out with the buyer on the spot — sends straight to {TC_LABEL} with Nate &amp; Alex CC'd.
          </p>
        </div>

        {error && (
          <div style={{ padding: 10, marginBottom: 14, borderRadius: 8, background: "rgba(255,120,120,0.1)", color: "#ffb0b0", fontSize: 12.5 }}>
            {error}
          </div>
        )}

        {!sent ? (
          <>
            <div style={sectionTitleStyle}>Contract</div>
            <div style={cardStyle}>
              <label style={labelStyle}>Contract Type</label>
              <p style={{ fontSize: 13, color: "#fff", margin: "0 0 12px" }}>Residential Purchase &amp; Sale — Far-Bar As-Is</p>
              <label style={labelStyle}>Property Address</label>
              <input style={inputStyle} value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} placeholder="123 Main St, Fernandina Beach, FL" />
            </div>

            <div style={sectionTitleStyle}>Buyer(s)</div>
            <div style={cardStyle}>
              <label style={labelStyle}>Find Buyer 1 in FUB</label>
              <div style={{ position: "relative", marginBottom: 8 }}>
                <input style={inputStyle} value={buyer1Query} onChange={e => setBuyer1Query(e.target.value)} placeholder="Type buyer name to search Follow Up Boss…" />
                {fubDropdown(buyer1Results, pickBuyer1, buyer1Searching)}
              </div>
              <label style={labelStyle}>Buyer 1 — Full Legal Name</label>
              <input style={{ ...inputStyle, marginBottom: 10 }} value={buyer1LegalName} onChange={e => setBuyer1LegalName(e.target.value)} placeholder="As it should appear on the contract" />
              <div style={{ display: "flex", gap: 10, marginBottom: 4 }}>
                <input style={inputStyle} value={buyer1Phone} onChange={e => setBuyer1Phone(e.target.value)} placeholder="Phone" />
                <input style={inputStyle} value={buyer1Email} onChange={e => setBuyer1Email(e.target.value)} placeholder="Email" />
              </div>

              {showBuyer2 ? (
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <label style={labelStyle}>Find Buyer 2 in FUB</label>
                  <div style={{ position: "relative", marginBottom: 8 }}>
                    <input style={inputStyle} value={buyer2Query} onChange={e => setBuyer2Query(e.target.value)} placeholder="Type buyer name to search Follow Up Boss…" />
                    {fubDropdown(buyer2Results, pickBuyer2, buyer2Searching)}
                  </div>
                  <label style={labelStyle}>Buyer 2 — Full Legal Name</label>
                  <input style={{ ...inputStyle, marginBottom: 10 }} value={buyer2LegalName} onChange={e => setBuyer2LegalName(e.target.value)} placeholder="As it should appear on the contract" />
                  <div style={{ display: "flex", gap: 10 }}>
                    <input style={inputStyle} value={buyer2Phone} onChange={e => setBuyer2Phone(e.target.value)} placeholder="Phone" />
                    <input style={inputStyle} value={buyer2Email} onChange={e => setBuyer2Email(e.target.value)} placeholder="Email" />
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setShowBuyer2(true)} style={{
                  background: "none", border: "none", color: GOLD, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  padding: 0, marginTop: 12, display: "block",
                }}>+ Add Second Buyer</button>
              )}
            </div>

            <div style={cardStyle}>
              <label style={labelStyle}>Buyer's Agent Name</label>
              <input style={inputStyle} value={buyersAgentName} onChange={e => setBuyersAgentName(e.target.value)} placeholder="Buyer's agent" />
            </div>

            <div style={sectionTitleStyle}>Financing</div>
            <div style={cardStyle}>
              <label style={labelStyle}>Financing Type</label>
              <div style={{ marginBottom: 10 }}>
                {segmented(financingType, FINANCING_TYPES.map(t => ({ key: t, label: t })), setFinancingType)}
              </div>
              {financingType === "Other" && (
                <input style={{ ...inputStyle, marginBottom: 10 }} value={financingTypeOther} onChange={e => setFinancingTypeOther(e.target.value)} placeholder="Describe financing type" />
              )}
              {!isCash && (
                <>
                  <label style={labelStyle}>Loan Approval Period</label>
                  <input style={{ ...inputStyle, marginBottom: 10 }} value={loanApprovalPeriod} onChange={e => setLoanApprovalPeriod(e.target.value)} placeholder="e.g. 21 days" />
                  <label style={labelStyle}>Lender</label>
                  <div style={{ marginBottom: 8 }}>
                    {segmented(lender, [...LENDER_PRESETS.map(l => ({ key: l, label: l })), { key: "Other", label: "Other" }], setLender)}
                  </div>
                  {lender === "Other" && (
                    <input style={inputStyle} value={lenderOther} onChange={e => setLenderOther(e.target.value)} placeholder="Lender name" />
                  )}
                </>
              )}
            </div>

            <div style={sectionTitleStyle}>Price &amp; Terms</div>
            <div style={cardStyle}>
              <label style={labelStyle}>Purchase Price</label>
              <input style={{ ...inputStyle, marginBottom: 10 }} value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} placeholder="$" inputMode="decimal" />

              <div style={{ display: "flex", gap: 10, marginBottom: 4 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Binder Deposit %</label>
                  <input style={inputStyle} value={binderDepositPct} onChange={e => setBinderDepositPct(e.target.value)} inputMode="decimal" />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Down Payment %</label>
                  <input style={inputStyle} value={downPaymentPct} onChange={e => setDownPaymentPct(e.target.value)} placeholder="%" inputMode="decimal" />
                </div>
              </div>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 6, marginBottom: 14 }}>
                Binder: {fmt(binderAmt)} · Down: {fmt(downAmt)}
              </p>

              <label style={labelStyle}>Title Attorney</label>
              <p style={{ fontSize: 13, color: "#fff", margin: "0 0 12px" }}>Seller selected</p>

              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Inspection Period (days)</label>
                  <input style={inputStyle} value={inspectionPeriodDays} onChange={e => setInspectionPeriodDays(e.target.value)} inputMode="numeric" />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Days to Closing</label>
                  <input style={inputStyle} value={daysToClosing} onChange={e => setDaysToClosing(e.target.value)} inputMode="numeric" />
                </div>
              </div>

              <label style={labelStyle}>Possession</label>
              <input style={{ ...inputStyle, marginBottom: 10 }} value={possession} onChange={e => setPossession(e.target.value)} />

              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", margin: "0 0 10px" }}>Buyer to Pay: $800 Broker Fee</p>
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", margin: "0 0 10px" }}>Seller to Pay: Customaries</p>

              <label style={labelStyle}>Seller to Pay — Buyer's Agent Compensation %</label>
              <input style={{ ...inputStyle, marginBottom: 4 }} value={sellersAgentCompensationPct} onChange={e => setSellersAgentCompensationPct(e.target.value)} inputMode="decimal" />
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 6, marginBottom: 14 }}>{fmt(sellerCompAmt)}</p>

              <label style={labelStyle}>Appliances Included</label>
              <input style={{ ...inputStyle, marginBottom: 14 }} value={appliancesIncluded} onChange={e => setAppliancesIncluded(e.target.value)} />

              <label style={labelStyle}>Offer to Expire</label>
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <input style={inputStyle} value={offerExpireDays} onChange={e => setOfferExpireDays(e.target.value)} inputMode="numeric" placeholder="Days" />
                </div>
                <div style={{ flex: 1 }}>
                  <input type="time" style={inputStyle} value={offerExpireTime} onChange={e => setOfferExpireTime(e.target.value)} />
                </div>
              </div>

              <label style={labelStyle}>Assignment</label>
              <div style={{ marginBottom: 14 }}>
                {segmented(assignmentAllowed, [{ key: "no", label: "Buyer May NOT" }, { key: "yes", label: "Buyer May" }], v => setAssignmentAllowed(v as any))}
              </div>

              <label style={labelStyle}>Contingent on Home Sale?</label>
              <div>
                {segmented(contingentOnHomeSale, [{ key: "no", label: "No" }, { key: "yes", label: "Yes" }], v => setContingentOnHomeSale(v as any))}
              </div>
            </div>

            <div style={sectionTitleStyle}>Additional Terms</div>
            <div style={cardStyle}>
              <textarea style={textareaStyle} value={additionalTerms} onChange={e => setAdditionalTerms(e.target.value)} />
            </div>

            <div style={{ ...cardStyle, background: "rgba(255,255,255,0.02)" }}>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)", margin: "0 0 8px" }}>Docs to Include (auto-added to the email)</p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "rgba(255,255,255,0.65)", lineHeight: 1.7 }}>
                <li>Exclusive Buyer's Brokerage Agreement — 3%, $800, 12 mo</li>
                <li>Seller to Buyer's Broker Compensation Agreement — 3%</li>
                <li>Disclosure to Buyer — $800 fee</li>
                <li>{isCash ? "Proof of Funds" : "Pre-Approval Letter"}</li>
              </ul>
              <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)", marginTop: 10, marginBottom: 0 }}>
                The email will also note: inspections to order once accepted — HI, WDO, WM, 4pt.
              </p>
            </div>

            <button type="button" onClick={handleSend} disabled={!canSend || sending} style={{
              width: "100%", padding: "14px 18px", borderRadius: 10, marginTop: 8,
              background: GOLD, border: "none", color: "#0c0b0a", fontSize: 14, fontWeight: 700,
              cursor: !canSend || sending ? "not-allowed" : "pointer", opacity: !canSend || sending ? 0.5 : 1,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}>
              {sending ? <Loader2 size={16} className="animate-spin" /> : <FileSignature size={16} />}
              Send to {TC_LABEL}
            </button>
          </>
        ) : (
          <>
            <div style={{ padding: 12, borderRadius: 10, background: "rgba(126,212,154,0.1)", color: "#7ed49a", fontSize: 12.5, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
              <CheckCircle2 size={16} /> Offer sent to {TC_LABEL} — Nate &amp; Alex CC'd.
            </div>
            <button onClick={onClose} style={{
              width: "100%", padding: "12px 18px", borderRadius: 10, background: "transparent",
              border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}
