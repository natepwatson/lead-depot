// v20.14.5 — Shared "resume an in-progress consult" picker, used inside both
// ListingConsultSheet and RepairConsultSheet. Renders as an inline block, not
// its own modal shell — the parent sheet keeps owning the backdrop/sheet
// chrome so this drops straight into the existing full-screen wizard frame.
import { Loader2, Clock, Plus } from "lucide-react";

const GOLD = "#c8aa5a";

export type ResumeItem = {
  id: number;
  property_address: string;
  client_name?: string | null;
  status?: string;
  updated_at: string;
};

const STATUS_LABELS: Record<string, string> = {
  draft: "In progress",
  quoted: "Quote generated",
  sent: "Sent to client",
  in_progress: "In progress",
};

function timeAgo(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function ConsultResumePicker({
  title, subtitle, items, onResume, onStartNew,
}: {
  title: string;
  subtitle: string;
  items: ResumeItem[];
  onResume: (id: number) => void;
  onStartNew: () => void;
}) {
  return (
    <div>
      <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 24, fontWeight: 400, color: "#fff", margin: 0 }}>{title}</h2>
      <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.45)", marginTop: 4, marginBottom: 18 }}>{subtitle}</p>
      {items.map(it => (
        <button key={it.id} type="button" onClick={() => onResume(it.id)} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", textAlign: "left",
          padding: "14px 16px", borderRadius: 12, marginBottom: 10, cursor: "pointer",
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(200,170,90,0.25)", color: "#fff",
        }}>
          <div style={{ flex: 1, minWidth: 0, marginRight: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.property_address}</div>
            <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.45)", marginTop: 3 }}>
              {it.client_name ? `${it.client_name} · ` : ""}{STATUS_LABELS[it.status || ""] || "In progress"}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, color: GOLD, fontSize: 11, flexShrink: 0 }}>
            <Clock size={12} /> {timeAgo(it.updated_at)}
          </div>
        </button>
      ))}
      <button type="button" onClick={onStartNew} style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%",
        padding: "14px 16px", borderRadius: 12, cursor: "pointer", marginTop: items.length > 0 ? 8 : 0,
        background: GOLD, border: "none", color: "#0c0b0a", fontSize: 13.5, fontWeight: 700,
      }}><Plus size={16} /> Start New</button>
    </div>
  );
}

export function ResumeCheckingSpinner() {
  return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <Loader2 size={22} className="animate-spin" style={{ color: GOLD }} />
    </div>
  );
}
