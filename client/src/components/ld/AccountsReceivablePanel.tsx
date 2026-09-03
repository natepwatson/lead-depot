// v20.33.4 — Accounts Receivable admin tab. Unions repair_consults +
// inspection_orders (the two payment_records source types) into a single
// aging receivables ledger so Alex/Nate/Denise can see every outstanding
// balance across both product lines in one place, and record payments
// directly against them via the existing generic PaymentRecordModal.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCw, DollarSign, Wrench, ClipboardCheck, CreditCard, FileText, ListChecks, Receipt } from "lucide-react";
import { PaymentRecordModal } from "./PaymentRecordModal";
import { PdfViewerModal } from "./PdfViewerModal";

const GOLD = "#c8aa5a";

type ArRow = {
  source_type: "repair_consult" | "inspection_order";
  source_id: number;
  property_address: string;
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  agent_name: string | null;
  status: string;
  total: number;
  paid: number;
  balance: number;
  reference_date: string | null;
  completed_at: string | null;
};

const actionBtnStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 6,
  fontSize: 11, fontWeight: 600, background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.12)", color: "#c7d1dd", cursor: "pointer",
};

function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function agingBadge(days: number | null) {
  if (days === null) return { label: "—", color: "#94a3b8", bg: "rgba(148,163,184,0.08)", border: "rgba(148,163,184,0.3)" };
  if (days <= 7) return { label: `${days}d`, color: "#4ade80", bg: "rgba(74,222,128,0.08)", border: "rgba(74,222,128,0.3)" };
  if (days <= 14) return { label: `${days}d`, color: "#facc15", bg: "rgba(250,204,21,0.08)", border: "rgba(250,204,21,0.3)" };
  if (days <= 30) return { label: `${days}d`, color: "#fb923c", bg: "rgba(251,146,60,0.08)", border: "rgba(251,146,60,0.3)" };
  return { label: `${days}d`, color: "#f87171", bg: "rgba(248,113,113,0.08)", border: "rgba(248,113,113,0.3)" };
}

const money = (n: number) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

