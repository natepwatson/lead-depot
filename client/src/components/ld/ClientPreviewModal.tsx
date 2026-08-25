// v20.32.25 — "See exactly what the client will get" preview modal, used by
// both the Repair Consults panel and the Inspections+ panel. Two tabs:
//   1. Client Email — an iframe rendering the EXACT html the real send
//      function builds (same builder function, byte-for-byte).
//   2. Approval Page — the EXACT presentational component the client lands
//      on after clicking the email button (RepairQuoteBody / InspectionOrderBody),
//      fed from a fresh server-side snapshot including any disclosures/terms.
// This is read-only and safe to open at any point in a consult/order's life —
// it never mutates state, sends anything, or requires a token to exist yet.
import { useEffect, useState } from "react";
import { Loader2, X, Mail, FileText } from "lucide-react";
import { RepairQuoteBody, type QuoteData } from "../../pages/RepairQuotePage";
import { InspectionOrderBody, type OrderData } from "../../pages/InspectionOrderPage";

type Kind = "repair" | "inspection";

type RepairPreview = QuoteData & { emailHtml: string; emailSubject: string };
type InspectionPreview = OrderData & { emailHtml: string; emailSubject: string };

export function ClientPreviewModal({ kind, id, title, onClose }: { kind: Kind; id: number; title: string; onClose: () => void }) {
  const [tab, setTab] = useState<"email" | "page">("email");
  const [data, setData] = useState<RepairPreview | InspectionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const url = kind === "repair" ? `/api/repair-consult/${id}/preview` : `/api/inspection-orders/${id}/preview`;
    setLoading(true); setError("");
    fetch(url, { credentials: "include" })
      .then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b?.error || "Failed to build preview"); return b; })
      .then(setData)
      .catch(e => setError(e.message || "Failed to build preview"))
      .finally(() => setLoading(false));
  }, [kind, id]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#0f172a", borderRadius: 12, width: "100%", maxWidth: 720, maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#e5e7eb" }}>{title}</p>
            <p style={{ margin: "2px 0 0", fontSize: 11, color: "#64748b" }}>Preview only — nothing here is sent to the client</p>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ display: "flex", gap: 6, padding: "10px 18px 0" }}>
          <button onClick={() => setTab("email")}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: "8px 8px 0 0", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, background: tab === "email" ? "#1e293b" : "transparent", color: tab === "email" ? "#e5e7eb" : "#64748b" }}>
            <Mail size={13} /> Client Email
          </button>
          <button onClick={() => setTab("page")}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: "8px 8px 0 0", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, background: tab === "page" ? "#1e293b" : "transparent", color: tab === "page" ? "#e5e7eb" : "#64748b" }}>
            <FileText size={13} /> Approval Page{kind === "repair" ? " & Disclosures" : ""}
          </button>
        </div>

        <div style={{ flex: 1, background: "#1e293b", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {loading ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Loader2 size={22} className="animate-spin" style={{ color: "#94a3b8" }} />
            </div>
          ) : error ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
              <p style={{ color: "#f87171", fontSize: 13 }}>{error}</p>
            </div>
          ) : !data ? null : tab === "email" ? (
            <>
              <div style={{ padding: "10px 18px", fontSize: 11.5, color: "#94a3b8", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                Subject: <span style={{ color: "#e5e7eb" }}>{data.emailSubject}</span>
                {kind === "repair" && (
                  <div style={{ marginTop: 4, color: "#64748b" }}>The signature-ready Repair & Renovation Agreement PDF (Terms &amp; signature page) is attached to the real email.</div>
                )}
              </div>
              <iframe title="Email preview" srcDoc={data.emailHtml} style={{ flex: 1, width: "100%", border: "none", background: "#fff" }} />
            </>
          ) : (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {kind === "repair" ? (
                <RepairQuoteBody data={data as RepairPreview} effectiveStatus={(data as RepairPreview).consult.status} previewMode />
              ) : (
                <InspectionOrderBody data={data as InspectionPreview} previewMode />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
