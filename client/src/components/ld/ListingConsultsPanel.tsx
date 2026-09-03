// v20.53.0 — Admin "Listing Consults" tab. Lets Alex/Nate see every Listing
// Consult regardless of status (in_progress, not_moving, archived, signed),
// filter by status, drill into full walkthrough details + photo gallery, and
// print a professional branded PDF report styled in the existing Brothers
// Group black-and-white look. Modeled directly on AccountsReceivablePanel.tsx.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCw, Home, FileText, ChevronLeft, Image as ImageIcon } from "lucide-react";
import { PdfViewerModal } from "./PdfViewerModal";

const GOLD = "#c8aa5a";

type ConsultRow = {
  id: number;
  property_address: string;
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  status: "in_progress" | "not_moving" | "archived" | "signed";
  hero_photo_url: string | null;
  agent_id: number | null;
  agent_name: string | null;
  created_at: string;
  updated_at: string;
  debrief_sent_at: string | null;
};

type ConsultDetail = ConsultRow & {
  gallery_photos: string[];
  scope_photos: string[];
  data: {
    prep?: any;
    walkthrough?: any;
    close?: any;
    lockin?: any;
  };
};

const actionBtnStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 6,
  fontSize: 11, fontWeight: 600, background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.12)", color: "#c7d1dd", cursor: "pointer",
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "in_progress", label: "In Progress" },
  { value: "signed", label: "Signed" },
  { value: "not_moving", label: "Not Moving" },
  { value: "archived", label: "Archived" },
];

const STATUS_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  in_progress: { color: "#facc15", bg: "rgba(250,204,21,0.08)", border: "rgba(250,204,21,0.3)" },
  signed: { color: "#4ade80", bg: "rgba(74,222,128,0.08)", border: "rgba(74,222,128,0.3)" },
  not_moving: { color: "#f87171", bg: "rgba(248,113,113,0.08)", border: "rgba(248,113,113,0.3)" },
  archived: { color: "#94a3b8", bg: "rgba(148,163,184,0.08)", border: "rgba(148,163,184,0.3)" },
};

function statusBadge(status: string) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.archived;
  return (
    <span style={{
      fontSize: 10.5, padding: "3px 8px", borderRadius: 4, textTransform: "capitalize",
      color: c.color, background: c.bg, border: `1px solid ${c.border}`,
    }}>{status.replace(/_/g, " ")}</span>
  );
}

function fieldBlock(label: string, value: any) {
  const val = value === true ? "Yes" : value === false ? "No" : (value && String(value).trim()) ? String(value) : "—";
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 12.5, color: "#e5e7eb", marginTop: 2 }}>{val}</div>
    </div>
  );
}

