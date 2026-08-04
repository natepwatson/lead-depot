// v20.4.8 — FUB tag → inventory bucket config panel.
// Lists all FUB tags. Admin selects a bucket per tag (pocket_listing / active_buyer / ignore)
// and toggles enabled. Nightly sweep only pulls from enabled+bucketed tags.
import { useEffect, useState } from "react";
import { RefreshCw, Tag as TagIcon, Play } from "lucide-react";

type TagRow = {
  name: string;
  peopleCount: number | null;
  bucket: "pocket_listing" | "active_buyer" | "ignore";
  enabled: boolean;
  last_synced_at: string | null;
  last_person_count: number | null;
};

export function FubTagConfigPanel() {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepResult, setSweepResult] = useState<any>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/fub/tags", { credentials: "include" });
      const d = await r.json();
      setTags(d.tags || []);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const save = async (row: TagRow, patch: Partial<TagRow>) => {
    const merged = { ...row, ...patch };
    setSaving(row.name);
    setTags(prev => prev.map(t => t.name === row.name ? merged : t));
    try {
      await fetch("/api/admin/fub/tag-config", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_name: row.name, bucket: merged.bucket, enabled: merged.enabled }),
      });
    } catch {} finally { setSaving(null); }
  };

  const runSweep = async () => {
    setSweepRunning(true); setSweepResult(null);
    try {
      const r = await fetch("/api/admin/fub/sweep", { method: "POST", credentials: "include" });
      setSweepResult(await r.json());
    } finally { setSweepRunning(false); load(); }
  };

  const bucketColor = (b: string) =>
    b === "pocket_listing" ? "#5eead4" :
    b === "active_buyer"   ? "#93c5fd" :
                             "#94a3b8";

  return (
    <div style={{ marginTop: 24, padding: 16, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
        <h3 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: "1.15rem", fontWeight: 300, color: "#fff" }}>
          FUB Tags → Inventory Buckets
        </h3>
        <button onClick={runSweep} disabled={sweepRunning}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 10px", borderRadius: 6,
            background: "rgba(20,184,166,0.10)", border: "1px solid rgba(20,184,166,0.4)",
            color: "#5eead4", fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
            cursor: sweepRunning ? "wait" : "pointer",
          }}
        >
          <Play size={12} /> {sweepRunning ? "Sweeping…" : "Run sweep now"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Pocket Listing tags feed the map's teal diamonds. Active Buyer tags feed the Inventory → Buyers list. Excel workbook wins conflicts (FUB fills gaps only).
      </p>

      {sweepResult && (
        <div style={{ marginBottom: 10, padding: 8, borderRadius: 6, background: "rgba(20,184,166,0.08)", border: "1px solid rgba(20,184,166,0.25)", fontSize: 11, color: "#c7d1dd" }}>
          Sweep processed {sweepResult.processed} · pockets {sweepResult.pockets} · buyers {sweepResult.buyers} · skipped {sweepResult.skipped}
          {sweepResult.errors?.length ? ` · ${sweepResult.errors.length} errors` : ""}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading FUB tags…</div>
      ) : tags.length === 0 ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>No FUB tags found. (Check FUB_API_KEY env var.)</div>
      ) : (
        <div style={{ maxHeight: 300, overflowY: "auto", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6 }}>
          <table style={{ width: "100%", fontSize: 12, color: "#c7d1dd" }}>
            <thead style={{ background: "rgba(255,255,255,0.03)", position: "sticky", top: 0 }}>
              <tr>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Tag</th>
                <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Bucket</th>
                <th style={{ textAlign: "center", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>On</th>
                <th style={{ textAlign: "right", padding: "6px 10px", fontWeight: 600, color: "#94a3b8" }}>Last sync</th>
              </tr>
            </thead>
            <tbody>
              {tags.map(t => (
                <tr key={t.name} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "6px 10px", color: "#e5e7eb", display: "flex", alignItems: "center", gap: 6 }}>
                    <TagIcon size={11} style={{ color: bucketColor(t.bucket) }} />
                    {t.name}
                  </td>
                  <td style={{ padding: "6px 10px" }}>
                    <select
                      value={t.bucket}
                      onChange={e => save(t, { bucket: e.target.value as any })}
                      disabled={saving === t.name}
                      style={{
                        padding: "3px 6px", borderRadius: 4,
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.10)",
                        color: bucketColor(t.bucket), fontSize: 11,
                      }}
                    >
                      <option value="ignore">ignore</option>
                      <option value="pocket_listing">pocket listing</option>
                      <option value="active_buyer">active buyer</option>
                    </select>
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      disabled={saving === t.name || t.bucket === "ignore"}
                      onChange={e => save(t, { enabled: e.target.checked })}
                    />
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "right", color: "#94a3b8", fontSize: 11 }}>
                    {t.last_synced_at ? `${t.last_person_count ?? 0} @ ${new Date(t.last_synced_at).toLocaleDateString()}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button onClick={load} style={{
        marginTop: 10, display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 10px", borderRadius: 6,
        background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
        color: "#94a3b8", fontSize: 11, cursor: "pointer",
      }}>
        <RefreshCw size={11} /> Refresh from FUB
      </button>
    </div>
  );
}
