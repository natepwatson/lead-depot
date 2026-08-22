// v20.31.0 — In-app PDF viewer modal. Root-cause fix for "PDF opens and I
// can't back out": Lead Depot is used as an installed home-screen PWA
// (standalone display mode). In standalone mode, iOS/Android treat
// window.open(url, "_blank") and <a target="_blank"> as a same-window
// navigation — there is no tab bar and no browser back button, so the app
// gets replaced by the PDF with no way back. Rendering the PDF inside an
// iframe in our own full-screen in-app overlay keeps the SPA mounted the
// entire time, so the gold "Close" button always works, in every browser
// and in standalone/home-screen mode alike. Use this for every PDF view
// action in the app instead of window.open/target=_blank.
import { useState } from "react";
import { X, ExternalLink } from "lucide-react";

const GOLD = "#c8aa5a";

export function PdfViewerModal({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 10000, background: "#0c0b0a",
        display: "flex", flexDirection: "column",
      }}
      role="dialog"
      aria-modal="true"
    >
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.12)",
        background: "#0c0b0a", flexShrink: 0,
      }}>
        <div style={{
          fontSize: 13, fontWeight: 700, color: "#e5e7eb",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {title}
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700,
              padding: "8px 11px", borderRadius: 7, border: "1px solid rgba(255,255,255,0.2)",
              color: "rgba(255,255,255,0.85)", textDecoration: "none", whiteSpace: "nowrap",
            }}
          >
            <ExternalLink size={13} /> Open
          </a>
          <button
            onClick={onClose}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 800,
              padding: "8px 14px", borderRadius: 7, border: "none", background: GOLD, color: "#0c0b0a",
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            <X size={14} /> Close
          </button>
        </div>
      </div>
      <div style={{ flex: 1, position: "relative", background: "#3a3a3a" }}>
        {!loaded && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            color: "rgba(255,255,255,0.55)", fontSize: 12.5,
          }}>
            Loading PDF…
          </div>
        )}
        <iframe
          src={url}
          title={title}
          onLoad={() => setLoaded(true)}
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
        />
      </div>
    </div>
  );
}
