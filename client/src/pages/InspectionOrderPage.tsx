// v20.32.13 — Public, unauthenticated client-facing Inspections+ order e-sign
// page. Reached via /#/inspections/:token (hash route, outside the auth
// gate). Single-stage typed-name e-sign — no countersignature step, unlike
// the Repair program's two-stage flow (per Alex's explicit scope decision).
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { CheckCircle2, Loader2 } from "lucide-react";

export type OrderData = {
  order: {
    propertyAddress: string;
    clientName: string | null;
    neededBy: "asap" | "specific";
    neededByDate: string | null;
    contingencyExpirationDate: string | null;
    status: "draft" | "sent" | "accepted" | "declined" | "completed";
    total: number;
    acceptedSignatureName: string | null;
    acceptedAt: string | null;
  };
  items: { name: string; clientPrice: number; isAddon: boolean }[];
  terms?: string[];
};

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// v20.32.25 — presentational body extracted so the admin "Preview" modal
// (InspectionsPricingPanel) can render the EXACT same JSX the client sees on
// the real /#/inspections/:token page — zero drift, one source of truth.
// When previewMode is true, the sign/decline form is replaced with a plain
// notice; signerName/handlers are optional and unused in that mode.
export function InspectionOrderBody({
  data, error, previewMode, signed, declined,
  signerName = "", setSignerName, signing, declining, onSign, onDecline,
}: {
  data: OrderData; error?: string; previewMode?: boolean;
  signed?: boolean; declined?: boolean;
  signerName?: string; setSignerName?: (v: string) => void;
  signing?: boolean; declining?: boolean;
  onSign?: () => void; onDecline?: () => void;
}) {
  const { order, items } = data;
  const neededLabel = order.neededBy === "specific" && order.neededByDate ? `By ${fmtDate(order.neededByDate)}` : "As soon as possible";

  return (
    <div style={{ minHeight: previewMode ? "auto" : "100dvh", background: "#eeeeec", fontFamily: "Helvetica,Arial,sans-serif", padding: "0 0 60px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", background: "#fff", boxShadow: "0 4px 30px rgba(0,0,0,0.08)" }}>
        <div style={{ background: "#111", padding: "26px 32px", textAlign: "center" }}>
          <p style={{ color: "#fff", fontSize: 20, fontWeight: 700, letterSpacing: "0.06em", margin: 0 }}>BROTHERS GROUP</p>
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, letterSpacing: "0.12em", margin: "4px 0 0", textTransform: "uppercase" }}>Inspections+</p>
        </div>

        <div style={{ padding: "26px 32px" }}>
          <h1 style={{ fontSize: 22, color: "#1a1a1a", margin: "0 0 4px" }}>{order.propertyAddress}</h1>
          {order.clientName && <p style={{ fontSize: 13, color: "#666", margin: "0 0 20px" }}>Prepared for {order.clientName}</p>}

          <p style={{ fontSize: 13, color: "#333", lineHeight: 1.6, marginBottom: 18 }}>
            As we prepare to list your home, we'd like to get these inspections scheduled with our trusted inspection partner. We're referring
            you to them directly, and we'll coordinate with them on our end to keep things moving quickly — time is of the essence here since
            we're working together as a team on your timeline. Once approved, please ask the inspector to send the quote/invoice our way too.
          </p>

          <table style={{ width: "100%", fontSize: 13, marginBottom: 6, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #111" }}>
                <th style={{ textAlign: "left", padding: "6px 0", color: "#111" }}>Service</th>
                <th style={{ textAlign: "right", padding: "6px 0", color: "#111" }}>Price</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #e2e2e2" }}>
                  <td style={{ padding: "8px 0", color: "#333" }}>{it.name}{it.isAddon ? " (Add-On)" : ""}</td>
                  <td style={{ padding: "8px 0", textAlign: "right", color: "#333" }}>${it.clientPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "2px solid #111", marginBottom: 14 }}>
            <span style={{ fontWeight: 700, fontSize: 16, color: "#111" }}>Total</span>
            <span style={{ fontWeight: 700, fontSize: 16, color: "#111" }}>${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>

          <div style={{ background: "#f4f4f2", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 12.5, color: "#333" }}>
            <p style={{ margin: "0 0 4px" }}><strong>Needed by:</strong> {neededLabel}</p>
            {order.contingencyExpirationDate && (
              <p style={{ margin: 0 }}><strong>Inspection contingency expires:</strong> {fmtDate(order.contingencyExpirationDate)}</p>
            )}
          </div>

          {previewMode ? (
            <div style={{ background: "#eef2fb", border: "1px solid #c7d4ef", borderRadius: 8, padding: "14px 16px", fontSize: 13, color: "#2a3f6b", marginBottom: 14 }}>
              <strong>Preview only</strong> — this is exactly what {order.clientName || "the client"} will see and sign. The name field and Approve/Decline buttons are disabled here.
            </div>
          ) : null}

          {signed ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(30,150,90,0.08)", color: "#1e7a45", padding: "14px 16px", borderRadius: 8, fontSize: 14 }}>
              <CheckCircle2 size={20} /> Approved — thank you! We're scheduling this now and will be in touch.
            </div>
          ) : declined ? (
            <div style={{ background: "#f4f4f2", color: "#666", padding: "14px 16px", borderRadius: 8, fontSize: 13.5 }}>
              You've declined this order. Reach out to us anytime if you'd like to revisit it.
            </div>
          ) : (
            <div>
              {error && <p style={{ color: "#c0392b", fontSize: 12.5, marginBottom: 8 }}>{error}</p>}
              <label style={{ fontSize: 11.5, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
                Type your full name to approve & e-sign this order
              </label>
              <input
                value={signerName} onChange={e => setSignerName?.(e.target.value)} placeholder="Full legal name" disabled={previewMode}
                style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid #ccc", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }}
              />
              <button
                onClick={onSign} disabled={previewMode || signing}
                style={{ width: "100%", padding: "14px 18px", borderRadius: 8, background: "#111", color: "#fff", border: "none", fontSize: 14.5, fontWeight: 700, cursor: previewMode ? "default" : "pointer", marginBottom: 10 }}
              >{signing ? "Submitting…" : `Approve & Sign — $${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}</button>
              <button
                onClick={onDecline} disabled={previewMode || declining}
                style={{ width: "100%", padding: "10px 18px", borderRadius: 8, background: "transparent", color: "#888", border: "1px solid #ccc", fontSize: 13, cursor: previewMode ? "default" : "pointer" }}
              >{declining ? "Submitting…" : "Decline"}</button>
              <p style={{ fontSize: 10.5, color: "#999", marginTop: 10, lineHeight: 1.5 }}>
                By signing, you authorize Brothers Group to coordinate this inspection order with our inspection partner on your behalf.
              </p>
              {!!data?.terms?.length && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #eee" }}>
                  <p style={{ fontSize: 10, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 6px" }}>Terms &amp; Disclosures</p>
                  {data.terms.map((t, i) => (
                    <p key={i} style={{ fontSize: 9.5, color: "#999", lineHeight: 1.5, margin: "0 0 6px" }}>{t}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ background: "#111", padding: "16px 32px", textAlign: "center" }}>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, margin: 0 }}>ALEX & NATE WATSON · (904) 504-3794 · nate@brothersgroup.realestate</p>
        </div>
      </div>
    </div>
  );
}

export default function InspectionOrderPage() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<OrderData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signerName, setSignerName] = useState("");
  const [signed, setSigned] = useState(false);
  const [signing, setSigning] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    fetch(`/api/inspection-order/${params.token}`)
      .then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b?.error || "Order not found"); return b; })
      .then((d: OrderData) => {
        setData(d);
        if (d.order.status === "accepted" || d.order.status === "completed") setSigned(true);
        if (d.order.status === "declined") setDeclined(true);
      })
      .catch(e => setError(e.message || "This link is invalid or has expired."))
      .finally(() => setLoading(false));
  }, [params.token]);

  const handleSign = async () => {
    if (!signerName.trim()) { setError("Please type your full name to sign."); return; }
    setSigning(true); setError("");
    try {
      const r = await fetch(`/api/inspection-order/${params.token}/accept`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureName: signerName.trim() }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b?.error || "Failed to approve order");
      setSigned(true);
    } catch (e: any) { setError(e.message || "Something went wrong. Please try again or call us."); }
    finally { setSigning(false); }
  };

  const handleDecline = async () => {
    setDeclining(true); setError("");
    try {
      const r = await fetch(`/api/inspection-order/${params.token}/decline`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      if (!r.ok) { const b = await r.json(); throw new Error(b?.error || "Failed to decline"); }
      setDeclined(true);
    } catch (e: any) { setError(e.message || "Something went wrong."); }
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
          <h2 style={{ color: "#1a1a1a" }}>Order Not Found</h2>
          <p style={{ color: "#555", fontSize: 14 }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <InspectionOrderBody
      data={data} error={error} signed={signed} declined={declined}
      signerName={signerName} setSignerName={setSignerName}
      signing={signing} declining={declining}
      onSign={handleSign} onDecline={handleDecline}
    />
  );
}
