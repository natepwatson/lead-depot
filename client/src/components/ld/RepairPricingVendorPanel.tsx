// v20.9.0 — Repair Program admin: Pricing Catalog + Vendor Directory CRUD.
// In-house items (repair_items) get an editable default rate / min charge / active toggle.
// Vendor directory (repair_vendors) is admin-managed contacts routed a quote request per trade
// (auto-emailed from the Repair Consult client flow when an item needs a licensed trade).
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCw, Trash2, Plus, DollarSign, Users2, FileSignature, Mail, Download, PenLine } from "lucide-react";

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
  agent_name: string | null;
  created_at: string;
};

const unitLabel = (u: string) => (u === "linear_ft" ? "linear ft" : u === "sqft" ? "sqft" : u === "each" ? "each" : "flat");

export function RepairPricingVendorPanel() {
  const [tab, setTab] = useState<"pricing" | "vendors" | "consults">("pricing");

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[
          { key: "pricing", label: "Pricing Catalog", icon: DollarSign },
          { key: "vendors", label: "Vendor Directory", icon: Users2 },
          { key: "consults", label: "Consults", icon: FileSignature },
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
      {tab === "pricing" ? <PricingCatalogPanel /> : tab === "vendors" ? <VendorDirectoryPanel /> : <ConsultsPanel />}
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

  const downloadPdf = (c: Consult) => {
    window.open(`/api/repair-consult/${c.id}/agreement-pdf`, "_blank");
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
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Signed</th>
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
                  <td style={{ padding: "6px 10px", color: "#94a3b8", fontSize: 11 }}>{signedLabel(c)}</td>
                  <td style={{ padding: "6px 10px" }}>
                    <div style={{ display: "flex", gap: 5, justifyContent: "center", flexWrap: "wrap" }}>
                      <button disabled={!c.quote_token || busy === c.id} onClick={() => sendToClient(c)} title="Send to Client (E-Sign)"
                        style={actionBtnStyle}><Mail size={11} /> E-Sign</button>
                      <button disabled={!c.quote_token || busy === c.id} onClick={() => sendApproval(c)} title="Send Approval Email"
                        style={{ ...actionBtnStyle, color: "#5eead4", borderColor: "rgba(94,234,212,0.4)", background: "rgba(94,234,212,0.08)" }}><Mail size={11} /> Approval</button>
                      <button disabled={busy === c.id} onClick={() => downloadPdf(c)} title="Download Print & Sign PDF"
                        style={actionBtnStyle}><Download size={11} /> Print PDF</button>
                      <button disabled={busy === c.id} onClick={() => markPrintSigned(c)} title="Mark as Print-Signed"
                        style={actionBtnStyle}><PenLine size={11} /> Mark Signed</button>
                    </div>
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
