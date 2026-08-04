// v20.4.8 — Listings panel for the admin Upload CSV tab.
// Denise uploads active/pending/sold listings every Monday via this section.
// Active listings become candidates on Tuesday's Open House Schedule.
import { useState, useRef, useEffect } from "react";
import { Upload, Home, Trash2 } from "lucide-react";

type Listing = {
  id: number;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  list_price: number | null;
  status: "active" | "pending" | "sold";
  listing_agent: string | null;
  list_date: string | null;
  pending_date: string | null;
  sold_date: string | null;
  sold_price: number | null;
  mls_number: string | null;
  notes: string | null;
  lat: number | null;
  lng: number | null;
  uploaded_by: string | null;
  updated_at: string | null;
};

const fetchJson = async (url: string, opts: RequestInit = {}) => {
  const r = await fetch(url, { credentials: "include", ...opts });
  if (!r.ok) throw new Error(await r.text().catch(() => `HTTP ${r.status}`));
  return r.json();
};

function csvParseSmart(csv: string): Array<Record<string, string>> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const parseLine = (line: string): string[] => {
    const out: string[] = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { rec[h] = (cells[i] || "").trim(); });
    return rec;
  });
}

// Map many possible column headers → normalized keys.
const HEADER_MAP: Record<string, string> = {
  "address": "address", "property address": "address", "street": "address", "street address": "address",
  "city": "city",
  "state": "state", "st": "state",
  "zip": "zip", "zip code": "zip", "postal code": "zip", "zipcode": "zip",
  "list price": "list_price", "listing price": "list_price", "price": "list_price", "listprice": "list_price",
  "status": "status", "listing status": "status",
  "listing agent": "listing_agent", "agent": "listing_agent", "list agent": "listing_agent",
  "list date": "list_date", "listing date": "list_date",
  "pending date": "pending_date",
  "sold date": "sold_date", "close date": "sold_date", "closing date": "sold_date",
  "sold price": "sold_price", "close price": "sold_price",
  "mls": "mls_number", "mls number": "mls_number", "mls #": "mls_number",
  "notes": "notes",
};

function normalizeRow(row: Record<string, string>, defaultStatus: "active" | "pending" | "sold"): any {
  const out: any = {};
  for (const [k, v] of Object.entries(row)) {
    const mapped = HEADER_MAP[k.toLowerCase().trim()];
    if (mapped && v) out[mapped] = v;
  }
  if (!out.status) out.status = defaultStatus;
  return out;
}

const money = (n: number | null) => n ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—";

