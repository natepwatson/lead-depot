// v20.41.0 — Labor Calculator: Phase 2 of the Scheduler/Labor/Calendar build.
// One tab per in-house trade actually present on this job's scope (pulled
// live from repair_consult_items on the backend). Each tab is assigned
// 1+ approved/active laborers with estimated hours and saved
// independently — persists across closing/reopening the modal. Once every
// in-scope tab is saved, "Approve Labor Order" unlocks; approving locks
// further edits here (Phase 3 will build the approved-vs-actual editing
// flow and the P&L/work-order-email hookup — this modal only owns the
// draft-and-approve mechanics).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X, CheckCircle2 } from "lucide-react";
import { TRADE_LABELS } from "../../lib/tradeLabels";

const GOLD = "#c8aa5a";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, fontSize: 13,
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.14)", color: "#e6e6e6",
};
const labelStyle: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 4, display: "block" };

type Laborer = { id: number; name: string; tier: string; hourly_rate: number; trades: string | null };
type Assignment = { id?: number; laborer_id: number; estimated_hours: number; hourly_rate_snapshot?: number; laborer_name?: string; laborer_tier?: string; laborer_active?: number };
type TradeTab = { trade: string; inScope: boolean; saved: boolean; notes: string | null; laborOrderTradeId: number | null; assignments: Assignment[] };

const TIER_LABELS: Record<string, string> = { tier_1: "Tier 1 ($16/hr)", tier_2: "Tier 2 ($20/hr)", tier_3: "Tier 3 ($25/hr)" };