export function ListingConsultsPanel() {
  const [rows, setRows] = useState<ConsultRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [detail, setDetail] = useState<ConsultDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reportPdf, setReportPdf] = useState<{ url: string; title: string } | null>(null);

  const load = async (status: string) => {
    setLoading(true);
    try {
      const qs = status ? `?status=${status}` : "";
      const r = await fetch(`/api/admin/listing-consults${qs}`, { credentials: "include" });
      const d = await r.json();
      setRows(d.consults || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  const openDetail = async (id: number) => {
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/admin/listing-consults/${id}`, { credentials: "include" });
      const d = await r.json();
      setDetail(d);
    } finally {
      setDetailLoading(false);
    }
  };

  const printReport = (row: { id: number; property_address: string }) => {
    setReportPdf({
      url: `/api/admin/listing-consults/${row.id}/report-pdf`,
      title: `${row.property_address} — Listing Consult Report`,
    });
  };

  const counts = STATUS_FILTERS.reduce<Record<string, number>>((acc, f) => {
    acc[f.value] = f.value ? rows.filter(r => r.status === f.value).length : rows.length;
    return acc;
  }, {});

  if (detail) {
    const d = detail.data || {};
    const walkthrough = d.walkthrough || {};
    const close = d.close || {};
    const lockin = d.lockin || {};
    const allPhotos = [
      ...(detail.gallery_photos || []),
      ...(detail.scope_photos || []),
    ];
    return (
      <div>
        <button onClick={() => setDetail(null)} style={{ ...actionBtnStyle, marginBottom: 12 }}>
          <ChevronLeft size={12} /> Back to list
        </button>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: "#e5e7eb", display: "flex", alignItems: "center", gap: 6 }}>
              <Home size={14} color={GOLD} /> {detail.property_address}
            </h3>
            <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 4 }}>
              {detail.client_name || "—"} · Agent: {detail.agent_name || "—"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {statusBadge(detail.status)}
            <button onClick={() => printReport(detail)} style={{ ...actionBtnStyle, color: GOLD, borderColor: "rgba(200,170,90,0.4)", background: "rgba(200,170,90,0.08)" }}>
              <FileText size={12} /> Print Report
            </button>
          </div>
        </div>

        {detail.hero_photo_url && (
          <img src={detail.hero_photo_url} alt="Hero" style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 8, marginBottom: 14, border: "1px solid rgba(255,255,255,0.1)" }} />
        )}

        <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12, marginBottom: 12, background: "rgba(255,255,255,0.02)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#c7d1dd", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 }}>Overview</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
            {fieldBlock("Client Contact", [detail.client_email, detail.client_phone].filter(Boolean).join(" · "))}
            {fieldBlock("Created", detail.created_at?.slice(0, 10))}
            {detail.status === "signed" && fieldBlock("Signed Date", detail.debrief_sent_at?.slice(0, 10))}
          </div>
        </div>

        <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12, marginBottom: 12, background: "rgba(255,255,255,0.02)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#c7d1dd", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 }}>Walkthrough</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
            {fieldBlock("Needs Repairs", walkthrough.needsRepairs)}
            {fieldBlock("Timeline", walkthrough.timeline)}
            {fieldBlock("Mortgage Balance", walkthrough.mortgageBalance)}
            {fieldBlock("Buying Too", walkthrough.buyingToo)}
          </div>
          {fieldBlock("Notes", walkthrough.notes)}
        </div>

        <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12, marginBottom: 12, background: "rgba(255,255,255,0.02)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#c7d1dd", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 }}>Close</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
            {fieldBlock("Recommended Price", close.recommendedPrice)}
            {fieldBlock("Final Listing Price", close.finalListingPrice)}
          </div>
        </div>

        {(lockin.ownerNames || lockin.homeOccupied) && (
          <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12, marginBottom: 12, background: "rgba(255,255,255,0.02)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#c7d1dd", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 }}>Lock In</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
              {fieldBlock("Owner(s)", [lockin.ownerNames, lockin.ownerNames2].filter(Boolean).join(" & "))}
              {fieldBlock("Home Occupied", lockin.homeOccupied === "yes" ? true : lockin.homeOccupied === "no" ? false : null)}
            </div>
          </div>
        )}

        {allPhotos.length > 0 && (
          <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12, background: "rgba(255,255,255,0.02)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#c7d1dd", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3, display: "flex", alignItems: "center", gap: 5 }}>
              <ImageIcon size={12} /> Photos ({allPhotos.length})
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 6 }}>
              {allPhotos.map((url, i) => (
                <img key={i} src={url} alt={`Photo ${i + 1}`} style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)" }} />
              ))}
            </div>
          </div>
        )}

        {reportPdf && (
          <PdfViewerModal url={reportPdf.url} title={reportPdf.title} onClose={() => setReportPdf(null)} />
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb", display: "flex", alignItems: "center", gap: 6 }}>
          <Home size={13} color={GOLD} /> Listing Consults
        </h3>
        <button onClick={() => load(statusFilter)} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.10)",
          color: "#94a3b8", fontSize: 11, cursor: "pointer",
        }}><RefreshCw size={11} /> Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Every Listing Consult across all agents and statuses. Filter by status, drill into full walkthrough
        details and photos, and print a branded report for any one of them.
      </p>

      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            style={{
              ...actionBtnStyle,
              background: statusFilter === f.value ? "rgba(200,170,90,0.12)" : actionBtnStyle.background,
              borderColor: statusFilter === f.value ? "rgba(200,170,90,0.4)" : actionBtnStyle.border as string,
              color: statusFilter === f.value ? GOLD : actionBtnStyle.color,
            }}
          >{f.label} ({counts[f.value] ?? 0})</button>
        ))}
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading listing consults…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>No listing consults match this filter.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r) => (
            <div key={r.id} style={{
              border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12,
              background: "rgba(255,255,255,0.02)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb", display: "flex", alignItems: "center", gap: 6 }}>
                    <Home size={12} color={GOLD} /> {r.property_address}
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                    {r.client_name || "—"} · Agent: {r.agent_name || "—"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
                  {statusBadge(r.status)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                <button onClick={() => openDetail(r.id)} style={actionBtnStyle} disabled={detailLoading}>
                  View Details
                </button>
                <button onClick={() => printReport(r)} style={{ ...actionBtnStyle, color: GOLD, borderColor: "rgba(200,170,90,0.4)", background: "rgba(200,170,90,0.08)" }}>
                  <FileText size={11} /> Print Report
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {reportPdf && (
        <PdfViewerModal url={reportPdf.url} title={reportPdf.title} onClose={() => setReportPdf(null)} />
      )}
    </div>
  );
}
