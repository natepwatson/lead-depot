// v20.9.0 — Repair Program admin: Pricing Catalog + Vendor Directory CRUD.
// In-house items (repair_items) get an editable default rate / min charge / active toggle.
// Vendor directory (repair_vendors) is admin-managed contacts routed a quote request per trade
// (auto-emailed from the Repair Consult client flow when an item needs a licensed trade).
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCw, Trash2, Plus, DollarSign, Users2, FileSignature, Mail, Download, PenLine, CheckCircle2, FilePlus2, XCircle, Pencil, FileText } from "lucide-react";
// v20.30.0 — lets Alex open ANY repair consult (any agent's, any status)
// from the admin Repair Program panel and edit the scope/items directly,
// same tool the field agent uses, instead of only being able to view a
// read-only row in this table.
import { RepairConsultSheet } from "./RepairConsultSheet";
import { PdfViewerModal } from "./PdfViewerModal";

type PricingItem = {
  id: number;
  key: string;
  category: "in_house" | "vendor";
  trade: string;
  name: string;
  unit: string;
  default_rate: number;
  min_charge: number;
  two_story_eligible: number;
  sequence_order: number;
  instruction: string | null;
  notes: string | null;
  active: number;
};

type Vendor = {
  id: number;
  trade: string;
  name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  active: number;
  created_at: string;
};

type Consult = {
  id: number;
  property_address: string;
  client_name: string | null;
  client_email: string | null;
  status: string;
  total: number;
  quote_token: string | null;
  signature_method: string | null;
  accepted_at: string | null;
  accepted_signature_name: string | null;
  print_signed_at: string | null;
  print_signed_by: string | null;
  approval_email_sent_at: string | null;
  deposit_received_at: string | null;
  deposit_received_by: string | null;
  deposit_method: string | null;
  deposit_amount: number;
  start_window: string | null;
  start_date: string | null;
  start_time: string | null;
  office_approved_at: string | null;
  office_approved_by: string | null;
  agent_name: string | null;
  created_at: string;
};

const unitLabel = (u: string) => (u === "linear_ft" ? "linear ft" : u === "sqft" ? "sqft" : u === "each" ? "each" : "flat");

type ChangeOrder = {
  id: number;
  consult_id: number;
  property_address: string;
  client_name: string | null;
  requested_by_name: string | null;
  item_key: string | null;
  custom_description: string | null;
  unit: string;
  quantity: number;
  unit_rate: number;
  line_total: number;
  reason: string;
  photos: string[];
  status: "pending" | "office_approved" | "declined" | "signed";
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decline_reason: string | null;
  signed_at: string | null;
  signature_name: string | null;
};

export function RepairPricingVendorPanel() {
  const [tab, setTab] = useState<"pricing" | "vendors" | "consults" | "changeorders">("pricing");

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[
          { key: "pricing", label: "Pricing Catalog", icon: DollarSign },
          { key: "vendors", label: "Vendor Directory", icon: Users2 },
          { key: "consults", label: "Consults", icon: FileSignature },
          { key: "changeorders", label: "Change Orders", icon: FilePlus2 },
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
      {tab === "pricing" ? <PricingCatalogPanel /> : tab === "vendors" ? <VendorDirectoryPanel /> : tab === "consults" ? <ConsultsPanel /> : <ChangeOrdersPanel />}
    </div>
  );
}

