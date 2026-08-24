// v20.32.13 — Inspections+ admin: Pricing Catalog (client price + vendor cost,
// admin-editable per Alex's requirement) + Orders Queue + Add-Ons Queue.
// Vendor contacts (Jason Brown, Pro-Spect, etc.) live in the SAME repair_vendors
// table as the Repair Program — they're just rows with trade='inspections' — so
// they already show up in Repair Program → Vendor Directory. No duplicate vendor
// UI needed here; this panel links over to that tab instead of rebuilding it.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCw, DollarSign, ClipboardList, FilePlus2, CheckCircle2, XCircle } from "lucide-react";
import { PaymentRecordModal } from "./PaymentRecordModal";

const GOLD = "#c8aa5a";

type InspectionItem = {
  id: number; key: string; name: string; client_price: number;
  vendor_cost: number | null; sequence_order: number; notes: string | null; active: number;
};

type InspectionOrder = {
  id: number; property_address: string; client_name: string; client_email: string | null;
  status: string; total: number; vendor_cost_total: number; needed_by: string; needed_by_date: string | null;
  contingency_expiration_date: string | null; agent_name: string | null; created_at: string;
};

type Addon = {
  id: number; order_id: number; name: string; client_price: number; addon_status: string;
  property_address: string; client_name: string; requested_by_name: string | null; addon_requested_at: string;
};

export function InspectionsPricingPanel() {
  const [tab, setTab] = useState<"pricing" | "orders" | "addons">("pricing");
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[
          { key: "pricing", label: "Pricing Catalog", icon: DollarSign },
          { key: "orders", label: "Orders Queue", icon: ClipboardList },
          { key: "addons", label: "Add-Ons Queue", icon: FilePlus2 },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as any)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "6px 12px", borderRadius: 6, fontSize: 11.5, fontWeight: 600,
              letterSpacing: 0.2, cursor: "pointer",
              background: tab === t.key ? "rgba(200,170,90,0.12)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${tab === t.key ? "rgba(200,170,90,0.45)" : "rgba(255,255,255,0.10)"}`,
              color: tab === t.key ? "#e8d8a8" : "#94a3b8",
            }}
          >
            <t.icon size={12} /> {t.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Vendor contacts (Jason Brown, Pro-Spect, etc.) live in <strong>Repair Program → Vendor Directory</strong> —
        same directory, filtered by trade "inspections". Every inspection is booked in the client's own name and the
        vendor is told explicitly who it's for — see the client-name callout in each order/add-on notification email.
      </p>
      {tab === "pricing" ? <PricingPanel /> : tab === "orders" ? <OrdersPanel /> : <AddonsPanel />}
    </div>
  );
}

