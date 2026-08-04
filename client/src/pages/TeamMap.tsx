// v20.4.2 — Team Map (real, authentic, tap-to-open pins).
//
// Data comes from /api/team-map/pins. The server returns REAL coordinates for
// every geocoded lead. Owner name, phone, and street number are masked for
// non-admin viewers; city + ZIP + status are always visible so the map feels
// authentic to agents without exposing enough to poach leads. Admins see
// everything unredacted.
import { useEffect, useRef, useState } from "react";

interface Pin {
  id: number;
  lat: number;
  lng: number;
  tier: "appt" | "contact" | "pool";
  status: string;
  city: string;
  zip: string;
  state: string;
  type: string | null;
  ownerName: string | null;
  phone: string | null;
  address: string | null;
  assignedAgentId: number | null;
  assignedAgentName: string | null;
}
interface Totals { total: number; appt: number; contact: number; pool: number; }

const NE_FL = { lat: 30.18, lng: -81.65, zoom: 10 };

const TIER: Record<string, { fill: string; label: string; short: string }> = {
  appt:    { fill: "#6daa45", label: "Appointments Set", short: "Appts" },
  contact: { fill: "#c8aa5a", label: "Active / Working", short: "Working" },
  pool:    { fill: "#4f98a3", label: "Pool / Coverage",  short: "Coverage" },
};

// Load Leaflet from unpkg (already whitelisted in CSP per v15.11.1).
let lfLoaded = false; let lfProm: Promise<void> | null = null;
function loadLF(): Promise<void> {
  if (lfLoaded) return Promise.resolve();
  if (lfProm) return lfProm;
  lfProm = new Promise((res, rej) => {
    if (!document.getElementById("lf-css")) {
      const l = document.createElement("link"); l.id = "lf-css";
      l.rel = "stylesheet"; l.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(l);
    }
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = () => { lfLoaded = true; res(); }; s.onerror = rej;
    document.head.appendChild(s);
  });
  return lfProm;
}

