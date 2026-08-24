// v20.32.13 — Smart Data: property characteristics (heated/cooled sqft, lot
// size, effective sqft, etc.) surfaced wherever a repair consult or
// inspection order needs them. Per Alex's data-sourcing priority:
//   1. County records — pushed in from a Perplexity property-appraiser-lookup
//      session via POST /api/smart-data (source: "county_record"). Lead Depot
//      itself has no browser-automation ability to run a live county lookup,
//      so this is populated out-of-band, not scraped in-app.
//   2. Sales package cross-check — same push path (source: "sales_package"),
//      since the sales package already prints the county record for review.
//   3. Manual fallback — if neither of the above has answers, the agent must
//      enter the two minimum-required fields themselves right here:
//      heated/cooled sqft + lot size (acreage preferred).
// Effective sqft is optional but valuable — it's the basis for estimating
// scope on ancillary areas (garage, patios, etc.) for painting/flooring.
import { useEffect, useState } from "react";
import { Loader2, MapPin, Pencil, CheckCircle2, AlertTriangle } from "lucide-react";

const GOLD = "#c8aa5a";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, fontSize: 12.5,
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff",
};
const labelStyle: React.CSSProperties = { fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 3 };

const SOURCE_LABELS: Record<string, string> = {
  county_record: "County Record", sales_package: "Sales Package", manual: "Manual Entry",
};
const SOURCE_COLORS: Record<string, string> = {
  county_record: "#7ed49a", sales_package: "#8ab4f8", manual: "#e8d8a8",
};

export type SmartData = {
  found: boolean; propertyAddress: string;
  lotSizeAcres: number | null; lotSizeSqft: number | null;
  heatedSqft: number | null; cooledSqft: number | null; effectiveSqft: number | null;
  stories: number | null; bedrooms: number | null; bathrooms: number | null; yearBuilt: number | null;
  source: string | null; sourceUrl: string | null; verifiedBy: string | null; verifiedAt: string | null;
  hasMinimumRequired: boolean;
};