// ── PRICING CATALOG ─────────────────────────────────────────────────────────
function PricingCatalogPanel() {
  const [items, setItems] = useState<PricingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<number, { default_rate?: string; min_charge?: string }>>({});

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/repair-pricing", { credentials: "include" });
      const d = await r.json();
      setItems(d.items || []);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const save = async (item: PricingItem) => {
    const d = draft[item.id] || {};
    const defaultRate = d.default_rate !== undefined ? parseFloat(d.default_rate) : item.default_rate;
    const minCharge = d.min_charge !== undefined ? parseFloat(d.min_charge) : item.min_charge;
    setSaving(item.id);
    try {
      await fetch(`/api/admin/repair-pricing/${item.id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultRate, minCharge }),
      });
      setItems(prev => prev.map(it => it.id === item.id ? { ...it, default_rate: defaultRate, min_charge: minCharge } : it));
      setDraft(prev => { const p = { ...prev }; delete p[item.id]; return p; });
    } finally { setSaving(null); }
  };

  const toggleActive = async (item: PricingItem) => {
    const nextActive = item.active ? 0 : 1;
    setItems(prev => prev.map(it => it.id === item.id ? { ...it, active: nextActive } : it));
    await fetch(`/api/admin/repair-pricing/${item.id}`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !!nextActive }),
    });
  };

  const inHouse = items.filter(i => i.category === "in_house");
  const vendorItems = items.filter(i => i.category === "vendor");
  const groups: Record<string, PricingItem[]> = {};
  inHouse.forEach(it => { (groups[it.trade] = groups[it.trade] || []).push(it); });

  return (
    <div style={{ padding: 16, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.15rem", fontWeight: 300, color: "#fff" }}>
          In-House Repair Pricing
        </h3>
        <button onClick={load} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
          color: "#94a3b8", fontSize: 11, cursor: "pointer",
        }}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Seeded with market-reasonable defaults — not live Xactimate/vendor data. Adjust rates and minimums here;
        agents always see live pricing in the Repair Consult tool. Turning an item off removes it from the agent
        checklist immediately.
      </p>

      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading pricing catalog…</div>
      ) : (
        <div style={{ maxHeight: 480, overflowY: "auto", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6 }}>
          <table style={{ width: "100%", fontSize: 12, color: "#c7d1dd", borderCollapse: "collapse" }}>
            <thead style={{ background: "rgba(255,255,255,0.03)", position: "sticky", top: 0 }}>
              <tr>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Item</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Unit</th>
                <th style={{ textAlign: "right", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Rate</th>
                <th style={{ textAlign: "right", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Min $</th>
                <th style={{ textAlign: "center", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Active</th>
                <th style={{ textAlign: "center", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}></th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(groups).map(([trade, tradeItems]) => (
                <>
                  <tr key={`hdr-${trade}`} style={{ background: "rgba(200,170,90,0.05)" }}>
                    <td colSpan={6} style={{ padding: "4px 10px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em", color: "#c8aa5a" }}>
                      {trade.replace(/_/g, " ")}
                    </td>
                  </tr>
                  {tradeItems.map(item => {
                    const d = draft[item.id] || {};
                    const rateVal = d.default_rate !== undefined ? d.default_rate : String(item.default_rate);
                    const minVal = d.min_charge !== undefined ? d.min_charge : String(item.min_charge);
                    const dirty = d.default_rate !== undefined || d.min_charge !== undefined;
                    return (
                      <tr key={item.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)", opacity: item.active ? 1 : 0.45 }}>
                        <td style={{ padding: "6px 10px", color: "#e5e7eb" }}>{item.name}</td>
                        <td style={{ padding: "6px 10px", color: "#94a3b8" }}>{unitLabel(item.unit)}</td>
                        <td style={{ padding: "4px 10px", textAlign: "right" }}>
                          <input
                            type="number" step="0.01" value={rateVal}
                            onChange={e => setDraft(prev => ({ ...prev, [item.id]: { ...prev[item.id], default_rate: e.target.value } }))}
                            style={{ width: 68, textAlign: "right", padding: "3px 6px", borderRadius: 4, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", color: "#e5e7eb", fontSize: 11.5 }}
                          />
                        </td>
                        <td style={{ padding: "4px 10px", textAlign: "right" }}>
                          <input
                            type="number" step="1" value={minVal}
                            onChange={e => setDraft(prev => ({ ...prev, [item.id]: { ...prev[item.id], min_charge: e.target.value } }))}
                            style={{ width: 60, textAlign: "right", padding: "3px 6px", borderRadius: 4, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", color: "#e5e7eb", fontSize: 11.5 }}
                          />
                        </td>
                        <td style={{ padding: "6px 10px", textAlign: "center" }}>
                          <input type="checkbox" checked={!!item.active} onChange={() => toggleActive(item)} />
                        </td>
                        <td style={{ padding: "6px 10px", textAlign: "center" }}>
                          <button
                            onClick={() => save(item)}
                            disabled={!dirty || saving === item.id}
                            style={{
                              fontSize: 10.5, padding: "3px 8px", borderRadius: 5,
                              background: dirty ? "rgba(94,234,212,0.12)" : "rgba(255,255,255,0.03)",
                              border: `1px solid ${dirty ? "rgba(94,234,212,0.4)" : "rgba(255,255,255,0.08)"}`,
                              color: dirty ? "#5eead4" : "#666", cursor: dirty ? "pointer" : "default",
                            }}
                          >{saving === item.id ? "Saving…" : "Save"}</button>
                        </td>
                      </tr>
                    );
                  })}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-4 mb-1">
        {vendorItems.length} licensed-trade items ({vendorItems.map(v => v.trade.replace(/_/g, " ")).slice(0, 6).join(", ")}
        {vendorItems.length > 6 ? "…" : ""}) carry no in-house price — Brothers Group has no pricing authority over
        licensed-trade work. Those route straight to the matching vendor below.
      </p>
    </div>
  );
}

// ── VENDOR DIRECTORY ────────────────────────────────────────────────────────
function VendorDirectoryPanel() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ trade: "", name: "", email: "", phone: "", notes: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/repair-vendors", { credentials: "include" });
      const d = await r.json();
      setVendors(d.vendors || []);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const addVendor = async () => {
    if (!form.trade || !form.name || !form.email) return;
    setSaving(true);
    try {
      await fetch("/api/admin/repair-vendors", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm({ trade: "", name: "", email: "", phone: "", notes: "" });
      setShowAdd(false);
      load();
    } finally { setSaving(false); }
  };

  const toggleActive = async (v: Vendor) => {
    const nextActive = v.active ? 0 : 1;
    setVendors(prev => prev.map(x => x.id === v.id ? { ...x, active: nextActive } : x));
    await fetch(`/api/admin/repair-vendors/${v.id}`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !!nextActive }),
    });
  };

  const remove = async (v: Vendor) => {
    if (!confirm(`Remove ${v.name} (${v.trade.replace(/_/g, " ")}) from the vendor directory?`)) return;
    setVendors(prev => prev.filter(x => x.id !== v.id));
    await fetch(`/api/admin/repair-vendors/${v.id}`, { method: "DELETE", credentials: "include" });
  };

  return (
    <div style={{ padding: 16, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.15rem", fontWeight: 300, color: "#fff" }}>
          Vendor Directory
        </h3>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setShowAdd(s => !s)} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
            background: "rgba(200,170,90,0.10)", border: "1px solid rgba(200,170,90,0.4)",
            color: "#e8d8a8", fontSize: 11, fontWeight: 600, cursor: "pointer",
          }}><Plus size={11} /> Add Vendor</button>
          <button onClick={load} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
            color: "#94a3b8", fontSize: 11, cursor: "pointer",
          }}><RefreshCw size={11} /> Refresh</button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        One preferred vendor per trade gets the auto-quote-request email (with photos + measurements) when a client
        approves a licensed-trade item during a Repair Consult. Directory ships empty until filled in here.
      </p>

      {showAdd && (
        <div style={{ marginBottom: 14, padding: 12, borderRadius: 8, background: "rgba(200,170,90,0.05)", border: "1px solid rgba(200,170,90,0.25)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input placeholder="Trade key (e.g. roofing, electrical, hvac)" value={form.trade}
            onChange={e => setForm(f => ({ ...f, trade: e.target.value.trim() }))}
            style={inputStyle} />
          <input placeholder="Vendor / company name" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            style={inputStyle} />
          <input placeholder="Email (required — quote requests go here)" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            style={inputStyle} />
          <input placeholder="Phone (optional)" value={form.phone}
            onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
            style={inputStyle} />
          <input placeholder="Notes (optional)" value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            style={{ ...inputStyle, gridColumn: "1 / -1" }} />
          <button onClick={addVendor} disabled={saving || !form.trade || !form.name || !form.email}
            style={{
              gridColumn: "1 / -1", padding: "6px 10px", borderRadius: 6,
              background: "rgba(94,234,212,0.12)", border: "1px solid rgba(94,234,212,0.4)",
              color: "#5eead4", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
            }}>{saving ? "Saving…" : "Save Vendor"}</button>
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading vendor directory…</div>
      ) : vendors.length === 0 ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>No vendors yet — add your preferred trade partners above.</div>
      ) : (
        <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6 }}>
          <table style={{ width: "100%", fontSize: 12, color: "#c7d1dd", borderCollapse: "collapse" }}>
            <thead style={{ background: "rgba(255,255,255,0.03)", position: "sticky", top: 0 }}>
              <tr>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Trade</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Vendor</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Contact</th>
                <th style={{ textAlign: "center", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Active</th>
                <th style={{ textAlign: "center", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}></th>
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => (
                <tr key={v.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)", opacity: v.active ? 1 : 0.45 }}>
                  <td style={{ padding: "6px 10px", color: "#c8aa5a", textTransform: "capitalize" }}>{v.trade.replace(/_/g, " ")}</td>
                  <td style={{ padding: "6px 10px", color: "#e5e7eb" }}>{v.name}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8", fontSize: 11 }}>
                    {v.email}{v.phone ? ` · ${v.phone}` : ""}
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "center" }}>
                    <input type="checkbox" checked={!!v.active} onChange={() => toggleActive(v)} />
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "center" }}>
                    <button onClick={() => remove(v)} style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer" }}>
                      <Trash2 size={13} />
                    </button>
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

// ── REPAIR CONSULTS: Agreement send / print-sign / approval actions ───────────
function ConsultsPanel() {
  const [consults, setConsults] = useState<Consult[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [changeOrderFor, setChangeOrderFor] = useState<Consult | null>(null);
  // v20.30.0 — admin "Edit" launch point: opens the full RepairConsultSheet
  // pointed at this consult id so Alex can view/edit scope at any point.
  const [editingConsultId, setEditingConsultId] = useState<number | null>(null);
  // v20.31.0 — in-app PDF viewer state, replaces window.open (which gets
  // stuck with no way back when the app is running as an installed PWA).
  const [pdfModal, setPdfModal] = useState<{ url: string; title: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/repair-consults", { credentials: "include" });
      const d = await r.json();
      setConsults(d.consults || []);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const sendToClient = async (c: Consult) => {
    setBusy(c.id);
    try {
      await fetch(`/api/repair-consult/${c.id}/send-to-client`, { method: "POST", credentials: "include" });
      load();
    } finally { setBusy(null); }
  };

  const sendApproval = async (c: Consult) => {
    setBusy(c.id);
    try {
      const r = await fetch(`/api/repair-consult/${c.id}/send-approval-email`, { method: "POST", credentials: "include" });
      const b = await r.json();
      if (!r.ok) alert(b?.error || "Failed to send approval email");
      load();
    } finally { setBusy(null); }
  };

  // v20.13.0 — Office Approval Gate: admin sign-off in-house before anything goes to the client.
  const officeApprove = async (c: Consult) => {
    // v20.30.0 — reworded: approving is an internal sign-off ONLY. It does
    // NOT send anything to the client — E-Sign / Approval Email are separate,
    // explicit actions taken afterward.
    if (!confirm(`Approve this proposal internally for ${c.property_address}?\n\nTotal: $${c.total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n\nThis does NOT send anything to the client — you'll still need to click E-Sign or Approval below to actually send it.`)) return;
    setBusy(c.id);
    try {
      const r = await fetch(`/api/repair-consult/${c.id}/office-approve`, { method: "POST", credentials: "include" });
      const b = await r.json();
      if (!r.ok) alert(b?.error || "Failed to approve");
      load();
    } finally { setBusy(null); }
  };

  // v20.31.0 — opens in the in-app PdfViewerModal (iframe + Close button)
  // instead of window.open, which gets stuck with no way back when the app
  // is running as an installed home-screen PWA (no tabs, no browser back).
  const downloadPdf = (c: Consult) => {
    setPdfModal({ url: `/api/repair-consult/${c.id}/agreement-pdf`, title: `${c.property_address} — Print & Sign Agreement` });
  };

  // v20.30.0 — view the itemized quote PDF. No approval gate: only requires
  // a quote to exist. Mirrors downloadPdf's pattern for the agreement.
  const viewQuotePdf = (c: Consult) => {
    setPdfModal({ url: `/api/repair-consult/${c.id}/quote-pdf`, title: `${c.property_address} — Itemized Quote` });
  };

  // v20.31.0 — button audit: permanently delete a consult (admin only).
  // Extra-scary confirm copy when the consult is already signed, since
  // deleting one erases a signed agreement record.
  const deleteConsult = async (c: Consult) => {
    const msg = c.status === "accepted"
      ? `This consult for ${c.property_address} has ALREADY BEEN SIGNED${c.deposit_received_at ? " and the deposit was received" : ""}. Deleting it permanently erases that signed record. This cannot be undone. Delete anyway?`
      : `Permanently delete the consult for ${c.property_address}? This cannot be undone.`;
    if (!confirm(msg)) return;
    setBusy(c.id);
    try {
      const r = await fetch(`/api/repair-consult/${c.id}`, { method: "DELETE", credentials: "include" });
      const b = await r.json();
      if (!r.ok) { alert(b?.error || "Failed to delete consult"); return; }
      load();
    } finally { setBusy(null); }
  };

  const markPrintSigned = async (c: Consult) => {
    const signedBy = prompt(`Client's full name as signed on the printed agreement for ${c.property_address}:`, c.client_name || "");
    if (!signedBy || signedBy.trim().length < 2) return;
    setBusy(c.id);
    try {
      const r = await fetch(`/api/repair-consult/${c.id}/mark-print-signed`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedBy: signedBy.trim() }),
      });
      const b = await r.json();
      if (!r.ok) alert(b?.error || "Failed to record print-signed agreement");
      load();
    } finally { setBusy(null); }
  };

  // v20.13.0 — Deposit Required Gate: one-tap mark-received, unlocks scheduling.
  const markDepositReceived = async (c: Consult) => {
    if (!confirm(`Mark the 50% deposit ($${c.deposit_amount?.toLocaleString(undefined, { minimumFractionDigits: 2 })}) received for ${c.property_address}?`)) return;
    setBusy(c.id);
    try {
      const r = await fetch(`/api/repair-consult/${c.id}/mark-deposit-received`, { method: "POST", credentials: "include" });
      const b = await r.json();
      if (!r.ok) alert(b?.error || "Failed to mark deposit received");
      load();
    } finally { setBusy(null); }
  };

  const scheduleStart = async (c: Consult) => {
    const dateStr = prompt(`Start date for ${c.property_address} (YYYY-MM-DD):`, c.start_date || "");
    if (dateStr === null) return;
    const timeStr = dateStr.trim() ? (prompt(`Start time (optional, e.g. 9:00 AM):`, c.start_time || "") || "") : "";
    setBusy(c.id);
    try {
      const r = await fetch(`/api/repair-consult/${c.id}/start-window`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startWindow: dateStr.trim() ? "specific" : null, startDate: dateStr.trim() || null, startTime: timeStr.trim() || null }),
      });
      const b = await r.json();
      if (!r.ok) alert(b?.error || "Failed to schedule start date");
      load();
    } finally { setBusy(null); }
  };

  const statusColor = (status: string) =>
    status === "accepted" ? "#5eead4" : status === "sent" || status === "quoted" ? "#e8d8a8" : "#94a3b8";

  const signedLabel = (c: Consult) => {
    if (c.status !== "accepted") return "—";
    if (c.signature_method === "print_sign") return `Print & Sign · ${c.print_signed_by || c.accepted_signature_name || ""}`;
    if (c.signature_method === "email_approval") return `Email Approval · ${c.accepted_signature_name || ""}`;
    return `E-Sign · ${c.accepted_signature_name || ""}`;
  };

  return (
    <div style={{ padding: 16, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.15rem", fontWeight: 300, color: "#fff" }}>
          Repair Consults &amp; Agreements
        </h3>
        <button onClick={load} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
          color: "#94a3b8", fontSize: 11, cursor: "pointer",
        }}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Send the two-page agreement for e-signature, send a one-click green approval email, download the blank
        Print &amp; Sign PDF, or mark a consult signed after a physical printout comes back.
      </p>

      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading consults…</div>
      ) : consults.length === 0 ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>No repair consults yet.</div>
      ) : (
        <div style={{ maxHeight: 520, overflowY: "auto", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6 }}>
          <table style={{ width: "100%", fontSize: 12, color: "#c7d1dd", borderCollapse: "collapse" }}>
            <thead style={{ background: "rgba(255,255,255,0.03)", position: "sticky", top: 0 }}>
              <tr>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Property</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Client</th>
                <th style={{ textAlign: "right", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Total</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Status</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Office</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Signed</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Deposit / Start</th>
                <th style={{ textAlign: "center", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {consults.map(c => (
                <tr key={c.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "6px 10px", color: "#e5e7eb" }}>{c.property_address}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8" }}>
                    {c.client_name || "—"}{c.client_email ? <div style={{ fontSize: 10 }}>{c.client_email}</div> : null}
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "right", color: "#e5e7eb" }}>
                    {c.total ? `$${c.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}
                  </td>
                  <td style={{ padding: "6px 10px", color: statusColor(c.status), textTransform: "capitalize" }}>{c.status}</td>
                  <td style={{ padding: "6px 10px", fontSize: 11 }}>
                    {!c.quote_token ? (
                      <span style={{ color: "#64748b" }}>—</span>
                    ) : c.office_approved_at ? (
                      <span style={{ color: "#5eead4" }}>Approved · {c.office_approved_by}</span>
                    ) : (
                      <span style={{ color: "#e8d8a8" }}>Pending approval</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8", fontSize: 11 }}>{signedLabel(c)}</td>
                  <td style={{ padding: "6px 10px", fontSize: 11 }}>
                    {c.status !== "accepted" ? (
                      <span style={{ color: "#64748b" }}>Awaiting signature</span>
                    ) : !c.deposit_received_at ? (
                      <span style={{ color: "#e8d8a8" }}>Awaiting deposit</span>
                    ) : !c.start_date && !c.start_window ? (
                      <span style={{ color: "#5eead4" }}>Deposit in · not scheduled</span>
                    ) : (
                      <span style={{ color: "#5eead4" }}>{c.start_date ? `Start ${c.start_date}${c.start_time ? " " + c.start_time : ""}` : c.start_window}</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 10px" }}>
                    <div style={{ display: "flex", gap: 5, justifyContent: "center", flexWrap: "wrap" }}>
                      {c.quote_token && !c.office_approved_at && (
                        <button disabled={busy === c.id} onClick={() => officeApprove(c)} title="Office Approval — required before this can be sent to the client"
                          style={{ ...actionBtnStyle, color: "#c8aa5a", borderColor: "rgba(200,170,90,0.45)", background: "rgba(200,170,90,0.10)" }}><CheckCircle2 size={11} /> Approve</button>
                      )}
                      <button disabled={!c.quote_token || !c.office_approved_at || busy === c.id} onClick={() => sendToClient(c)}
                        title={!c.quote_token ? "Generate the quote first" : !c.office_approved_at ? "Needs office approval first" : "Send to Client (E-Sign)"}
                        style={actionBtnStyle}><Mail size={11} /> E-Sign</button>
                      <button disabled={!c.quote_token || !c.office_approved_at || busy === c.id} onClick={() => sendApproval(c)}
                        title={!c.quote_token ? "Generate the quote first" : !c.office_approved_at ? "Needs office approval first" : "Send Approval Email"}
                        style={{ ...actionBtnStyle, color: "#5eead4", borderColor: "rgba(94,234,212,0.4)", background: "rgba(94,234,212,0.08)" }}><Mail size={11} /> Approval</button>
                      <button disabled={!c.quote_token || busy === c.id} onClick={() => downloadPdf(c)}
                        title={!c.quote_token ? "Generate the quote first" : "View / Download Print & Sign Agreement PDF (no approval needed to view)"}
                        style={actionBtnStyle}><Download size={11} /> Print PDF</button>
                      <button disabled={!c.quote_token || busy === c.id} onClick={() => viewQuotePdf(c)}
                        title={!c.quote_token ? "Generate the quote first" : "View the itemized Quote PDF"}
                        style={actionBtnStyle}><FileText size={11} /> View Quote</button>
                      <button disabled={busy === c.id} onClick={() => setEditingConsultId(c.id)} title="Open and edit this consult's full scope/items"
                        style={{ ...actionBtnStyle, color: "#93c5fd", borderColor: "rgba(147,197,253,0.4)", background: "rgba(147,197,253,0.08)" }}><Pencil size={11} /> Edit</button>
                      <button disabled={!c.quote_token || c.status === "accepted" || busy === c.id} onClick={() => markPrintSigned(c)}
                        title={!c.quote_token ? "Generate the quote first" : c.status === "accepted" ? "Already signed" : "Mark as Print-Signed — physical printout came back signed"}
                        style={actionBtnStyle}><PenLine size={11} /> Mark Signed</button>
                      {c.status === "accepted" && !c.deposit_received_at && (
                        <button disabled={busy === c.id} onClick={() => markDepositReceived(c)} title="Mark Deposit Received"
                          style={{ ...actionBtnStyle, color: "#e8d8a8", borderColor: "rgba(200,170,90,0.45)", background: "rgba(200,170,90,0.10)" }}><DollarSign size={11} /> Deposit In</button>
                      )}
                      {c.status === "accepted" && c.deposit_received_at && (
                        <button disabled={busy === c.id} onClick={() => scheduleStart(c)} title="Schedule Start Date"
                          style={{ ...actionBtnStyle, color: "#5eead4", borderColor: "rgba(94,234,212,0.4)", background: "rgba(94,234,212,0.08)" }}>Schedule</button>
                      )}
                      {c.status === "accepted" && (
                        <button disabled={busy === c.id} onClick={() => setChangeOrderFor(c)} title="Request a Change Order — additional work found once work began"
                          style={{ ...actionBtnStyle, color: "#c8aa5a", borderColor: "rgba(200,170,90,0.45)", background: "rgba(200,170,90,0.10)" }}><FilePlus2 size={11} /> Change Order</button>
                      )}
                      <button disabled={busy === c.id} onClick={() => deleteConsult(c)} title="Permanently delete this consult"
                        style={{ ...actionBtnStyle, color: "#f87171", borderColor: "rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.08)" }}><Trash2 size={11} /> Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {changeOrderFor && (
        <RequestChangeOrderModal
          consult={changeOrderFor}
          onClose={() => setChangeOrderFor(null)}
          onSaved={() => { setChangeOrderFor(null); }}
        />
      )}
      {editingConsultId != null && (
        <RepairConsultSheet
          initialConsultId={editingConsultId}
          onClose={() => { setEditingConsultId(null); load(); }}
          manageNavVisibility={true}
        />
      )}
      {pdfModal && (
        <PdfViewerModal url={pdfModal.url} title={pdfModal.title} onClose={() => setPdfModal(null)} />
      )}
    </div>
  );
}

// ── CHANGE ORDER REQUEST MODAL (used from ConsultsPanel, accepted rows only) ──
function RequestChangeOrderModal({ consult, onClose, onSaved }: { consult: Consult; onClose: () => void; onSaved: () => void }) {
  const [catalog, setCatalog] = useState<PricingItem[]>([]);
  const [mode, setMode] = useState<"catalog" | "custom">("catalog");
  const [itemKey, setItemKey] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitRate, setUnitRate] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/admin/repair-pricing", { credentials: "include" });
      const d = await r.json();
      setCatalog((d.items || []).filter((i: PricingItem) => i.category === "in_house" && i.active));
    })();
  }, []);

  const selectedCat = catalog.find(c => c.key === itemKey);
  const effectiveRate = unitRate !== "" ? parseFloat(unitRate) || 0 : (selectedCat?.default_rate || 0);
  const effectiveQty = parseFloat(quantity) || 0;
  const lineTotal = effectiveRate * effectiveQty;

  const submit = async () => {
    setError("");
    if (mode === "catalog" && !itemKey) return setError("Select an item from the catalog");
    if (mode === "custom" && !customDescription.trim()) return setError("Enter a description");
    if (!reason.trim()) return setError("Explain why this additional work is needed");
    setSaving(true);
    try {
      const r = await fetch(`/api/repair-consult/${consult.id}/change-orders`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemKey: mode === "catalog" ? itemKey : null,
          customDescription: mode === "custom" ? customDescription.trim() : null,
          quantity: effectiveQty || 1,
          unitRate: effectiveRate,
          unit: selectedCat?.unit || "flat",
          reason: reason.trim(),
        }),
      });
      const b = await r.json();
      if (!r.ok) { setError(b?.error || "Failed to submit change order"); return; }
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ width: 460, maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto", background: "#141312", border: "1px solid rgba(200,170,90,0.3)", borderRadius: 12, padding: 20 }}>
        <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.2rem", fontWeight: 300, color: "#fff", marginBottom: 2 }}>
          Request Change Order
        </h3>
        <p style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 14 }}>{consult.property_address}</p>

        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <button onClick={() => setMode("catalog")} style={{ flex: 1, padding: "6px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
            background: mode === "catalog" ? "rgba(200,170,90,0.12)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${mode === "catalog" ? "rgba(200,170,90,0.45)" : "rgba(255,255,255,0.10)"}`,
            color: mode === "catalog" ? "#e8d8a8" : "#94a3b8" }}>Catalog Item</button>
          <button onClick={() => setMode("custom")} style={{ flex: 1, padding: "6px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
            background: mode === "custom" ? "rgba(200,170,90,0.12)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${mode === "custom" ? "rgba(200,170,90,0.45)" : "rgba(255,255,255,0.10)"}`,
            color: mode === "custom" ? "#e8d8a8" : "#94a3b8" }}>Custom / Off-Catalog</button>
        </div>

        {mode === "catalog" ? (
          <select value={itemKey} onChange={e => setItemKey(e.target.value)} style={{ ...inputStyle, width: "100%", marginBottom: 10 }}>
            <option value="">Select an item…</option>
            {catalog.map(c => (
              <option key={c.key} value={c.key}>{c.name} — ${c.default_rate}/{unitLabel(c.unit)}</option>
            ))}
          </select>
        ) : (
          <textarea placeholder="Describe the additional work…" value={customDescription} onChange={e => setCustomDescription(e.target.value)}
            rows={2} style={{ ...inputStyle, width: "100%", marginBottom: 10, resize: "vertical" }} />
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 3 }}>Quantity</label>
            <input type="number" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
          </div>
          <div>
            <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 3 }}>Rate {mode === "catalog" && selectedCat ? `(default $${selectedCat.default_rate})` : ""}</label>
            <input type="number" step="0.01" placeholder={selectedCat ? String(selectedCat.default_rate) : "0.00"} value={unitRate} onChange={e => setUnitRate(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
          </div>
        </div>

        <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 3 }}>Reason (what was found, why it's needed)</label>
        <textarea placeholder="e.g. Found termite damage under the back deck boards during demo…" value={reason} onChange={e => setReason(e.target.value)}
          rows={3} style={{ ...inputStyle, width: "100%", marginBottom: 10, resize: "vertical" }} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "rgba(200,170,90,0.06)", borderRadius: 6, marginBottom: 12 }}>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>Change Order Amount</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#e8d8a8" }}>${lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </div>

        {error && <div style={{ fontSize: 11, color: "#f87171", marginBottom: 10 }}>{error}</div>}

        <p style={{ fontSize: 10, color: "#64748b", marginBottom: 14, lineHeight: 1.5 }}>
          This submits for office approval only — nothing is sent to the client yet, and no charge applies until
          the client reviews and e-signs the specific change order.
        </p>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "7px 14px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)", color: "#94a3b8", fontSize: 11.5, cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: "7px 16px", borderRadius: 6, background: "rgba(200,170,90,0.15)", border: "1px solid rgba(200,170,90,0.5)", color: "#e8d8a8", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
            {saving ? "Submitting…" : "Submit for Approval"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── CHANGE ORDERS: admin queue, approve/decline/view signed ────────────
function ChangeOrdersPanel() {
  const [orders, setOrders] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/repair-change-orders", { credentials: "include" });
      const d = await r.json();
      setOrders(d.changeOrders || []);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const approve = async (co: ChangeOrder) => {
    if (!confirm(`Office-approve this $${co.line_total.toLocaleString(undefined, { minimumFractionDigits: 2 })} change order for ${co.property_address}?\n\nThis sends an e-sign link to the client — nothing is billed until they sign.`)) return;
    setBusy(co.id);
    try {
      const r = await fetch(`/api/admin/repair-change-orders/${co.id}/office-approve`, { method: "POST", credentials: "include" });
      const b = await r.json();
      if (!r.ok) alert(b?.error || "Failed to approve");
      load();
    } finally { setBusy(null); }
  };

  const decline = async (co: ChangeOrder) => {
    const reason = prompt(`Reason for declining this change order (optional):`, "");
    if (reason === null) return;
    setBusy(co.id);
    try {
      const r = await fetch(`/api/admin/repair-change-orders/${co.id}/decline`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || null }),
      });
      const b = await r.json();
      if (!r.ok) alert(b?.error || "Failed to decline");
      load();
    } finally { setBusy(null); }
  };

  const statusColor = (s: ChangeOrder["status"]) =>
    s === "signed" ? "#5eead4" : s === "office_approved" ? "#e8d8a8" : s === "declined" ? "#f87171" : "#94a3b8";

  return (
    <div style={{ padding: 16, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.15rem", fontWeight: 300, color: "#fff" }}>
          Change Orders
        </h3>
        <button onClick={load} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
          color: "#94a3b8", fontSize: 11, cursor: "pointer",
        }}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Additional work found once a job is underway. Every change order requires office approval here BEFORE the
        client ever sees it, then the client must e-sign that specific change order before it becomes billable —
        every time, no exceptions.
      </p>

      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading change orders…</div>
      ) : orders.length === 0 ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>No change orders yet.</div>
      ) : (
        <div style={{ maxHeight: 520, overflowY: "auto", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6 }}>
          <table style={{ width: "100%", fontSize: 12, color: "#c7d1dd", borderCollapse: "collapse" }}>
            <thead style={{ background: "rgba(255,255,255,0.03)", position: "sticky", top: 0 }}>
              <tr>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Property</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Description</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Reason</th>
                <th style={{ textAlign: "right", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Amount</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Status</th>
                <th style={{ textAlign: "center", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(co => (
                <tr key={co.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "6px 10px", color: "#e5e7eb" }}>{co.property_address}</td>
                  <td style={{ padding: "6px 10px", color: "#e5e7eb" }}>{co.custom_description || co.item_key}</td>
                  <td style={{ padding: "6px 10px", color: "#94a3b8", fontSize: 11, maxWidth: 220 }}>{co.reason}</td>
                  <td style={{ padding: "6px 10px", textAlign: "right", color: "#e5e7eb" }}>${co.line_total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td style={{ padding: "6px 10px", color: statusColor(co.status), textTransform: "capitalize", fontSize: 11 }}>
                    {co.status === "signed" ? `Signed · ${co.signature_name}` : co.status === "office_approved" ? "Awaiting client signature" : co.status.replace("_", " ")}
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "center" }}>
                    {co.status === "pending" ? (
                      <div style={{ display: "flex", gap: 5, justifyContent: "center" }}>
                        <button disabled={busy === co.id} onClick={() => approve(co)}
                          style={{ ...actionBtnStyle, color: "#c8aa5a", borderColor: "rgba(200,170,90,0.45)", background: "rgba(200,170,90,0.10)" }}><CheckCircle2 size={11} /> Approve</button>
                        <button disabled={busy === co.id} onClick={() => decline(co)}
                          style={{ ...actionBtnStyle, color: "#f87171", borderColor: "rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.08)" }}><XCircle size={11} /> Decline</button>
                      </div>
                    ) : (
                      <span style={{ fontSize: 10, color: "#64748b" }}>—</span>
                    )}
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

const actionBtnStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, padding: "4px 7px", borderRadius: 5,
  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)", color: "#94a3b8", cursor: "pointer",
};

const inputStyle: CSSProperties = {
  padding: "6px 8px", borderRadius: 5, background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)", color: "#e5e7eb", fontSize: 11.5,
};