// ── PRICING CATALOG ─────────────────────────────────────────────────────────
function PricingPanel() {
  const [items, setItems] = useState<InspectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<number, { client_price?: string; vendor_cost?: string }>>({});

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/inspection-items", { credentials: "include" });
      const d = await r.json();
      setItems(d.items || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async (item: InspectionItem) => {
    const d = draft[item.id] || {};
    const clientPrice = d.client_price !== undefined ? parseFloat(d.client_price) : item.client_price;
    const vendorCost = d.vendor_cost !== undefined ? (d.vendor_cost === "" ? null : parseFloat(d.vendor_cost)) : item.vendor_cost;
    setSaving(item.id);
    try {
      await fetch(`/api/admin/inspection-items/${item.id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientPrice, vendorCost }),
      });
      setItems(prev => prev.map(it => it.id === item.id ? { ...it, client_price: clientPrice, vendor_cost: vendorCost } : it));
      setDraft(prev => { const p = { ...prev }; delete p[item.id]; return p; });
    } finally { setSaving(null); }
  };

  const toggleActive = async (item: InspectionItem) => {
    const nextActive = item.active ? 0 : 1;
    setItems(prev => prev.map(it => it.id === item.id ? { ...it, active: nextActive } : it));
    await fetch(`/api/admin/inspection-items/${item.id}`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !!nextActive }),
    });
  };

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <h3 style={headingStyle}>Inspection Pricing Catalog</h3>
        <button onClick={load} style={refreshBtnStyle}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Client price is what the buyer is charged; vendor cost is what Brothers Group pays the inspection company.
        Both are placeholders until real itemized vendor quotes come in — margin recalculates automatically once updated.
      </p>
      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading pricing catalog…</div>
      ) : (
        <div style={{ maxHeight: 480, overflowY: "auto", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6 }}>
          <table style={{ width: "100%", fontSize: 12, color: "#c7d1dd", borderCollapse: "collapse" }}>
            <thead style={{ background: "rgba(255,255,255,0.03)", position: "sticky", top: 0 }}>
              <tr>
                <th style={thStyle("left")}>Inspection</th>
                <th style={thStyle("right")}>Client Price</th>
                <th style={thStyle("right")}>Vendor Cost</th>
                <th style={thStyle("right")}>Margin</th>
                <th style={thStyle("center")}>Active</th>
                <th style={thStyle("center")}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => {
                const d = draft[item.id] || {};
                const priceVal = d.client_price !== undefined ? d.client_price : String(item.client_price);
                const costVal = d.vendor_cost !== undefined ? d.vendor_cost : (item.vendor_cost == null ? "" : String(item.vendor_cost));
                const dirty = d.client_price !== undefined || d.vendor_cost !== undefined;
                const cp = d.client_price !== undefined ? parseFloat(d.client_price) || 0 : item.client_price;
                const vc = d.vendor_cost !== undefined ? (d.vendor_cost === "" ? null : parseFloat(d.vendor_cost)) : item.vendor_cost;
                const margin = vc == null ? null : cp - vc;
                return (
                  <tr key={item.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)", opacity: item.active ? 1 : 0.45 }}>
                    <td style={{ padding: "6px 10px", color: "#e5e7eb" }}>
                      {item.name}
                      {item.notes && <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>{item.notes}</div>}
                    </td>
                    <td style={{ padding: "4px 10px", textAlign: "right" }}>
                      <input type="number" step="0.01" value={priceVal}
                        onChange={e => setDraft(prev => ({ ...prev, [item.id]: { ...prev[item.id], client_price: e.target.value } }))}
                        style={numInputStyle} />
                    </td>
                    <td style={{ padding: "4px 10px", textAlign: "right" }}>
                      <input type="number" step="0.01" value={costVal} placeholder="TBD"
                        onChange={e => setDraft(prev => ({ ...prev, [item.id]: { ...prev[item.id], vendor_cost: e.target.value } }))}
                        style={numInputStyle} />
                    </td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: margin == null ? "#64748b" : margin >= 0 ? "#5eead4" : "#f87171" }}>
                      {margin == null ? "TBD" : `$${margin.toFixed(2)}`}
                    </td>
                    <td style={{ padding: "6px 10px", textAlign: "center" }}>
                      <input type="checkbox" checked={!!item.active} onChange={() => toggleActive(item)} />
                    </td>
                    <td style={{ padding: "6px 10px", textAlign: "center" }}>
                      <button onClick={() => save(item)} disabled={!dirty || saving === item.id} style={saveBtnStyle(dirty)}>
                        {saving === item.id ? "Saving…" : "Save"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── ORDERS QUEUE ────────────────────────────────────────────────────────────
function OrdersPanel() {
  const [orders, setOrders] = useState<InspectionOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [paymentFor, setPaymentFor] = useState<InspectionOrder | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/inspection-orders", { credentials: "include" });
      const d = await r.json();
      setOrders(d.orders || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const complete = async (o: InspectionOrder) => {
    setBusy(o.id);
    try {
      await fetch(`/api/admin/inspection-orders/${o.id}/complete`, { method: "POST", credentials: "include" });
      load();
    } finally { setBusy(null); }
  };

  const statusColor = (s: string) => s === "accepted" ? "#5eead4" : s === "completed" ? "#94a3b8" : s === "declined" ? "#f87171" : s === "sent" ? GOLD : "#64748b";

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <h3 style={headingStyle}>Inspection Orders</h3>
        <button onClick={load} style={refreshBtnStyle}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Every order is booked and communicated to the vendor under the client's own name. Mark completed once the
        vendor has performed all signed items — this locks the final invoice total.
      </p>
      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading orders…</div>
      ) : orders.length === 0 ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>No inspection orders yet.</div>
      ) : (
        <div style={{ maxHeight: 480, overflowY: "auto", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6 }}>
          <table style={{ width: "100%", fontSize: 12, color: "#c7d1dd", borderCollapse: "collapse" }}>
            <thead style={{ background: "rgba(255,255,255,0.03)", position: "sticky", top: 0 }}>
              <tr>
                <th style={thStyle("left")}>Property</th>
                <th style={thStyle("left")}>Client</th>
                <th style={thStyle("left")}>Agent</th>
                <th style={thStyle("center")}>Status</th>
                <th style={thStyle("right")}>Total</th>
                <th style={thStyle("center")}></th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "6px 10px", color: "#e5e7eb" }}>{o.property_address}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8" }}>{o.client_name}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8" }}>{o.agent_name || "—"}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center", color: statusColor(o.status), textTransform: "capitalize" }}>{o.status}</td>
                  <td style={{ padding: "6px 10px", textAlign: "right", color: "#e5e7eb" }}>${(o.total || 0).toFixed(2)}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center" }}>
                    <div style={{ display: "flex", gap: 5, justifyContent: "center", flexWrap: "wrap" }}>
                      {o.status === "accepted" ? (
                        <button disabled={busy === o.id} onClick={() => complete(o)} style={{ ...actionBtnStyle, color: "#5eead4", borderColor: "rgba(94,234,212,0.4)", background: "rgba(94,234,212,0.10)" }}>
                          <CheckCircle2 size={11} /> Complete
                        </button>
                      ) : null}
                      {(o.status === "accepted" || o.status === "completed") ? (
                        <button disabled={busy === o.id} onClick={() => setPaymentFor(o)} title="Record Payment — Alex, Nate, or Denise only"
                          style={{ ...actionBtnStyle, color: "#4ade80", borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.08)" }}>
                          <DollarSign size={11} /> Record Payment
                        </button>
                      ) : null}
                      {o.status !== "accepted" && o.status !== "completed" ? <span style={{ fontSize: 10, color: "#64748b" }}>—</span> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paymentFor && (
        <PaymentRecordModal
          sourceType="inspection_order"
          sourceId={paymentFor.id}
          propertyAddress={paymentFor.property_address}
          contractTotal={paymentFor.total}
          balanceRemaining={paymentFor.total}
          onClose={() => setPaymentFor(null)}
          onRecorded={() => { setPaymentFor(null); load(); }}
        />
      )}
    </div>
  );
}

// ── ADD-ONS QUEUE ────────────────────────────────────────────────────────────
function AddonsPanel() {
  const [addons, setAddons] = useState<Addon[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/inspection-addons", { credentials: "include" });
      const d = await r.json();
      setAddons(d.addons || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const approve = async (a: Addon) => {
    setBusy(a.id);
    try {
      await fetch(`/api/admin/inspection-addons/${a.id}/office-approve`, { method: "POST", credentials: "include" });
      load();
    } finally { setBusy(null); }
  };
  const decline = async (a: Addon) => {
    const reason = window.prompt("Reason for declining this add-on (optional):") || undefined;
    setBusy(a.id);
    try {
      await fetch(`/api/admin/inspection-addons/${a.id}/decline`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
      });
      load();
    } finally { setBusy(null); }
  };

  const statusColor = (s: string) => s === "signed" ? "#5eead4" : s === "office_approved" ? GOLD : s === "declined" ? "#f87171" : "#94a3b8";

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <h3 style={headingStyle}>Inspection Add-Ons</h3>
        <button onClick={load} style={refreshBtnStyle}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Add-ons discovered after the client already signed (e.g. a pool inspection). Office-approve sends the client
        a sign link — the add-on only counts toward the order total once they e-sign it.
      </p>
      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading add-ons…</div>
      ) : addons.length === 0 ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>No add-ons yet.</div>
      ) : (
        <div style={{ maxHeight: 480, overflowY: "auto", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6 }}>
          <table style={{ width: "100%", fontSize: 12, color: "#c7d1dd", borderCollapse: "collapse" }}>
            <thead style={{ background: "rgba(255,255,255,0.03)", position: "sticky", top: 0 }}>
              <tr>
                <th style={thStyle("left")}>Property</th>
                <th style={thStyle("left")}>Client</th>
                <th style={thStyle("left")}>Item</th>
                <th style={thStyle("left")}>Requested By</th>
                <th style={thStyle("right")}>Price</th>
                <th style={thStyle("center")}>Status</th>
                <th style={thStyle("center")}></th>
              </tr>
            </thead>
            <tbody>
              {addons.map(a => (
                <tr key={a.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "6px 10px", color: "#e5e7eb" }}>{a.property_address}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8" }}>{a.client_name}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8" }}>{a.name}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8" }}>{a.requested_by_name || "—"}</td>
                  <td style={{ padding: "6px 10px", textAlign: "right", color: "#e5e7eb" }}>${(a.client_price || 0).toFixed(2)}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center", color: statusColor(a.addon_status), textTransform: "capitalize" }}>{a.addon_status.replace(/_/g, " ")}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center" }}>
                    {a.addon_status === "pending" ? (
                      <div style={{ display: "flex", gap: 5, justifyContent: "center" }}>
                        <button disabled={busy === a.id} onClick={() => approve(a)} style={{ ...actionBtnStyle, color: GOLD, borderColor: "rgba(200,170,90,0.45)", background: "rgba(200,170,90,0.10)" }}>
                          <CheckCircle2 size={11} /> Approve
                        </button>
                        <button disabled={busy === a.id} onClick={() => decline(a)} style={{ ...actionBtnStyle, color: "#f87171", borderColor: "rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.08)" }}>
                          <XCircle size={11} /> Decline
                        </button>
                      </div>
                    ) : <span style={{ fontSize: 10, color: "#64748b" }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── SHARED STYLES ────────────────────────────────────────────────────────────
const panelStyle: CSSProperties = { padding: 16, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" };
const headingStyle: CSSProperties = { fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.15rem", fontWeight: 300, color: "#fff" };
const refreshBtnStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)", color: "#94a3b8", fontSize: 11, cursor: "pointer" };
const numInputStyle: CSSProperties = { width: 72, textAlign: "right", padding: "3px 6px", borderRadius: 4, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", color: "#e5e7eb", fontSize: 11.5 };
const actionBtnStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, padding: "4px 7px", borderRadius: 5, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)", color: "#94a3b8", cursor: "pointer" };
const saveBtnStyle = (dirty: boolean): CSSProperties => ({
  fontSize: 10.5, padding: "3px 8px", borderRadius: 5,
  background: dirty ? "rgba(94,234,212,0.12)" : "rgba(255,255,255,0.03)",
  border: `1px solid ${dirty ? "rgba(94,234,212,0.4)" : "rgba(255,255,255,0.08)"}`,
  color: dirty ? "#5eead4" : "#666", cursor: dirty ? "pointer" : "default",
});
const thStyle = (align: "left" | "right" | "center"): CSSProperties => ({ textAlign: align, padding: "6px 10px", fontWeight: 600, color: "#94a3b8" });