function makePin(fill: string, size: number, L: any) {
  const svg = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${fill};box-shadow:0 0 0 2px rgba(0,0,0,0.4),0 2px 8px rgba(0,0,0,0.6);border:1.5px solid rgba(255,255,255,0.6);cursor:pointer"></div>`;
  return L.divIcon({ html: svg, className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function popupHTML(p: Pin, viewerIsAdmin: boolean) {
  const tierColor = TIER[p.tier].fill;
  const identityRow = viewerIsAdmin
    ? `<div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;color:#fff;font-weight:600;letter-spacing:0.01em;line-height:1.15;margin-bottom:2px">${p.ownerName || "Unknown"}</div>`
    : `<div style="font-family:ui-monospace,'JetBrains Mono',monospace;font-size:14px;color:rgba(255,255,255,0.55);letter-spacing:0.12em;line-height:1.15;margin-bottom:2px">${p.ownerName || "•••••••••"}</div>`;

  const phoneRow = viewerIsAdmin
    ? `<div style="font-family:ui-monospace,'JetBrains Mono',monospace;font-size:11px;color:rgba(255,255,255,0.85);letter-spacing:0.02em">${p.phone || "—"}</div>`
    : `<div style="font-family:ui-monospace,'JetBrains Mono',monospace;font-size:11px;color:rgba(255,255,255,0.35);letter-spacing:0.06em">${p.phone || "(•••) •••-••••"}</div>`;

  const streetRow = viewerIsAdmin
    ? `<div style="font-size:11px;color:rgba(255,255,255,0.75)">${p.address || "—"}</div>`
    : `<div style="font-size:11px;color:rgba(255,255,255,0.35);font-family:ui-monospace,'JetBrains Mono',monospace;letter-spacing:0.04em">${p.address || "•••• ••••••••"}</div>`;

  const cityLine = `${p.city}${p.city && p.zip ? ", " : ""}${p.state} ${p.zip}`.trim();

  const assignedRow = p.assignedAgentName
    ? `<div style="display:inline-block;padding:2px 8px;border-radius:6px;background:rgba(200,170,90,0.14);border:1px solid rgba(200,170,90,0.3);font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#c8aa5a;font-weight:700;margin-top:6px">${p.assignedAgentName}</div>`
    : `<div style="display:inline-block;padding:2px 8px;border-radius:6px;background:rgba(79,152,163,0.14);border:1px solid rgba(79,152,163,0.3);font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#4f98a3;font-weight:700;margin-top:6px">In Pool</div>`;

  return `
    <div style="min-width:220px;max-width:260px;padding:2px 2px 4px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tierColor};box-shadow:0 0 6px ${tierColor}"></span>
        <span style="font-size:9px;letter-spacing:0.22em;color:${tierColor};font-weight:800;text-transform:uppercase">${p.status}</span>
      </div>
      ${identityRow}
      ${phoneRow}
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(200,170,90,0.35),transparent);margin:8px 0"></div>
      ${streetRow}
      <div style="font-size:11px;color:rgba(255,255,255,0.9);margin-top:2px;font-weight:600">${cityLine}</div>
      ${assignedRow}
      ${!viewerIsAdmin ? '<div style="margin-top:8px;font-size:9px;letter-spacing:0.14em;color:rgba(200,170,90,0.55);text-transform:uppercase;font-weight:700">Pull the lead to unmask →</div>' : ""}
    </div>
  `;
}

export default function TeamMap() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const hasFitRef = useRef(false);
  const [pins, setPins] = useState<Pin[]>([]);
  const [totals, setTotals] = useState<Totals>({ total: 0, appt: 0, contact: 0, pool: 0 });
  const [viewerIsAdmin, setViewerIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lfReady, setLfReady] = useState(false);
  const [err, setErr] = useState("");
  const [tierFilter, setTierFilter] = useState<"all" | "appt" | "contact" | "pool">("all");

  useEffect(() => {
    loadLF().then(() => setLfReady(true)).catch(() => setErr("Failed to load map."));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/team-map/pins")
      .then(r => r.json())
      .then((d: any) => {
        if (cancelled) return;
        setPins(d.pins || []);
        setTotals(d.totals || { total: 0, appt: 0, contact: 0, pool: 0 });
        setViewerIsAdmin(!!d.viewerIsAdmin);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setErr("Failed to load pins."); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!lfReady || !mapDiv.current || mapRef.current) return;
    const L = (window as any).L;
    const map = L.map(mapDiv.current, {
      center: [NE_FL.lat, NE_FL.lng], zoom: NE_FL.zoom,
      // v20.4.2 — real map. Users can zoom in as far as tiles support so the
      // pin sitting on the actual lot feels honest. Popup masking keeps PII safe.
      maxZoom: 19, minZoom: 8,
      scrollWheelZoom: true, doubleClickZoom: true,
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd", maxZoom: 19,
    }).addTo(map);
    const attr = map.getContainer().querySelector(".leaflet-control-attribution") as HTMLElement;
    if (attr) { attr.style.background = "rgba(8,8,8,0.7)"; attr.style.color = "#444"; attr.style.fontSize = "9px"; }
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
  }, [lfReady]);

  useEffect(() => {
    if (!mapRef.current || !layerRef.current) return;
    const L = (window as any).L; if (!L) return;
    const map = mapRef.current;
    layerRef.current.clearLayers();
    const filtered = pins.filter(p => tierFilter === "all" || p.tier === tierFilter);
    for (const p of filtered) {
      const size = p.tier === "appt" ? 14 : p.tier === "contact" ? 11 : 8;
      const marker = L.marker([p.lat, p.lng], { icon: makePin(TIER[p.tier].fill, size, L) })
        .bindPopup(popupHTML(p, viewerIsAdmin), {
          className: "team-map-popup",
          maxWidth: 280,
          autoPan: true,
          closeButton: true,
        })
        .addTo(layerRef.current);
      // No hover binding on mobile — click/tap opens popup naturally.
      marker;
    }
    if (!hasFitRef.current && filtered.length > 0) {
      hasFitRef.current = true;
      try {
        const bounds = L.latLngBounds(filtered.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
      } catch (_) { /* ignore */ }
    }
  }, [pins, lfReady, tierFilter, viewerIsAdmin]);

  const filterCount = tierFilter === "all" ? totals.total
                    : tierFilter === "appt" ? totals.appt
                    : tierFilter === "contact" ? totals.contact
                    : totals.pool;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style>{`
        .team-map-popup .leaflet-popup-content-wrapper {
          background: linear-gradient(155deg, #0f1a12 0%, #0a1010 100%);
          border: 1px solid rgba(200,170,90,0.45);
          border-radius: 12px;
          box-shadow: 0 12px 40px -8px rgba(0,0,0,0.9), 0 0 0 1px rgba(200,170,90,0.12) inset;
          color: #fff;
          padding: 8px 12px;
        }
        .team-map-popup .leaflet-popup-content { margin: 0; }
        .team-map-popup .leaflet-popup-tip {
          background: #0a1010;
          border: 1px solid rgba(200,170,90,0.45);
        }
        .team-map-popup .leaflet-popup-close-button {
          color: rgba(200,170,90,0.7) !important;
          font-size: 18px;
          padding: 4px 8px 0 0;
        }
      `}</style>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 22, fontWeight: 300, color: "#fff", lineHeight: 1, letterSpacing: "0.04em" }}>Territory Map</h2>
          <p style={{ fontSize: 11, color: "rgba(200,170,90,0.55)", marginTop: 4, letterSpacing: "0.08em" }}>Every geocoded lead · Northeast Florida</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ padding: "5px 12px", background: "rgba(109,170,69,0.1)", border: "1px solid rgba(109,170,69,0.25)", borderRadius: 20, fontSize: 11, color: "#6daa45", letterSpacing: "0.04em" }}>{totals.appt} appts</div>
          <div style={{ padding: "5px 12px", background: "rgba(200,170,90,0.08)", border: "1px solid rgba(200,170,90,0.2)", borderRadius: 20, fontSize: 11, color: "#c8aa5a" }}>{totals.total} pins</div>
          {loading && <div style={{ padding: "5px 12px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, fontSize: 11, color: "#797876" }}>Loading…</div>}
        </div>
      </div>

      {/* Filter chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 10px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 8 }}>
        {(["all","appt","contact","pool"] as const).map(k => {
          const active = tierFilter === k;
          const label = k === "all" ? "All" : k === "appt" ? "Appts" : k === "contact" ? "Working" : "Pool";
          const count = k === "all" ? totals.total : k === "appt" ? totals.appt : k === "contact" ? totals.contact : totals.pool;
          const color = k === "all" ? "#c8aa5a" : TIER[k].fill;
          return (
            <button
              key={k}
              onClick={() => { setTierFilter(k); hasFitRef.current = false; }}
              style={{
                padding: "5px 12px",
                borderRadius: 20,
                fontSize: 10.5,
                letterSpacing: "0.06em",
                fontWeight: 600,
                cursor: "pointer",
                border: active ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.08)",
                background: active ? `${color}22` : "rgba(0,0,0,0.28)",
                color: active ? color : "rgba(255,255,255,0.55)",
              }}
            >{label} <span style={{ opacity: 0.6, marginLeft: 4 }}>{count}</span></button>
          );
        })}
      </div>

      {/* Map container */}
      <div style={{ height: "calc(100vh - 340px)", minHeight: 440, position: "relative", borderRadius: 10, overflow: "hidden", border: "1px solid rgba(200,170,90,0.15)" }}>
        <div ref={mapDiv} style={{ width: "100%", height: "100%", background: "#080808" }} />

        {(loading || !lfReady) && !err && (
          <div style={{ position: "absolute", inset: 0, background: "#080808", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, zIndex: 1000 }}>
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.4"/>
              <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
              <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.2"/>
            </svg>
            <p style={{ fontSize: 11, color: "rgba(200,170,90,0.5)", letterSpacing: "0.14em" }}>LOADING MAP…</p>
          </div>
        )}
        {err && (
          <div style={{ position: "absolute", inset: 0, background: "#080808", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <p style={{ fontSize: 12, color: "#dd6974" }}>{err}</p>
          </div>
        )}
        {!loading && lfReady && filterCount === 0 && !err && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 999, pointerEvents: "none" }}>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.2)" }}>No pins in this filter</p>
            <p style={{ fontSize: 11, color: "rgba(200,170,90,0.3)", marginTop: 4 }}>Try another filter or work leads to light up the map</p>
          </div>
        )}
        <div style={{ position: "absolute", bottom: 10, left: 14, zIndex: 500, pointerEvents: "none", fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 11, color: "rgba(200,170,90,0.2)", letterSpacing: "0.18em", textTransform: "uppercase" }}>BGRE · Lead Depot</div>
      </div>

      {/* Legend + privacy footer */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "10px 14px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 8 }}>
        {Object.entries(TIER).map(([k, { fill: f, label: l }]) => {
          const n = k === "appt" ? totals.appt : k === "contact" ? totals.contact : totals.pool;
          return (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: k === "appt" ? 12 : k === "contact" ? 9 : 7, height: k === "appt" ? 12 : k === "contact" ? 9 : 7, borderRadius: "50%", background: f, opacity: 0.85 }} />
              <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.5)", letterSpacing: "0.04em" }}>{l}</span>
              <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }}>· {n}</span>
            </div>
          );
        })}
      </div>

      {!viewerIsAdmin && (
        <div style={{ padding: "8px 12px", background: "rgba(200,170,90,0.05)", border: "1px solid rgba(200,170,90,0.15)", borderRadius: 8, fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>
          <span style={{ color: "#c8aa5a", fontWeight: 600, letterSpacing: "0.06em" }}>PRIVACY</span> — pins sit on the real address. Owner name, phone, and street number are masked until you pull the lead and start dialing.
        </div>
      )}
    </div>
  );
}
