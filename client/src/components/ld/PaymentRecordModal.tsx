// v20.32.13 — Part 7: Record Payment flow. Restricted (server-enforced) to
// Alex, Nate, and Denise. Manual/person-to-person rails only — no processor.
// Captures amount + method + evidence photo (cash/check photo or digital
// confirmation screenshot) + two typed signatures (Company Rep + Client) on
// the Payment Received line, then a photo of that signed line as the receipt.
import { useEffect, useRef, useState } from "react";

const GOLD = "#c8aa5a";

// v20.32.16 — Alex's confirmed accepted-payment list is Cash, Wire, Check,
// Money Order, Venmo, Zelle, Apple Pay. Cash App was never on that list and
// Money Order was missing entirely — swapped to match exactly.
const METHOD_LABELS: Record<string, string> = {
  check: "Check", wire: "Wire", zelle: "Zelle", money_order: "Money Order",
  apple_pay: "Apple Pay", venmo: "Venmo", cash: "Cash",
};
const METHODS = Object.keys(METHOD_LABELS);

type Agent = { id: number; name: string; email: string };

async function fileToImageData(file: File): Promise<{ imageData: string; mimeType: string } | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as any);
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const [meta, imageData] = dataUrl.split(",");
    const mimeType = meta.match(/:(.*?);/)?.[1] ?? "image/jpeg";
    return { imageData, mimeType };
  } catch {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        const [meta, imageData] = dataUrl.split(",");
        resolve({ imageData, mimeType: meta.match(/:(.*?);/)?.[1] ?? "image/jpeg" });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }
}

const PAY_AUTH_EMAILS = ["alex@watsonbrothersgroup.com", "nate@watsonbrothersgroup.com", "denise@watsonbrothersgroup.com"];

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, fontSize: 13,
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.14)", color: "#e6e6e6",
};
const labelStyle: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 4, display: "block" };

