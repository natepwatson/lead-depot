// v20.40.0 — Labor & Crews admin tab. Phase 1 of the Scheduler/Labor/PM/
// Calendar build: a roster of in-house laborers we sign up and approve,
// with a fixed 3-tier pay structure ($16/$20/$25 per hour). Ad hoc crew
// assignment happens per-job in Phase 2's Labor Calculator — this page is
// just the source-of-truth roster admins add/edit/approve laborers from.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCw, Plus, HardHat, CheckCircle2, XCircle, Trash2, Pencil } from "lucide-react";

const GOLD = "#c8aa5a";

type Tier = "tier_1" | "tier_2" | "tier_3";

const TIER_LABEL: Record<Tier, string> = {
  tier_1: "Tier 1",
  tier_2: "Tier 2",
  tier_3: "Tier 3",
};

const TIER_DEFAULT_RATE: Record<Tier, number> = {
  tier_1: 16,
  tier_2: 20,
  tier_3: 25,
};

type Laborer = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  tier: Tier;
  hourly_rate: number;
  trades: string | null;
  notes: string | null;
  approved: number;
  active: number;
};

const inputStyle: CSSProperties = {
  padding: "6px 8px", borderRadius: 5, background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)", color: "#e5e7eb", fontSize: 11.5,
};

const actionBtnStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, padding: "4px 7px", borderRadius: 5,
  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)", color: "#94a3b8", cursor: "pointer",
};