export function LaborCalculatorModal({ consultId, propertyAddress, onClose }: { consultId: number; propertyAddress: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [orderStatus, setOrderStatus] = useState<{ status: string; approvedAt: string | null; approvedBy: string | null }>({ status: "draft", approvedAt: null, approvedBy: null });
  const [trades, setTrades] = useState<TradeTab[]>([]);
  const [allTabsSaved, setAllTabsSaved] = useState(false);
  const [laborers, setLaborers] = useState<Laborer[]>([]);
  const [activeTrade, setActiveTrade] = useState<string | null>(null);
  const [draftRows, setDraftRows] = useState<Record<string, Array<{ laborerId: string; hours: string }>>>({});
  const [savingTrade, setSavingTrade] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [deletingTrade, setDeletingTrade] = useState<string | null>(null);
  const [unapproving, setUnapproving] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  const load = () => {
    setLoading(true);
    fetch(`/api/admin/repair-consult/${consultId}/labor-order`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        setOrderStatus(d.laborOrder);
        setTrades(d.trades || []);
        setAllTabsSaved(!!d.allTabsSaved);
        setLaborers(d.laborers || []);
        const nextDrafts: typeof draftRows = {};
        for (const t of (d.trades || []) as TradeTab[]) {
          nextDrafts[t.trade] = t.assignments.length > 0
            ? t.assignments.map(a => ({ laborerId: String(a.laborer_id), hours: String(a.estimated_hours) }))
            : [{ laborerId: "", hours: "" }];
        }
        setDraftRows(nextDrafts);
        if (!activeTrade && (d.trades || []).length > 0) setActiveTrade(d.trades[0].trade);
      })
      .catch(() => setError("Could not load the labor order."))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [consultId]);

  const isApproved = orderStatus.status === "approved";

  function addRow(trade: string) {
    setDraftRows(prev => ({ ...prev, [trade]: [...(prev[trade] || []), { laborerId: "", hours: "" }] }));
  }
  function removeRow(trade: string, idx: number) {
    setDraftRows(prev => ({ ...prev, [trade]: (prev[trade] || []).filter((_, i) => i !== idx) }));
  }
  function updateRow(trade: string, idx: number, field: "laborerId" | "hours", value: string) {
    setDraftRows(prev => ({
      ...prev,
      [trade]: (prev[trade] || []).map((r, i) => (i === idx ? { ...r, [field]: value } : r)),
    }));
  }

  async function saveTrade(trade: string) {
    setSavingTrade(trade);
    setError("");
    try {
      const rows = (draftRows[trade] || []).filter(r => r.laborerId && r.hours);
      if (rows.length === 0) throw new Error("Add at least one laborer with hours before saving this trade.");
      const assignments = rows.map(r => ({ laborerId: Number(r.laborerId), estimatedHours: Number(r.hours) }));
      const r = await fetch(`/api/admin/repair-consult/${consultId}/labor-order/trades/${trade}`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "Failed to save");
      load();
    } catch (e: any) {
      setError(e.message || "Failed to save");
    } finally {
      setSavingTrade(null);
    }
  }

  async function deleteTrade(trade: string) {
    if (!window.confirm(`Delete the saved "${TRADE_LABELS[trade] || trade}" trade tab? This clears its laborer assignments and cannot be undone.`)) return;
    setDeletingTrade(trade);
    setError("");
    try {
      const r = await fetch(`/api/admin/repair-consult/${consultId}/labor-order/trades/${trade}`, {
        method: "DELETE", credentials: "include",
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "Failed to delete");
      load();
    } catch (e: any) {
      setError(e.message || "Failed to delete");
    } finally {
      setDeletingTrade(null);
    }
  }

  async function deleteAllTrades() {
    const savedCount = trades.filter(t => t.saved).length;
    if (savedCount === 0) return;
    if (!window.confirm(`Delete ALL ${savedCount} saved trade tab(s) on this labor order? This clears every laborer assignment on this job and cannot be undone.`)) return;
    setDeletingAll(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/repair-consult/${consultId}/labor-order/trades`, {
        method: "DELETE", credentials: "include",
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "Failed to delete all trades");
      load();
    } catch (e: any) {
      setError(e.message || "Failed to delete all trades");
    } finally {
      setDeletingAll(false);
    }
  }

  async function unapproveOrder() {
    if (!window.confirm("Undo approval on this labor order? It will go back to Draft so trades can be edited or deleted again.")) return;
    setUnapproving(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/repair-consult/${consultId}/labor-order/unapprove`, { method: "POST", credentials: "include" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "Failed to undo approval");
      load();
    } catch (e: any) {
      setError(e.message || "Failed to undo approval");
    } finally {
      setUnapproving(false);
    }
  }

  async function approveOrder() {
    setApproving(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/repair-consult/${consultId}/labor-order/approve`, { method: "POST", credentials: "include" });
      const body = await r.json();
      if (!r.ok) {
        const missing = (body.missingTrades || []).map((t: string) => TRADE_LABELS[t] || t).join(", ");
        throw new Error(missing ? `${body.error} Missing: ${missing}` : (body.error || "Failed to approve"));
      }
      load();
    } catch (e: any) {
      setError(e.message || "Failed to approve");
    } finally {
      setApproving(false);
    }
  }

  function rowCost(trade: string): number {
    return (draftRows[trade] || []).reduce((sum, r) => {
      const laborer = laborers.find(l => String(l.id) === r.laborerId);
      const hours = Number(r.hours) || 0;
      return sum + (laborer ? laborer.hourly_rate * hours : 0);
    }, 0);
  }

  const scopeTrades = trades.filter(t => t.inScope);
  const outOfScopeTrades = trades.filter(t => !t.inScope);

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 760, maxHeight: "90vh", overflowY: "auto", background: "#141414", border: "1px solid rgba(200,170,90,0.3)", borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: GOLD }}>Labor Calculator</h3>
            <p style={{ margin: 0, marginTop: 2, fontSize: 12, color: "#94a3b8" }}>{propertyAddress}</p>
          </div>
          <span style={{
            fontSize: 10.5, fontWeight: 700, padding: "3px 10px", borderRadius: 20, textTransform: "uppercase", letterSpacing: 0.4,
            color: isApproved ? "#4ade80" : "#facc15",
            background: isApproved ? "rgba(74,222,128,0.12)" : "rgba(250,204,21,0.1)",
            border: `1px solid ${isApproved ? "rgba(74,222,128,0.4)" : "rgba(250,204,21,0.4)"}`,
          }}>
            {isApproved ? "Approved" : "Draft"}
          </span>
        </div>
        {isApproved && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, margin: "6px 0 14px" }}>
            <p style={{ margin: 0, fontSize: 11.5, color: "#4ade80" }}>
              Approved by {orderStatus.approvedBy} on {orderStatus.approvedAt ? new Date(orderStatus.approvedAt).toLocaleString() : ""}. Trade assignments are locked.
            </p>
            <button onClick={unapproveOrder} disabled={unapproving}
              style={{ flexShrink: 0, padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "transparent", border: "1px solid rgba(248,113,113,0.4)", color: "#f87171", cursor: unapproving ? "default" : "pointer", opacity: unapproving ? 0.6 : 1 }}>
              {unapproving ? "Undoing..." : "Undo Approval"}
            </button>
          </div>
        )}

        {loading ? (
          <p style={{ fontSize: 12, color: "#94a3b8" }}>Loading...</p>
        ) : scopeTrades.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "#f87171" }}>This job has no in-house scope items — nothing to assign labor for.</p>
        ) : (
          <>
            {/* Trade tabs */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14, borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: 10 }}>
              {scopeTrades.map(t => (
                <button key={t.trade} onClick={() => setActiveTrade(t.trade)}
                  style={{
                    padding: "6px 12px", borderRadius: 20, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                    border: `1px solid ${activeTrade === t.trade ? GOLD : "rgba(255,255,255,0.14)"}`,
                    background: activeTrade === t.trade ? "rgba(200,170,90,0.14)" : "rgba(255,255,255,0.03)",
                    color: activeTrade === t.trade ? GOLD : "#cbd5e1",
                    display: "flex", alignItems: "center", gap: 5,
                  }}>
                  {t.saved && <CheckCircle2 size={11} color="#4ade80" />}
                  {TRADE_LABELS[t.trade] || t.trade}
                </button>
              ))}
            </div>

            {/* Active tab */}
            {activeTrade && scopeTrades.find(t => t.trade === activeTrade) && (
              <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 14, marginBottom: 14, background: "rgba(255,255,255,0.02)" }}>
                <p style={{ margin: 0, marginBottom: 10, fontSize: 13, fontWeight: 700, color: "#e5e7eb" }}>{TRADE_LABELS[activeTrade] || activeTrade}</p>

                {(draftRows[activeTrade] || []).map((row, idx) => {
                  const laborer = laborers.find(l => String(l.id) === row.laborerId);
                  return (
                    <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px 28px", gap: 8, marginBottom: 8, alignItems: "end" }}>
                      <div>
                        {idx === 0 && <label style={labelStyle}>Laborer</label>}
                        <select disabled={isApproved} style={inputStyle} value={row.laborerId} onChange={e => updateRow(activeTrade, idx, "laborerId", e.target.value)}>
                          <option value="">Select laborer...</option>
                          {laborers.map(l => <option key={l.id} value={l.id}>{l.name} — {TIER_LABELS[l.tier] || l.tier}</option>)}
                        </select>
                      </div>
                      <div>
                        {idx === 0 && <label style={labelStyle}>Est. Hours</label>}
                        <input disabled={isApproved} style={inputStyle} type="number" min="0" step="0.25" placeholder="0" value={row.hours} onChange={e => updateRow(activeTrade, idx, "hours", e.target.value)} />
                      </div>
                      <div style={{ fontSize: 11.5, color: "#94a3b8", paddingBottom: 8 }}>
                        {laborer && row.hours ? `$${(laborer.hourly_rate * Number(row.hours || 0)).toFixed(2)}` : ""}
                      </div>
                      <div>
                        {!isApproved && (draftRows[activeTrade] || []).length > 1 && (
                          <button onClick={() => removeRow(activeTrade, idx)} style={{ background: "transparent", border: "none", color: "#f87171", cursor: "pointer", padding: 6 }}><X size={14} /></button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {!isApproved && (
                  <button onClick={() => addRow(activeTrade)} style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "1px dashed rgba(255,255,255,0.2)", borderRadius: 6, color: "#93c5fd", fontSize: 11.5, padding: "5px 10px", cursor: "pointer", marginBottom: 10 }}>
                    <Plus size={12} /> Add laborer
                  </button>
                )}

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: "#94a3b8" }}>Estimated cost: <span style={{ color: GOLD }}>${rowCost(activeTrade).toFixed(2)}</span></span>
                  {!isApproved && (
                    <div style={{ display: "flex", gap: 8 }}>
                      {scopeTrades.find(t => t.trade === activeTrade)?.saved && (
                        <button onClick={() => deleteTrade(activeTrade)} disabled={deletingTrade === activeTrade}
                          style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: "transparent", border: "1px solid rgba(248,113,113,0.4)", color: "#f87171", cursor: deletingTrade === activeTrade ? "default" : "pointer", opacity: deletingTrade === activeTrade ? 0.6 : 1 }}>
                          {deletingTrade === activeTrade ? "Deleting..." : "Delete Trade"}
                        </button>
                      )}
                      <button onClick={() => saveTrade(activeTrade)} disabled={savingTrade === activeTrade}
                        style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: GOLD, border: "none", color: "#141414", cursor: savingTrade === activeTrade ? "default" : "pointer", opacity: savingTrade === activeTrade ? 0.6 : 1 }}>
                        {savingTrade === activeTrade ? "Saving..." : "Save Trade"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {outOfScopeTrades.length > 0 && (
              <p style={{ fontSize: 10.5, color: "#64748b", marginBottom: 14 }}>
                Saved but no longer in scope: {outOfScopeTrades.map(t => TRADE_LABELS[t.trade] || t.trade).join(", ")}
              </p>
            )}
          </>
        )}

        {error && <p style={{ color: "#f87171", fontSize: 12, marginBottom: 10 }}>{error}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {!isApproved && !loading && scopeTrades.length > 0 && !allTabsSaved && (
            <span style={{ fontSize: 10.5, color: "#facc15" }}>Save every trade tab before approving.</span>
          )}
          {!isApproved && !loading && trades.some(t => t.saved) && (
            <button onClick={deleteAllTrades} disabled={deletingAll}
              style={{ padding: "8px 16px", borderRadius: 6, fontSize: 12.5, fontWeight: 700, background: "transparent", border: "1px solid rgba(248,113,113,0.4)", color: "#f87171", cursor: deletingAll ? "default" : "pointer", opacity: deletingAll ? 0.6 : 1 }}>
              {deletingAll ? "Deleting All..." : "Delete All Labor"}
            </button>
          )}
          <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 6, fontSize: 12.5, fontWeight: 600, background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "#94a3b8", cursor: "pointer" }}>Close</button>
          {!isApproved && scopeTrades.length > 0 && (
            <button onClick={approveOrder} disabled={!allTabsSaved || approving}
              style={{ padding: "8px 16px", borderRadius: 6, fontSize: 12.5, fontWeight: 700, background: allTabsSaved ? "#4ade80" : "rgba(74,222,128,0.25)", border: "none", color: "#0a0a0a", cursor: allTabsSaved && !approving ? "pointer" : "default", opacity: approving ? 0.6 : 1 }}>
              {approving ? "Approving..." : "Approve Labor Order"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