export function PaymentRecordModal({
  sourceType, sourceId, propertyAddress, contractTotal, balanceRemaining, onClose, onRecorded,
}: {
  sourceType: "repair_consult" | "inspection_order";
  sourceId: number;
  propertyAddress: string;
  contractTotal: number;
  balanceRemaining: number;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [liveBalance, setLiveBalance] = useState(balanceRemaining);
  const [priorPayments, setPriorPayments] = useState<Array<{ id: number; amount: number; method: string; recorded_at: string }>>([]);
  const [amount, setAmount] = useState(String(balanceRemaining || contractTotal || ""));
  const [method, setMethod] = useState("cash");
  const [referenceNote, setReferenceNote] = useState("");
  const [companyRepAgentId, setCompanyRepAgentId] = useState<number | "">("");
  const [companyRepSignatureName, setCompanyRepSignatureName] = useState("");
  const [clientSignatureName, setClientSignatureName] = useState("");
  const [evidencePhotoUrl, setEvidencePhotoUrl] = useState<string | null>(null);
  const [receiptPhotoUrl, setReceiptPhotoUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [uploadingKind, setUploadingKind] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // v20.33.3 — Part 7: show the confirmation # before closing instead of
  // silently vanishing, so the person recording the payment (and the client,
  // via the emailed receipt) both have a durable reference number.
  const [successInfo, setSuccessInfo] = useState<{ confirmationNumber: string; amount: number } | null>(null);
  const evidenceInputRef = useRef<HTMLInputElement>(null);
  const receiptInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/agents", { credentials: "include" }).then(r => r.json()).then((all: Agent[]) => {
      setAgents((all || []).filter(a => PAY_AUTH_EMAILS.includes((a.email || "").toLowerCase().trim())));
    }).catch(() => {});
    // Refresh the actual balance (sum of prior payment_records) so a stale
    // caller-passed value never under/overstates what's really left owed.
    fetch(`/api/payments?sourceType=${sourceType}&sourceId=${sourceId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        if (typeof d.balanceRemaining === "number") {
          setLiveBalance(d.balanceRemaining);
          setAmount(String(d.balanceRemaining || contractTotal || ""));
        }
        if (Array.isArray(d.payments)) setPriorPayments(d.payments);
      }).catch(() => {});
  }, []);

  async function handleUpload(file: File, kind: "evidence" | "receipt") {
    setUploadingKind(kind);
    setError("");
    try {
      const conv = await fileToImageData(file);
      if (!conv) throw new Error("Could not read photo");
      const r = await fetch("/api/payments/photo", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: conv.imageData, mimeType: conv.mimeType, kind }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Upload failed");
      if (kind === "evidence") setEvidencePhotoUrl(data.url); else setReceiptPhotoUrl(data.url);
    } catch (e: any) {
      setError(e.message || "Photo upload failed");
    } finally {
      setUploadingKind(null);
    }
  }

  async function submit() {
    setError("");
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return setError("Enter a valid amount.");
    if (!companyRepAgentId) return setError("Select the Company Representative.");
    if (!companyRepSignatureName.trim()) return setError("Company Representative signature is required.");
    if (!clientSignatureName.trim()) return setError("Client signature is required.");
    if (!evidencePhotoUrl) return setError(`Upload evidence: ${method === "cash" ? "a photo of the cash" : method === "check" ? "a photo of the check" : method === "money_order" ? "a photo of the money order" : "a screenshot of the confirmation"}.`);
    if (!receiptPhotoUrl) return setError("Upload a photo of the fully-signed Payment Received line.");
    setSaving(true);
    try {
      const r = await fetch("/api/payments", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType, sourceId, amount: amt, method, referenceNote: referenceNote || null,
          evidencePhotoUrl, receiptPhotoUrl, companyRepAgentId, companyRepSignatureName, clientSignatureName,
          notes: notes || null,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed to record payment");
      onRecorded();
      setSuccessInfo({ confirmationNumber: data.confirmationNumber || "", amount: amt });
    } catch (e: any) {
      setError(e.message || "Failed to record payment");
    } finally {
      setSaving(false);
    }
  }

  const evidenceLabel = method === "cash" ? "Photo of the cash" : method === "check" ? "Photo of the check" : method === "money_order" ? "Photo of the money order" : "Screenshot of the confirmation";

  if (successInfo) {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
        <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 420, background: "#141414", border: "1px solid rgba(74,222,128,0.35)", borderRadius: 12, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <h3 style={{ margin: 0, marginBottom: 6, fontSize: 16, fontWeight: 700, color: "#4ade80" }}>Payment Recorded</h3>
          <p style={{ margin: 0, marginBottom: 14, fontSize: 12.5, color: "#94a3b8" }}>{propertyAddress}</p>
          <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: 14, marginBottom: 16 }}>
            <p style={{ margin: 0, marginBottom: 4, fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.3, textTransform: "uppercase" }}>Confirmation Number</p>
            <p style={{ margin: 0, marginBottom: 10, fontSize: 20, fontWeight: 800, color: GOLD, fontFamily: "monospace" }}>{successInfo.confirmationNumber || "—"}</p>
            <p style={{ margin: 0, fontSize: 13, color: "#c7d1dd" }}>Amount recorded: <strong style={{ color: "#4ade80" }}>${successInfo.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></p>
          </div>
          <p style={{ margin: 0, marginBottom: 16, fontSize: 11.5, color: "#94a3b8" }}>A receipt with this confirmation number has been emailed to the client and CC'd to the team.</p>
          <button onClick={onClose} style={{ width: "100%", padding: "10px 16px", borderRadius: 6, fontSize: 13, fontWeight: 700, background: GOLD, border: "none", color: "#141414", cursor: "pointer" }}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto", background: "#141414", border: "1px solid rgba(200,170,90,0.3)", borderRadius: 12, padding: 20 }}>
        <h3 style={{ margin: 0, marginBottom: 4, fontSize: 16, fontWeight: 700, color: GOLD }}>Record Payment</h3>
        <p style={{ margin: 0, marginBottom: 10, fontSize: 12, color: "#94a3b8" }}>{propertyAddress} · Balance remaining: ${liveBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })} of ${contractTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>

        {priorPayments.length > 0 && (
          <div style={{ marginBottom: 14, padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <p style={{ margin: 0, marginBottom: 6, fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.3, textTransform: "uppercase" }}>Payment History</p>
            {priorPayments.map(p => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#c7d1dd", padding: "2px 0" }}>
                <span>{METHOD_LABELS[p.method] || p.method} — {new Date(p.recorded_at).toLocaleDateString()}</span>
                <span style={{ color: "#4ade80", fontWeight: 600 }}>${p.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={labelStyle}>Amount</label>
            <input style={inputStyle} type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Method</label>
            <select style={inputStyle} value={method} onChange={e => setMethod(e.target.value)}>
              {METHODS.map(m => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Reference Note (check #, confirmation #, txn ID — optional)</label>
          <input style={inputStyle} value={referenceNote} onChange={e => setReferenceNote(e.target.value)} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Company Representative (must be Alex, Nate, or Denise)</label>
          <select style={inputStyle} value={companyRepAgentId} onChange={e => setCompanyRepAgentId(e.target.value ? parseInt(e.target.value) : "")}>
            <option value="">Select...</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>

        <div style={{ border: "1px solid rgba(200,170,90,0.25)", borderRadius: 8, padding: 12, marginBottom: 12, background: "rgba(200,170,90,0.04)" }}>
          <p style={{ margin: 0, marginBottom: 8, fontSize: 11, fontWeight: 700, color: GOLD, letterSpacing: 0.3, textTransform: "uppercase" }}>Payment Received — Signatures</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelStyle}>Company Rep Signature (type name)</label>
              <input style={inputStyle} placeholder="Full name" value={companyRepSignatureName} onChange={e => setCompanyRepSignatureName(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Client Signature (type name)</label>
              <input style={inputStyle} placeholder="Full name" value={clientSignatureName} onChange={e => setClientSignatureName(e.target.value)} />
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>{evidenceLabel}</label>
            <input ref={evidenceInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
              onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0], "evidence")} />
            <button type="button" onClick={() => evidenceInputRef.current?.click()} disabled={uploadingKind === "evidence"}
              style={{ ...inputStyle, textAlign: "left", cursor: "pointer", color: evidencePhotoUrl ? "#4ade80" : "#94a3b8" }}>
              {uploadingKind === "evidence" ? "Uploading..." : evidencePhotoUrl ? "✓ Photo attached" : "Tap to add photo"}
            </button>
          </div>
          <div>
            <label style={labelStyle}>Photo of signed Payment Received line</label>
            <input ref={receiptInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
              onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0], "receipt")} />
            <button type="button" onClick={() => receiptInputRef.current?.click()} disabled={uploadingKind === "receipt"}
              style={{ ...inputStyle, textAlign: "left", cursor: "pointer", color: receiptPhotoUrl ? "#4ade80" : "#94a3b8" }}>
              {uploadingKind === "receipt" ? "Uploading..." : receiptPhotoUrl ? "✓ Photo attached" : "Tap to add photo"}
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Notes (optional)</label>
          <textarea style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        {error && <p style={{ color: "#f87171", fontSize: 12, marginBottom: 10 }}>{error}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 6, fontSize: 12.5, fontWeight: 600, background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "#94a3b8", cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: "8px 16px", borderRadius: 6, fontSize: 12.5, fontWeight: 700, background: GOLD, border: "none", color: "#141414", cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Recording..." : "Record Payment"}
          </button>
        </div>
      </div>
    </div>
  );
}