export function LaborCrewsPanel() {
  const [laborers, setLaborers] = useState<Laborer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", tier: "tier_1" as Tier, hourly_rate: 16, trades: "", notes: "" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/laborers", { credentials: "include" });
      const d = await r.json();
      setLaborers(d.laborers || []);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const addLaborer = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/admin/laborers", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm({ name: "", phone: "", email: "", tier: "tier_1", hourly_rate: 16, trades: "", notes: "" });
      setShowAdd(false);
      load();
    } finally { setSaving(false); }
  };

  const openEdit = (l: Laborer) => {
    if (editingId === l.id) { setEditingId(null); return; }
    setEditingId(l.id);
    setEditDraft({
      name: l.name, phone: l.phone || "", email: l.email || "",
      tier: l.tier, hourly_rate: l.hourly_rate, trades: l.trades || "", notes: l.notes || "",
    });
  };

  const saveEdit = async (l: Laborer) => {
    setBusy(l.id);
    try {
      await fetch(`/api/admin/laborers/${l.id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editDraft),
      });
      setEditingId(null);
      load();
    } finally { setBusy(null); }
  };

  const toggleApproved = async (l: Laborer) => {
    const next = l.approved ? 0 : 1;
    setLaborers(prev => prev.map(x => x.id === l.id ? { ...x, approved: next } : x));
    await fetch(`/api/admin/laborers/${l.id}`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: !!next }),
    });
  };

  const toggleActive = async (l: Laborer) => {
    const next = l.active ? 0 : 1;
    setLaborers(prev => prev.map(x => x.id === l.id ? { ...x, active: next } : x));
    await fetch(`/api/admin/laborers/${l.id}`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !!next }),
    });
  };

  const remove = async (l: Laborer) => {
    if (!confirm(`Remove ${l.name} from the labor roster? This cannot be undone.`)) return;
    setLaborers(prev => prev.filter(x => x.id !== l.id));
    await fetch(`/api/admin/laborers/${l.id}`, { method: "DELETE", credentials: "include" });
  };

  return (
    <div style={{ padding: 16, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.15rem", fontWeight: 300, color: "#fff", display: "flex", alignItems: "center", gap: 8 }}>
          <HardHat size={16} color={GOLD} /> Labor &amp; Crews
        </h3>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setShowAdd(s => !s)} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
            background: "rgba(200,170,90,0.10)", border: "1px solid rgba(200,170,90,0.4)",
            color: "#e8d8a8", fontSize: 11, fontWeight: 600, cursor: "pointer",
          }}><Plus size={11} /> Add Laborer</button>
          <button onClick={load} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
            color: "#94a3b8", fontSize: 11, cursor: "pointer",
          }}><RefreshCw size={11} /> Refresh</button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        In-house laborers we sign up, approve, and assign to job trades. Pay is fixed at three tiers —
        Tier 1 (${TIER_DEFAULT_RATE.tier_1}/hr), Tier 2 (${TIER_DEFAULT_RATE.tier_2}/hr), Tier 3 (${TIER_DEFAULT_RATE.tier_3}/hr) —
        with an editable rate per person if needed. Only approved, active laborers can be assigned in the per-job
        Labor Calculator (coming next).
      </p>

      {showAdd && (
        <div style={{ marginBottom: 14, padding: 12, borderRadius: 8, background: "rgba(200,170,90,0.05)", border: "1px solid rgba(200,170,90,0.25)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input placeholder="Full name" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            style={inputStyle} />
          <input placeholder="Phone (optional)" value={form.phone}
            onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
            style={inputStyle} />
          <input placeholder="Email (optional — needed for work order emails)" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            style={{ ...inputStyle, gridColumn: "1 / -1" }} />
          <select value={form.tier}
            onChange={e => {
              const tier = e.target.value as Tier;
              setForm(f => ({ ...f, tier, hourly_rate: TIER_DEFAULT_RATE[tier] }));
            }}
            style={inputStyle}>
            {(["tier_1", "tier_2", "tier_3"] as Tier[]).map(t => (
              <option key={t} value={t}>{TIER_LABEL[t]} (${TIER_DEFAULT_RATE[t]}/hr default)</option>
            ))}
          </select>
          <input type="number" step="0.50" placeholder="Hourly rate" value={form.hourly_rate}
            onChange={e => setForm(f => ({ ...f, hourly_rate: parseFloat(e.target.value) || 0 }))}
            style={inputStyle} />
          <input placeholder="Trades (optional, comma-separated, e.g. painting_interior, landscaping)" value={form.trades}
            onChange={e => setForm(f => ({ ...f, trades: e.target.value }))}
            style={{ ...inputStyle, gridColumn: "1 / -1" }} />
          <input placeholder="Notes (optional)" value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            style={{ ...inputStyle, gridColumn: "1 / -1" }} />
          <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => setShowAdd(false)} style={actionBtnStyle}>Cancel</button>
            <button onClick={addLaborer} disabled={saving || !form.name.trim()} style={{
              ...actionBtnStyle, background: "rgba(200,170,90,0.15)", border: "1px solid rgba(200,170,90,0.5)", color: "#e8d8a8",
              opacity: saving || !form.name.trim() ? 0.5 : 1,
            }}>{saving ? "Saving…" : "Save Laborer"}</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : laborers.length === 0 ? (
        <div className="text-xs text-muted-foreground">No laborers on the roster yet. Add the first one above.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {laborers.map(l => (
            <div key={l.id} style={{
              padding: "8px 10px", borderRadius: 7,
              background: l.active ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.015)",
              border: "1px solid rgba(255,255,255,0.08)", opacity: l.active ? 1 : 0.55,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "#e5e7eb" }}>{l.name}</span>
                  <span style={{
                    fontSize: 9.5, padding: "2px 6px", borderRadius: 4,
                    background: "rgba(200,170,90,0.12)", border: "1px solid rgba(200,170,90,0.3)", color: "#e8d8a8",
                  }}>{TIER_LABEL[l.tier]} · ${l.hourly_rate}/hr</span>
                  {!l.approved && (
                    <span style={{ fontSize: 9.5, padding: "2px 6px", borderRadius: 4, background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.35)", color: "#f87171" }}>
                      Pending approval
                    </span>
                  )}
                  {!l.active && (
                    <span style={{ fontSize: 9.5, padding: "2px 6px", borderRadius: 4, background: "rgba(148,163,184,0.12)", border: "1px solid rgba(148,163,184,0.3)", color: "#94a3b8" }}>
                      Inactive
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => toggleApproved(l)} style={{
                    ...actionBtnStyle,
                    color: l.approved ? "#4ade80" : "#94a3b8",
                    borderColor: l.approved ? "rgba(74,222,128,0.35)" : "rgba(255,255,255,0.10)",
                  }}>
                    {l.approved ? <CheckCircle2 size={11} /> : <XCircle size={11} />} {l.approved ? "Approved" : "Approve"}
                  </button>
                  <button onClick={() => toggleActive(l)} style={actionBtnStyle}>{l.active ? "Deactivate" : "Reactivate"}</button>
                  <button onClick={() => openEdit(l)} style={actionBtnStyle}><Pencil size={11} /> Edit</button>
                  <button onClick={() => remove(l)} style={{ ...actionBtnStyle, color: "#f87171" }}><Trash2 size={11} /></button>
                </div>
              </div>
              <div style={{ marginTop: 4, fontSize: 10.5, color: "#94a3b8" }}>
                {[l.phone, l.email].filter(Boolean).join(" · ") || "No contact info"}
                {l.trades ? ` · Trades: ${l.trades}` : ""}
              </div>
              {l.notes && <div style={{ marginTop: 2, fontSize: 10, color: "#6b7280" }}>{l.notes}</div>}

              {editingId === l.id && (
                <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <input placeholder="Full name" value={editDraft.name || ""}
                    onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))} style={inputStyle} />
                  <input placeholder="Phone" value={editDraft.phone || ""}
                    onChange={e => setEditDraft(d => ({ ...d, phone: e.target.value }))} style={inputStyle} />
                  <input placeholder="Email" value={editDraft.email || ""}
                    onChange={e => setEditDraft(d => ({ ...d, email: e.target.value }))} style={{ ...inputStyle, gridColumn: "1 / -1" }} />
                  <select value={editDraft.tier || "tier_1"}
                    onChange={e => setEditDraft(d => ({ ...d, tier: e.target.value }))} style={inputStyle}>
                    {(["tier_1", "tier_2", "tier_3"] as Tier[]).map(t => (
                      <option key={t} value={t}>{TIER_LABEL[t]}</option>
                    ))}
                  </select>
                  <input type="number" step="0.50" placeholder="Hourly rate" value={editDraft.hourly_rate ?? ""}
                    onChange={e => setEditDraft(d => ({ ...d, hourly_rate: parseFloat(e.target.value) || 0 }))} style={inputStyle} />
                  <input placeholder="Trades (comma-separated)" value={editDraft.trades || ""}
                    onChange={e => setEditDraft(d => ({ ...d, trades: e.target.value }))} style={{ ...inputStyle, gridColumn: "1 / -1" }} />
                  <input placeholder="Notes" value={editDraft.notes || ""}
                    onChange={e => setEditDraft(d => ({ ...d, notes: e.target.value }))} style={{ ...inputStyle, gridColumn: "1 / -1" }} />
                  <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button onClick={() => setEditingId(null)} style={actionBtnStyle}>Cancel</button>
                    <button onClick={() => saveEdit(l)} disabled={busy === l.id} style={{
                      ...actionBtnStyle, background: "rgba(200,170,90,0.15)", border: "1px solid rgba(200,170,90,0.5)", color: "#e8d8a8",
                      opacity: busy === l.id ? 0.5 : 1,
                    }}>{busy === l.id ? "Saving…" : "Save Changes"}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
