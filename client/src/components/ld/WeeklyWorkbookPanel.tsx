// v20.4.9 — Weekly Workbook upload panel.
// One .xlsx file with tabs: Closed / Sellers / Buyers.
// Server-side color classifier maps red→skip, green→sold/closed, white→active,
// yellow→coming_soon (sellers only), blue→pocket (sellers only).
import { useRef, useState } from "react";
import { Upload, CheckCircle2, AlertTriangle } from "lucide-react";

type ParseResult = {
  ok: boolean;
  sellers: { inserted: number; updated: number; skipped: number; by_color: Record<string, number> };
  buyers:  { inserted: number; updated: number; skipped: number; by_color: Record<string, number> };
  warnings: string[];
};

export function WeeklyWorkbookPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upload = async (f: File) => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/admin/inventory/workbook", { method: "POST", body: fd, credentials: "include" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Upload failed");
      setResult(data);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 24, padding: 16, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.15rem", fontWeight: 300, color: "#fff", marginBottom: 4 }}>
        Weekly Workbook — Sellers + Buyers
      </h3>
      <p className="text-xs text-muted-foreground mb-3">
        One .xlsx from Denise. Tab 1 = Closed (ignored). Tab 2 = Sellers (red=expired skip · green=sold · white=active · yellow=coming soon · blue=pocket). Tab 3 = Buyers (green=closed · white=on the hunt). Excel wins conflicts with FUB.
      </p>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "8px 14px", borderRadius: 8,
          background: "rgba(200,170,90,0.12)",
          border: "1px solid rgba(200,170,90,0.5)",
          color: "#c8aa5a", fontSize: 12, fontWeight: 600, letterSpacing: 0.4,
          cursor: busy ? "wait" : "pointer",
        }}
      >
        <Upload size={14} />
        {busy ? "Parsing…" : "Upload weekly workbook (.xlsx)"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
      />

      {err && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: "rgba(220,38,38,0.10)", border: "1px solid rgba(220,38,38,0.35)", color: "#fca5a5", fontSize: 12, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {err}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: "rgba(107,142,90,0.08)", border: "1px solid rgba(107,142,90,0.30)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#a3c48f", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
            <CheckCircle2 size={14} /> Workbook parsed successfully
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 12, color: "#c7d1dd" }}>
            <div>
              <div style={{ fontWeight: 600, color: "#e5c67a", marginBottom: 4 }}>Sellers</div>
              <div>Inserted: {result.sellers.inserted}</div>
              <div>Updated: {result.sellers.updated}</div>
              <div>Skipped: {result.sellers.skipped}</div>
              <div style={{ marginTop: 4, color: "#94a3b8", fontSize: 11 }}>
                {Object.entries(result.sellers.by_color).map(([k,v]) => `${k}:${v}`).join(" · ")}
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 600, color: "#5eead4", marginBottom: 4 }}>Buyers</div>
              <div>Inserted: {result.buyers.inserted}</div>
              <div>Updated: {result.buyers.updated}</div>
              <div>Skipped: {result.buyers.skipped}</div>
              <div style={{ marginTop: 4, color: "#94a3b8", fontSize: 11 }}>
                {Object.entries(result.buyers.by_color).map(([k,v]) => `${k}:${v}`).join(" · ")}
              </div>
            </div>
          </div>
          {result.warnings.length > 0 && (
            <details style={{ marginTop: 10, fontSize: 11, color: "#f5a524" }}>
              <summary style={{ cursor: "pointer" }}>{result.warnings.length} warning(s)</summary>
              <ul style={{ marginTop: 6, paddingLeft: 16, color: "#c7d1dd" }}>
                {result.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