export function ListingsPanel() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"active" | "pending" | "sold">("active");
  const [uploadMsg, setUploadMsg] = useState<string>("");
  const [filter, setFilter] = useState<"active" | "pending" | "sold" | "all">("active");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const url = filter === "all" ? "/api/admin/listings" : `/api/admin/listings?status=${filter}`;
      const data = await fetchJson(url);
      setListings(data.listings || []);
    } catch (e: any) { console.error("[listings] load failed:", e?.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [filter]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadMsg("Parsing…");
    try {
      const text = await file.text();
      const rows = csvParseSmart(text).map((r) => normalizeRow(r, uploadStatus));
      const valid = rows.filter((r) => r.address);
      if (!valid.length) { setUploadMsg("No valid rows found — check the address column."); setUploading(false); return; }
      setUploadMsg(`Uploading ${valid.length} rows…`);
      const res = await fetchJson("/api/admin/listings/bulk", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: valid }),
      });
      setUploadMsg(`✓ Imported ${res.imported} listings${res.failed ? ` (${res.failed} failed)` : ""}. Geocoding runs in background.`);
      await load();
    } catch (err: any) {
      setUploadMsg(`Upload failed: ${err?.message || "unknown"}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleDelete = async (id: number, address: string) => {
    if (!confirm(`Delete listing:\n${address}?`)) return;
    try {
      await fetchJson(`/api/admin/listings/${id}`, { method: "DELETE" });
      await load();
    } catch (e: any) { alert(`Delete failed: ${e?.message}`); }
  };

  const handleForceGeocode = async () => {
    setUploadMsg("Geocoding…");
    try {
      const res = await fetchJson("/api/admin/listings/geocode", { method: "POST" });
      setUploadMsg(`✓ Geocoded ${res.geocoded}/${res.missing}`);
      await load();
    } catch (e: any) { setUploadMsg(`Geocode failed: ${e?.message}`); }
  };

  const counts = {
    active: listings.filter(l => l.status === "active").length,
    pending: listings.filter(l => l.status === "pending").length,
    sold: listings.filter(l => l.status === "sold").length,
  };

  return (
    <div style={{ marginTop: 40, paddingTop: 32, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Home size={18} style={{ color: "#c8aa5a" }} />
        <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.3rem", fontWeight: 300, color: "#fff", margin: 0 }}>
          Listings
        </h2>
      </div>
      <p className="text-sm text-muted-foreground" style={{ marginBottom: 20 }}>
        Denise uploads active/pending/sold listings every Monday. Active listings show on the team map and become candidates on Tuesday's Open House Schedule.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {(["active", "pending", "sold"] as const).map((s) => (
          <button key={s} onClick={() => setUploadStatus(s)}
            style={{
              padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 500, letterSpacing: "0.04em",
              border: "1px solid",
              borderColor: uploadStatus === s ? "rgba(200,170,90,0.5)" : "rgba(255,255,255,0.1)",
              background: uploadStatus === s ? "rgba(200,170,90,0.1)" : "rgba(255,255,255,0.03)",
              color: uploadStatus === s ? "#c8aa5a" : "rgba(255,255,255,0.5)",
              cursor: "pointer", textTransform: "uppercase",
            }}>
            Upload as {s}
          </button>
        ))}
      </div>

      <div
        style={{
          border: "2px dashed rgba(255,255,255,0.1)", borderRadius: 10, padding: "32px 20px",
          textAlign: "center", cursor: "pointer", marginBottom: 12,
        }}
        onClick={() => !uploading && fileRef.current?.click()}
      >
        <Upload style={{ margin: "0 auto 8px", color: "rgba(255,255,255,0.3)" }} size={22} />
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", margin: 0 }}>
          {uploading ? "Uploading…" : `Click to upload a CSV of ${uploadStatus.toUpperCase()} listings`}
        </p>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 6 }}>
          Columns: Address, City, State, Zip, List Price, Listing Agent, MLS #, Notes
        </p>
      </div>
      <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} />

      {uploadMsg && (
        <div style={{ fontSize: 12, color: "rgba(200,170,90,0.85)", marginBottom: 12 }}>{uploadMsg}</div>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {(["active", "pending", "sold", "all"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            style={{
              padding: "5px 12px", borderRadius: 6, fontSize: 11, letterSpacing: "0.06em",
              border: "1px solid",
              borderColor: filter === f ? "rgba(200,170,90,0.4)" : "rgba(255,255,255,0.08)",
              background: filter === f ? "rgba(200,170,90,0.08)" : "transparent",
              color: filter === f ? "#c8aa5a" : "rgba(255,255,255,0.5)",
              cursor: "pointer", textTransform: "uppercase",
            }}>
            {f} {f !== "all" && `(${counts[f]})`}
          </button>
        ))}
        <button onClick={handleForceGeocode}
          style={{
            marginLeft: "auto", padding: "5px 12px", borderRadius: 6, fontSize: 10, letterSpacing: "0.1em",
            textTransform: "uppercase", color: "rgba(255,255,255,0.5)",
            background: "transparent", border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer",
          }}>
          Force Geocode
        </button>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>Loading…</div>
      ) : listings.length === 0 ? (
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", padding: 20, textAlign: "center", border: "1px dashed rgba(255,255,255,0.06)", borderRadius: 8 }}>
          No listings yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {listings.map((l) => (
            <div key={l.id} style={{
              display: "grid", gridTemplateColumns: "auto 1fr auto auto auto",
              gap: 10, alignItems: "center",
              padding: "10px 14px", borderRadius: 8,
              background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)",
            }}>
              <span style={{
                fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600,
                padding: "3px 8px", borderRadius: 4,
                background: l.status === "active" ? "rgba(100,200,120,0.12)" : l.status === "pending" ? "rgba(200,170,90,0.12)" : "rgba(140,140,140,0.12)",
                color: l.status === "active" ? "#7ed49a" : l.status === "pending" ? "#c8aa5a" : "#999",
              }}>{l.status}</span>
              <div>
                <div style={{ fontSize: 13, color: "#fff" }}>{l.address}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                  {[l.city, l.state, l.zip].filter(Boolean).join(", ")}
                  {l.listing_agent ? ` · ${l.listing_agent}` : ""}
                  {l.lat && l.lng ? " · 📍" : ""}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", textAlign: "right" }}>
                {l.status === "sold" ? money(l.sold_price) : money(l.list_price)}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>
                {(l.list_date || l.sold_date || "").slice(0, 10)}
              </div>
              <button onClick={() => handleDelete(l.id, l.address)}
                style={{ background: "transparent", border: "none", color: "rgba(255,90,90,0.5)", cursor: "pointer", padding: 4 }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
