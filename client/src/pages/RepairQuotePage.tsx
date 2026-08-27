// v20.32.0 — Public, unauthenticated client-facing repair quote accept page.
// Reached via /#/repair-quote/:token (hash route, outside the auth gate).
// Two-stage e-sign flow: client types their name to e-sign, which moves the
// consult to 'pending_countersignature' — Alex/Nate then countersign in the
// admin panel to finalize. Client can also Decline. Renders the full
// Terms & Conditions (agreementSections) alongside the itemized quote.
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

export type QuoteItem = {
  name: string; quantity: number; unit: string; line_total: number | null; two_story: number;
};
export type VendorItem = { name: string };
export type AgreementSection = { heading: string; body: string };
export type QuoteData = {
  consult: {
    propertyAddress: string; clientName: string | null; heroPhotoUrl: string | null;
    subtotal: number; total: number; depositAmount: number; finalAmount: number;
    startWindow: string | null; startDate: string | null; startTime: string | null;
    startMomentum: string;
    status: string; signatureMethod: string | null;
    agreementPdfUrl?: string | null;
  };
  items: QuoteItem[];
  vendorItems?: VendorItem[];
  terms: string[];
  agreementSections: AgreementSection[];
};

const APP_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
const resolveUrl = (u: string | null) => !u ? null : (u.startsWith("http") ? u : APP_ORIGIN + u);