export function SmartDataPanel({ propertyAddress, onChange }: { propertyAddress: string; onChange?: (d: SmartData) => void }) {
  const [data, setData] = useState<SmartData | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ heatedSqft: "", cooledSqft: "", lotSizeAcres: "", effectiveSqft: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!propertyAddress.trim()) { setData(null); return; }
    setLoading(true);
    try {
      const r = await fetch(`/api/smart-data?propertyAddress=${encodeURIComponent(propertyAddress.trim())}`, { credentials: "include" });
      const d = await r.json();
      setData(d);
      onChange?.(d);
      setDraft({
        heatedSqft: d.heatedSqft != null ? String(d.heatedSqft) : "",
        cooledSqft: d.cooledSqft != null ? String(d.cooledSqft) : "",
        lotSizeAcres: d.lotSizeAcres != null ? String(d.lotSizeAcres) : "",
        effectiveSqft: d.effectiveSqft != null ? String(d.effectiveSqft) : "",
      });
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [propertyAddress]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch("/api/smart-data", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyAddress: propertyAddress.trim(),
          heatedSqft: draft.heatedSqft !== "" ? parseFloat(draft.heatedSqft) : null,
          cooledSqft: draft.cooledSqft !== "" ? parseFloat(draft.cooledSqft) : null,
          lotSizeAcres: draft.lotSizeAcres !== "" ? parseFloat(draft.lotSizeAcres) : null,
          effectiveSqft: draft.effectiveSqft !== "" ? parseFloat(draft.effectiveSqft) : null,
          source: "manual",
        }),
      });
      const d = await r.json();
      setData(d);
      onChange?.(d);
      setEditing(false);
    } finally { setSaving(false); }
  };

  if (!propertyAddress.trim()) return null;

  return (
    <div style={{ marginBottom: 14, padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.10)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <MapPin size={13} style={{ color: GOLD }} />
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "#fff" }}>Smart Data</span>
          {loading && <Loader2 size={12} className="animate-spin" style={{ color: "#94a3b8" }} />}
          {data?.source && (
            <span style={{
              fontSize: 9.5, fontWeight: 700, padding: "2px 6px", borderRadius: 999,
              background: `${SOURCE_COLORS[data.source]}22`, color: SOURCE_COLORS[data.source],
            }}>{SOURCE_LABELS[data.source] || data.source}</span>
          )}
        </div>
        <button type="button" onClick={() => setEditing(e => !e)} style={{
          display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6,
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
          color: "#94a3b8", fontSize: 10.5, cursor: "pointer",
        }}><Pencil size={10} /> {editing ? "Cancel" : "Edit"}</button>
      </div>

      {!editing ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 11.5 }}>
            <div><span style={{ color: "#94a3b8" }}>Heated Sqft: </span><span style={{ color: "#fff", fontWeight: 600 }}>{data?.heatedSqft ?? "—"}</span></div>
            <div><span style={{ color: "#94a3b8" }}>Cooled Sqft: </span><span style={{ color: "#fff", fontWeight: 600 }}>{data?.cooledSqft ?? "—"}</span></div>
            <div><span style={{ color: "#94a3b8" }}>Lot (acres): </span><span style={{ color: "#fff", fontWeight: 600 }}>{data?.lotSizeAcres ?? "—"}</span></div>
            <div><span style={{ color: "#94a3b8" }}>Effective Sqft: </span><span style={{ color: "#fff", fontWeight: 600 }}>{data?.effectiveSqft ?? "—"}</span></div>
            <div><span style={{ color: "#94a3b8" }}>Year Built: </span><span style={{ color: "#fff", fontWeight: 600 }}>{data?.yearBuilt ?? "—"}</span></div>
            <div><span style={{ color: "#94a3b8" }}>Beds/Baths: </span><span style={{ color: "#fff", fontWeight: 600 }}>{data?.bedrooms ?? "—"}/{data?.bathrooms ?? "—"}</span></div>
          </div>
          {data && !data.hasMinimumRequired && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8, fontSize: 10.5, color: "#f0b060" }}>
              <AlertTriangle size={11} /> Minimum required data missing — enter heated sqft + lot size (acres or sqft) manually.
            </div>
          )}
          {data && data.hasMinimumRequired && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8, fontSize: 10.5, color: "#7ed49a" }}>
              <CheckCircle2 size={11} /> Minimum required data on file.
            </div>
          )}
        </>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label>
            <span style={labelStyle}>Heated Sqft *</span>
            <input type="number" style={inputStyle} value={draft.heatedSqft} onChange={e => setDraft(d => ({ ...d, heatedSqft: e.target.value }))} />
          </label>
          <label>
            <span style={labelStyle}>Cooled Sqft</span>
            <input type="number" style={inputStyle} value={draft.cooledSqft} onChange={e => setDraft(d => ({ ...d, cooledSqft: e.target.value }))} />
          </label>
          <label>
            <span style={labelStyle}>Lot Size (acres) *</span>
            <input type="number" step="0.01" style={inputStyle} value={draft.lotSizeAcres} onChange={e => setDraft(d => ({ ...d, lotSizeAcres: e.target.value }))} />
          </label>
          <label>
            <span style={labelStyle}>Effective Sqft</span>
            <input type="number" style={inputStyle} value={draft.effectiveSqft} onChange={e => setDraft(d => ({ ...d, effectiveSqft: e.target.value }))} />
          </label>
          <p style={{ gridColumn: "1 / -1", fontSize: 10, color: "rgba(255,255,255,0.35)", margin: 0 }}>
            * Minimum required if no county record or sales package data is on file.
          </p>
          <button type="button" onClick={save} disabled={saving} style={{
            gridColumn: "1 / -1", padding: "7px 10px", borderRadius: 6, background: "rgba(200,170,90,0.15)",
            border: "1px solid rgba(200,170,90,0.4)", color: "#e8d8a8", fontSize: 11, fontWeight: 600, cursor: "pointer",
          }}>{saving ? "Saving…" : "Save Smart Data"}</button>
        </div>
      )}
    </div>
  );
}