export function AccountsReceivablePanel() {
  const [outstanding, setOutstanding] = useState<ArRow[]>([]);
  const [paidInFull, setPaidInFull] = useState<ArRow[]>([]);
  const [totals, setTotals] = useState({ totalOutstanding: 0, totalCollected: 0, countOutstanding: 0 });
  const [loading, setLoading] = useState(true);
  const [showPaidInFull, setShowPaidInFull] = useState(false);
  const [payModalFor, setPayModalFor] = useState<ArRow | null>(null);
  // v20.52.0 — Generate Invoice: pick With Scope (full itemized punch list,
  // no per-line pricing) vs Summary Only (just the payment totals) before
  // opening the PDF. invoiceChoiceFor drives the small chooser dialog;
  // invoicePdfUrl/invoicePdfTitle drive the actual PdfViewerModal once a
  // mode is picked.
  const [invoiceChoiceFor, setInvoiceChoiceFor] = useState<ArRow | null>(null);
  const [invoicePdf, setInvoicePdf] = useState<{ url: string; title: string } | null>(null);

  const openInvoice = (row: ArRow, mode: "with_scope" | "summary") => {
    setInvoiceChoiceFor(null);
    setInvoicePdf({
      url: `/api/repair-consult/${row.source_id}/quote-pdf?mode=${mode}`,
      title: `${row.property_address} — ${mode === "summary" ? "Invoice (Summary)" : "Invoice (With Scope)"}`,
    });
  };

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/accounts-receivable", { credentials: "include" });
      const d = await r.json();
      setOutstanding(d.outstanding || []);
      setPaidInFull(d.paidInFull || []);
      setTotals(d.totals || { totalOutstanding: 0, totalCollected: 0, countOutstanding: 0 });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const rows = showPaidInFull ? paidInFull : outstanding;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb", display: "flex", alignItems: "center", gap: 6 }}>
          <DollarSign size={13} color={GOLD} /> Accounts Receivable
        </h3>
        <button onClick={load} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
          color: "#94a3b8", fontSize: 11, cursor: "pointer",
        }}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Every signed Repair Proposal and Inspection Order with money owed, across both product lines. Balances update
        automatically as payments are recorded in the Consults / Inspections tabs or right here.
      </p>

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
        <div style={{ border: "1px solid rgba(248,113,113,0.3)", borderRadius: 8, padding: 12, background: "rgba(248,113,113,0.05)" }}>
          <div style={{ fontSize: 10.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Total Outstanding</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#f87171" }}>{money(totals.totalOutstanding)}</div>
        </div>
        <div style={{ border: "1px solid rgba(74,222,128,0.3)", borderRadius: 8, padding: 12, background: "rgba(74,222,128,0.05)" }}>
          <div style={{ fontSize: 10.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Total Collected</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#4ade80" }}>{money(totals.totalCollected)}</div>
        </div>
        <div style={{ border: "1px solid rgba(200,170,90,0.3)", borderRadius: 8, padding: 12, background: "rgba(200,170,90,0.05)" }}>
          <div style={{ fontSize: 10.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Open Balances</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: GOLD }}>{totals.countOutstanding}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <button onClick={() => setShowPaidInFull(false)} style={{
          ...actionBtnStyle,
          background: !showPaidInFull ? "rgba(200,170,90,0.12)" : actionBtnStyle.background,
          borderColor: !showPaidInFull ? "rgba(200,170,90,0.4)" : actionBtnStyle.border as string,
          color: !showPaidInFull ? GOLD : actionBtnStyle.color,
        }}>Outstanding ({outstanding.length})</button>
        <button onClick={() => setShowPaidInFull(true)} style={{
          ...actionBtnStyle,
          background: showPaidInFull ? "rgba(200,170,90,0.12)" : actionBtnStyle.background,
          borderColor: showPaidInFull ? "rgba(200,170,90,0.4)" : actionBtnStyle.border as string,
          color: showPaidInFull ? GOLD : actionBtnStyle.color,
        }}>Paid in Full ({paidInFull.length})</button>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading receivables…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>
          {showPaidInFull ? "No fully-paid jobs yet." : "No outstanding balances right now — every signed job is paid in full."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map(r => {
            const days = daysSince(r.reference_date);
            const aging = agingBadge(days);
            const jobLabel = r.source_type === "inspection_order" ? "Inspection Order" : "Repair Proposal";
            const JobIcon = r.source_type === "inspection_order" ? ClipboardCheck : Wrench;
            return (
              <div key={`${r.source_type}-${r.source_id}`} style={{
                border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12,
                background: "rgba(255,255,255,0.02)",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb", display: "flex", alignItems: "center", gap: 6 }}>
                      <JobIcon size={12} color={GOLD} /> {r.property_address}
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                      {r.client_name || "—"} · Agent: {r.agent_name || "—"} · {jobLabel}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <span style={{
                      fontSize: 10.5, padding: "3px 8px", borderRadius: 4, textTransform: "capitalize",
                      color: "#e8d8a8", background: "rgba(200,170,90,0.10)", border: "1px solid rgba(200,170,90,0.35)",
                    }}>{r.status.replace(/_/g, " ")}</span>
                    {!showPaidInFull && (
                      <span style={{
                        fontSize: 10.5, padding: "3px 8px", borderRadius: 4,
                        color: aging.color, background: aging.bg, border: `1px solid ${aging.border}`,
                      }}>{aging.label} outstanding</span>
                    )}
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 10, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3 }}>Total</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#c7d1dd" }}>{money(r.total)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3 }}>Paid</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#4ade80" }}>{money(r.paid)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3 }}>Balance</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: r.balance > 0 ? "#f87171" : "#4ade80" }}>{money(r.balance)}</div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {r.source_type === "repair_consult" && (
                    <button onClick={() => setInvoiceChoiceFor(r)} style={actionBtnStyle}>
                      <FileText size={11} /> Generate Invoice
                    </button>
                  )}
                  {r.balance > 0 && (
                    <button onClick={() => setPayModalFor(r)} style={{
                      ...actionBtnStyle, color: "#4ade80", borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.08)",
                    }}><CreditCard size={11} /> Record Payment</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {payModalFor && (
        <PaymentRecordModal
          sourceType={payModalFor.source_type}
          sourceId={payModalFor.source_id}
          propertyAddress={payModalFor.property_address}
          contractTotal={payModalFor.total}
          balanceRemaining={payModalFor.balance}
          onClose={() => setPayModalFor(null)}
          onRecorded={() => { setPayModalFor(null); load(); }}
        />
      )}

      {/* v20.52.0 — With Scope vs Summary Only chooser, shown before the PDF
          is generated so we never need two separate buttons on this row. */}
      {invoiceChoiceFor && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          role="dialog"
          aria-modal="true"
          onClick={() => setInvoiceChoiceFor(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "#171512", border: "1px solid rgba(200,170,90,0.3)", borderRadius: 10, padding: 20, maxWidth: 380, width: "100%" }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: "#e5e7eb", marginBottom: 4 }}>Generate Invoice</div>
            <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 16 }}>{invoiceChoiceFor.property_address}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                onClick={() => openInvoice(invoiceChoiceFor, "with_scope")}
                style={{ ...actionBtnStyle, justifyContent: "flex-start", padding: "10px 12px", width: "100%" }}
              >
                <ListChecks size={13} color={GOLD} />
                <span>
                  <div style={{ fontWeight: 700 }}>With Scope</div>
                  <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 400 }}>Full itemized work scope + payment totals</div>
                </span>
              </button>
              <button
                onClick={() => openInvoice(invoiceChoiceFor, "summary")}
                style={{ ...actionBtnStyle, justifyContent: "flex-start", padding: "10px 12px", width: "100%" }}
              >
                <Receipt size={13} color={GOLD} />
                <span>
                  <div style={{ fontWeight: 700 }}>Summary Only</div>
                  <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 400 }}>Just the payment totals — no itemized scope</div>
                </span>
              </button>
            </div>
            <button
              onClick={() => setInvoiceChoiceFor(null)}
              style={{ marginTop: 14, fontSize: 11, color: "#94a3b8", background: "none", border: "none", cursor: "pointer", width: "100%" }}
            >Cancel</button>
          </div>
        </div>
      )}

      {invoicePdf && (
        <PdfViewerModal url={invoicePdf.url} title={invoicePdf.title} onClose={() => setInvoicePdf(null)} />
      )}
    </div>
  );
}
