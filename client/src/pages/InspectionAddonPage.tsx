// v20.32.13 — Public, unauthenticated client-facing Inspections+ Add-On e-sign
// page. Reached via /#/inspections/addon/:token. Mirrors RepairChangeOrderPage
// but for a single additional inspection service tacked onto an existing order.
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { CheckCircle2, Loader2 } from "lucide-react";

type AddonData = {
  addon: {
    name: string;
    clientPrice: number;
    status: "pending" | "office_approved" | "declined" | "signed";
    signedAt: string | null;
    signatureName: string | null;
  };
  order: {
    propertyAddress: string | null;
    clientName: string | null;
    currentTotal: number | null;
  };
};

export default function InspectionAddonPage() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<AddonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signerName, setSignerName] = useState("");
  const [signed, setSigned] = useState(false);
  const [newTotal, setNewTotal] = useState<number | null>(null);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    fetch(`/api/inspection-addon/${params.token}`)
      .then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b?.error || "Add-on not found"); return b; })
      .then((d: AddonData) => { setData(d); if (d.addon.status === "signed") setSigned(true); })
      .catch(e => setError(e.message || "This link is invalid or has expired."))
      .finally(() => setLoading(false));
  }, [params.token]);

  const handleSign = async () => {
    if (!signerName.trim()) { setError("Please type your full name to sign."); return; }
    setSigning(true); setError("");
    try {
      const r = await fetch(`/api/inspection-addon/${params.token}/sign`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureName: signerName.trim() }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b?.error || "Failed to sign add-on");
      setSigned(true);
      setNewTotal(b.newTotal ?? null);
    } catch (e: any) { setError(e.message || "Something went wrong. Please try again or call us."); }
    finally { setSigning(false); }
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
          <h2 style={{ color: "#1a1a1a" }}>Add-On Not Found</h2>
          <p style={{ color: "#555", fontSize: 14 }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;
  const { addon, order } = data;
  const alreadyDeclinedOrPending = addon.status === "pending" || addon.status === "declined";

  return (
    <div style={{ minHeight: "100dvh", background: "#eeeeec", fontFamily: "Helvetica,Arial,sans-serif", padding: "0 0 60px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", background: "#fff", boxShadow: "0 4px 30px rgba(0,0,0,0.08)" }}>
        <div style={{ background: "#111", padding: "26px 32px", textAlign: "center" }}>
          <p style={{ color: "#fff", fontSize: 20, fontWeight: 700, letterSpacing: "0.06em", margin: 0 }}>BROTHERS GROUP</p>
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, letterSpacing: "0.12em", margin: "4px 0 0", textTransform: "uppercase" }}>Inspections+ Add-On</p>
        </div>

        <div style={{ padding: "26px 32px" }}>
          {order.propertyAddress && <h1 style={{ fontSize: 22, color: "#1a1a1a", margin: "0 0 4px" }}>{order.propertyAddress}</h1>}
          {order.clientName && <p style={{ fontSize: 13, color: "#666", margin: "0 0 20px" }}>Prepared for {order.clientName}</p>}

          <div style={{ background: "#fdf6e3", border: "1px solid #eadfb8", borderRadius: 8, padding: "14px 16px", marginBottom: 18 }}>
            <p style={{ fontSize: 11.5, color: "#8a6d1f", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 6px", fontWeight: 700 }}>Additional Inspection Requested</p>
            <p style={{ fontSize: 14, color: "#1a1a1a", margin: 0, fontWeight: 600, lineHeight: 1.5 }}>{addon.name}</p>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "2px solid #111" }}>
            <span style={{ fontWeight: 700, fontSize: 16, color: "#111" }}>Add-On Amount</span>
            <span style={{ fontWeight: 700, fontSize: 16, color: "#111" }}>${addon.clientPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
          {order.currentTotal != null && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0 20px", fontSize: 12.5, color: "#666" }}>
              <span>Current order total</span><span>${order.currentTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
          )}

          {signed ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(30,150,90,0.08)", color: "#1e7a45", padding: "14px 16px", borderRadius: 8, fontSize: 14 }}>
              <CheckCircle2 size={20} /> Signed — thank you! This is now added to your order
              {newTotal != null ? ` and your new order total is $${newTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}.` : "."}
            </div>
          ) : alreadyDeclinedOrPending ? (
            <div style={{ background: "#f4f4f2", color: "#666", padding: "14px 16px", borderRadius: 8, fontSize: 13.5 }}>
              This add-on is still being reviewed by our office. We'll send you a new link once it's ready to sign.
            </div>
          ) : (
            <div>
              {error && <p style={{ color: "#c0392b", fontSize: 12.5, marginBottom: 8 }}>{error}</p>}
              <label style={{ fontSize: 11.5, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Type your full name to approve & e-sign this add-on</label>
              <input
                value={signerName} onChange={e => setSignerName(e.target.value)} placeholder="Full legal name"
                style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid #ccc", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }}
              />
              <button
                onClick={handleSign} disabled={signing}
                style={{ width: "100%", padding: "14px 18px", borderRadius: 8, background: "#111", color: "#fff", border: "none", fontSize: 14.5, fontWeight: 700, cursor: "pointer" }}
              >{signing ? "Submitting…" : `Sign & Approve — $${addon.clientPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}</button>
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