// v20.32.25 — presentational body extracted so the admin "Preview" modal
// (RepairPricingVendorPanel) can render the EXACT same JSX the client sees
// on the real /#/repair-quote/:token page — zero drift, one source of truth.
// When previewMode is true, the sign/decline form is replaced with a plain
// notice; accept/decline handlers are optional and unused in that mode.
export function RepairQuoteBody({
  data, effectiveStatus, error, signerName = "", setSignerName, accepting, declining,
  onAccept, onDecline, previewMode,
}: {
  data: QuoteData; effectiveStatus: string | null; error?: string;
  signerName?: string; setSignerName?: (v: string) => void;
  accepting?: boolean; declining?: boolean;
  onAccept?: () => void; onDecline?: () => void; previewMode?: boolean;
}) {
  const { consult, items, agreementSections, vendorItems } = data;
  const hero = resolveUrl(consult.heroPhotoUrl);
  const agreementUrl = resolveUrl(consult.agreementPdfUrl || null);

  return (
    <div style={{ minHeight: previewMode ? "auto" : "100dvh", background: "#eeeeec", fontFamily: "Helvetica,Arial,sans-serif", padding: "0 0 60px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", background: "#fff", boxShadow: "0 4px 30px rgba(0,0,0,0.08)" }}>
        <div style={{ background: "#111", padding: "26px 32px", textAlign: "center" }}>
          <p style={{ color: "#fff", fontSize: 20, fontWeight: 700, letterSpacing: "0.06em", margin: 0 }}>BROTHERS GROUP</p>
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, letterSpacing: "0.12em", margin: "4px 0 0", textTransform: "uppercase" }}>Repair Proposal</p>
        </div>

        {hero && <img src={hero} alt={consult.propertyAddress} style={{ width: "100%", maxHeight: 280, objectFit: "cover", display: "block" }} />}

        <div style={{ padding: "26px 32px" }}>
          <h1 style={{ fontSize: 22, color: "#1a1a1a", margin: "0 0 4px" }}>{consult.propertyAddress}</h1>
          {consult.clientName && <p style={{ fontSize: 13, color: "#666", margin: "0 0 20px" }}>Prepared for {consult.clientName}</p>}

          <table style={{ width: "100%", fontSize: 13, marginBottom: 18, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #111" }}>
                <th style={{ textAlign: "left", padding: "6px 0", color: "#111" }}>Item</th>
                <th style={{ textAlign: "right", padding: "6px 0", color: "#111" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #e2e2e2" }}>
                  <td style={{ padding: "8px 0", color: "#333" }}>{it.name}{it.two_story ? " (2-story)" : ""}</td>
                  <td style={{ padding: "8px 0", textAlign: "right", color: "#333" }}>${(it.line_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "2px solid #111" }}>
            <span style={{ fontWeight: 700, fontSize: 16, color: "#111" }}>Total</span>
            <span style={{ fontWeight: 700, fontSize: 16, color: "#111" }}>${consult.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>

          <div style={{ marginTop: 12, marginBottom: 20, background: "#111", borderRadius: 8, padding: "16px 18px", display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>50% To Start</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", marginTop: 3 }}>${consult.depositAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            </div>
            <div style={{ width: 1, background: "rgba(255,255,255,0.15)" }} />
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>50% On Completion</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", marginTop: 3 }}>${consult.finalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            </div>
          </div>

          <div style={{ background: "#f0f9f0", border: "1px solid #cfe8cf", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
            <p style={{ fontSize: 11.5, color: "#3a7d3a", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 6px", fontWeight: 700 }}>Good News</p>
            <p style={{ fontSize: 13.5, color: "#1a1a1a", margin: 0, fontWeight: 600, lineHeight: 1.5 }}>{consult.startMomentum}</p>
          </div>

          {vendorItems && vendorItems.length > 0 && (
            <div style={{ background: "#f7f6f2", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
              <p style={{ fontSize: 11.5, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px", fontWeight: 700 }}>Also Coordinating For You (One Stop Shop)</p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#333", lineHeight: 1.6 }}>
                {vendorItems.map((v, i) => <li key={i}>{v.name}</li>)}
              </ul>
              <p style={{ fontSize: 11, color: "#888", fontStyle: "italic", margin: "8px 0 0" }}>Licensed-trade work above is quoted and billed separately by our vetted vendor partners — not included in the total above.</p>
            </div>
          )}

          {agreementUrl && (
            <a href={agreementUrl} target="_blank" rel="noreferrer" style={{ display: "block", textAlign: "center", padding: "12px 16px", borderRadius: 8, border: "1px solid #111", color: "#111", fontSize: 13, fontWeight: 700, marginBottom: 20, textDecoration: "none" }}>
              View Full Signature-Ready Agreement (2-page PDF)
            </a>
          )}

          {agreementSections && agreementSections.length > 0 && (
            <div style={{ marginBottom: 22 }}>
              <p style={{ fontSize: 11.5, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Terms & Conditions</p>
              <div style={{ background: "#f7f6f2", borderRadius: 8, padding: "16px 18px", maxHeight: 320, overflowY: "auto" }}>
                {agreementSections.map((s, i) => (
                  <div key={i} style={{ marginBottom: i === agreementSections.length - 1 ? 0 : 14 }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: "#1a1a1a", margin: "0 0 4px" }}>{s.heading}</p>
                    <p style={{ fontSize: 11.5, color: "#666", margin: 0, lineHeight: 1.55 }}>{s.body}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {previewMode ? (
            <div style={{ background: "#eef2fb", border: "1px solid #c7d4ef", borderRadius: 8, padding: "14px 16px", fontSize: 13, color: "#2a3f6b" }}>
              <strong>Preview only</strong> — this is exactly what {consult.clientName || "the client"} will see and sign. The name field and Accept/Decline buttons are disabled here.
            </div>
          ) : effectiveStatus === "accepted" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(30,150,90,0.08)", color: "#1e7a45", padding: "14px 16px", borderRadius: 8, fontSize: 14 }}>
              <CheckCircle2 size={20} /> Fully executed — thank you! We'll be in touch to confirm your start date.
            </div>
          ) : effectiveStatus === "pending_countersignature" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(200,170,90,0.12)", color: "#8a6d1f", padding: "14px 16px", borderRadius: 8, fontSize: 14 }}>
              <CheckCircle2 size={20} /> Signed — thank you! We're finalizing our countersignature and will send you the fully executed agreement shortly.
            </div>
          ) : effectiveStatus === "declined" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(200,60,60,0.08)", color: "#a33", padding: "14px 16px", borderRadius: 8, fontSize: 14 }}>
              <XCircle size={20} /> You've declined this proposal. If this was a mistake, please reach out to us directly.
            </div>
          ) : (
            <div>
              {error && <p style={{ color: "#c0392b", fontSize: 12.5, marginBottom: 8 }}>{error}</p>}
              <label style={{ fontSize: 11.5, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Type your full name to accept & e-sign</label>
              <input
                value={signerName} onChange={e => setSignerName?.(e.target.value)} placeholder="Full legal name"
                style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid #ccc", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }}
              />
              <button
                onClick={onAccept} disabled={accepting || declining}
                style={{ width: "100%", padding: "14px 18px", borderRadius: 8, background: "#111", color: "#fff", border: "none", fontSize: 14.5, fontWeight: 700, cursor: "pointer", marginBottom: 10 }}
              >{accepting ? "Submitting…" : `Accept Proposal — $${consult.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}</button>
              <button
                onClick={onDecline} disabled={accepting || declining}
                style={{ width: "100%", padding: "12px 18px", borderRadius: 8, background: "transparent", color: "#888", border: "1px solid #ccc", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >{declining ? "Submitting…" : "Decline Proposal"}</button>
              <p style={{ fontSize: 10.5, color: "#999", marginTop: 10, lineHeight: 1.5 }}>
                By clicking Accept, you agree to the Terms & Conditions above and authorize Brothers Group / Nathaniel Peter Watson LLC and Alexander Gabriel Watson LLC to begin work upon receipt of the deposit.
              </p>
            </div>
          )}
        </div>

        <div style={{ background: "#111", padding: "16px 32px", textAlign: "center" }}>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, margin: 0 }}>ALEX & NATE WATSON · (904) 867-3984 · nate@brothersgroup.realestate</p>
        </div>
      </div>
    </div>
  );
}

export default function RepairQuotePage() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<QuoteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signerName, setSignerName] = useState("");
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);

  useEffect(() => {
    fetch(`/api/repair-quote/${params.token}`)
      .then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b?.error || "Quote not found"); return b; })
      .then((d: QuoteData) => setData(d))
      .catch(e => setError(e.message || "This quote link is invalid or has expired."))
      .finally(() => setLoading(false));
  }, [params.token]);

  const effectiveStatus = localStatus || data?.consult.status || null;

  const handleAccept = async () => {
    if (!signerName.trim()) { setError("Please type your full name to sign."); return; }
    setAccepting(true); setError("");
    try {
      const r = await fetch(`/api/repair-quote/${params.token}/accept`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureName: signerName.trim(), method: "e_sign" }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b?.error || "Failed to accept quote");
      setLocalStatus("pending_countersignature");
    } catch (e: any) { setError(e.message || "Something went wrong. Please try again or call us."); }
    finally { setAccepting(false); }
  };

  const handleDecline = async () => {
    if (!window.confirm("Are you sure you want to decline this proposal?")) return;
    const reason = window.prompt("Optional — let us know why (or leave blank):") || "";
    setDeclining(true); setError("");
    try {
      const r = await fetch(`/api/repair-quote/${params.token}/decline`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b?.error || "Failed to decline quote");
      setLocalStatus("declined");
    } catch (e: any) { setError(e.message || "Something went wrong. Please try again or call us."); }
    finally { setDeclining(false); }
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100dvh", background: "#f4f4f2", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader2 size={26} className="animate-spin" style={{ color: "#1a1a1a" }} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ minHeight: "100dvh", background: "#f4f4f2", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: "center", fontFamily: "Helvetica,Arial,sans-serif" }}>
          <h2 style={{ color: "#1a1a1a" }}>Quote Not Found</h2>
          <p style={{ color: "#555", fontSize: 14 }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <RepairQuoteBody
      data={data} effectiveStatus={effectiveStatus} error={error}
      signerName={signerName} setSignerName={setSignerName}
      accepting={accepting} declining={declining}
      onAccept={handleAccept} onDecline={handleDecline}
    />
  );
}
