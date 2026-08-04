import { useEffect, useRef, useState } from "react";

interface MapLead {
  id: number; address: string; ownerName: string | null;
  status: string; leadType: string; city: string; state: string; zip: string;
  lat: number; lng: number;
}

const NE_FL = { lat: 30.18, lng: -81.65, zoom: 9 };

const STATUS: Record<string, { fill: string; label: string }> = {
  unassigned:               { fill: "#c8aa5a", label: "Unassigned" },
  assigned:                 { fill: "#4f98a3", label: "Assigned" },
  no_answer:                { fill: "#797876", label: "No Answer" },
  callback_requested:       { fill: "#e8af34", label: "Callback" },
  contacted_appointment:    { fill: "#6daa45", label: "Appt Set" },
  contacted_not_interested: { fill: "#dd6974", label: "Not Interested" },
  wrong_number:             { fill: "#555250", label: "Wrong #" },
  retired:                  { fill: "#393836", label: "Retired" },
};
const color = (s: string) => STATUS[s]?.fill ?? "#c8aa5a";
const label = (s: string) => STATUS[s]?.label ?? s;

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

function pin(c: string, L: any) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 22 30"><circle cx="11" cy="11" r="10" fill="${c}" stroke="rgba(0,0,0,0.5)" stroke-width="1.5"/><path d="M11 21L11 30" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/><circle cx="11" cy="11" r="3.5" fill="rgba(0,0,0,0.4)"/></svg>`;
  return L.divIcon({ html: svg, className: "", iconSize: [22, 30], iconAnchor: [11, 30], popupAnchor: [0, -32] });
}

// v14.30 — cluster bubble icon (gold gradient, count in center). Scales with size.
function clusterIcon(count: number, L: any) {
  const size = count < 10 ? 30 : count < 50 ? 36 : count < 200 ? 44 : 52;
  const font = count < 10 ? 12 : count < 50 ? 13 : count < 200 ? 14 : 15;
  const label = count < 1000 ? String(count) : Math.floor(count / 1000) + "k";
  const svg = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle at 35% 30%, rgba(200,170,90,0.95), rgba(200,170,90,0.55) 60%, rgba(200,170,90,0.2) 100%);border:1.5px solid rgba(200,170,90,0.9);box-shadow:0 0 0 4px rgba(200,170,90,0.12),0 4px 10px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-family:'Switzer','Inter',sans-serif;font-size:${font}px;font-weight:600;color:#0a0a0a;letter-spacing:0.02em">${label}</div>`;
  return L.divIcon({ html: svg, className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

// v14.30 — grid-based clustering. Bucket pins into an N-pixel grid at current zoom.
// Returns an array of either { type: 'pin', lead } or { type: 'cluster', lat, lng, count, items }.
function clusterLeads(leads: MapLead[], map: any, cellPx: number = 60): Array<any> {
  if (!map || !leads.length) return leads.map(l => ({ type: "pin", lead: l }));
  const zoom = map.getZoom();
  // Above zoom 15 stop clustering — show every pin.
  if (zoom >= 15) return leads.map(l => ({ type: "pin", lead: l }));
  const buckets = new Map<string, MapLead[]>();
  for (const l of leads) {
    if (typeof l.lat !== "number" || typeof l.lng !== "number") continue;
    const pt = map.latLngToContainerPoint([l.lat, l.lng]);
    const key = `${Math.floor(pt.x / cellPx)}:${Math.floor(pt.y / cellPx)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(l); else buckets.set(key, [l]);
  }
  const out: any[] = [];
  for (const arr of buckets.values()) {
    if (arr.length === 1) { out.push({ type: "pin", lead: arr[0] }); continue; }
    let sLat = 0, sLng = 0;
    for (const l of arr) { sLat += l.lat; sLng += l.lng; }
    out.push({ type: "cluster", lat: sLat / arr.length, lng: sLng / arr.length, count: arr.length, items: arr });
  }
  return out;
}

export default function MapView() {
  const mapDiv  = useRef<HTMLDivElement>(null);
  const mapRef  = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const hasFitRef = useRef(false);
  const [leads, setLeads]   = useState<MapLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [lfReady, setLfReady] = useState(false);
  const [filter, setFilter]  = useState("all");
  const [err, setErr]        = useState("");
  const [totalCount, setTotalCount] = useState(0);
  const [pending, setPending] = useState(0);
  const [bgRunning, setBgRunning] = useState(false);

  // Load Leaflet JS
  useEffect(() => {
    loadLF().then(() => setLfReady(true)).catch(() => setErr("Failed to load map library."));
  }, []);

  // v14.30 — fetch pre-geocoded leads from server. No more 500 cap.
  // Re-poll every 20s while background geocode is running so pins fill in live.
  useEffect(() => {
    let cancelled = false;
    let pollTimer: any = null;
    const load = () => fetch("/api/leads/map")
      .then(r => r.json())
      .then((d: any) => {
        if (cancelled) return;
        if (Array.isArray(d)) {
          setLeads(d); // backward-compat if older server
        } else {
          setLeads(d.leads || []);
          setTotalCount(d.totalCount || 0);
          setPending(d.pending || 0);
          setBgRunning(!!d.bgRunning);
          // If server still has uncached leads, poll again in 20s.
          if (d.bgRunning || (d.pending || 0) > 0) {
            pollTimer = setTimeout(load, 20000);
          }
        }
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setErr("Failed to load leads."); setLoading(false); } });
    load();
    return () => { cancelled = true; if (pollTimer) clearTimeout(pollTimer); };
  }, []);

  // Init map
  useEffect(() => {
    if (!lfReady || !mapDiv.current || mapRef.current) return;
    const L = (window as any).L;
    const map = L.map(mapDiv.current, { center: [NE_FL.lat, NE_FL.lng], zoom: NE_FL.zoom });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd", maxZoom: 19,
    }).addTo(map);
    const attr = map.getContainer().querySelector(".leaflet-control-attribution") as HTMLElement;
    if (attr) { attr.style.background = "rgba(8,8,8,0.7)"; attr.style.color = "#444"; attr.style.fontSize = "9px"; }
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
  }, [lfReady]);

  // v14.30 — render pins/clusters whenever leads, filter, or zoom changes.
  // Grid-based clustering keeps 4K+ pins performant. At zoom 15+ every pin renders.
  const renderPins = () => {
    if (!mapRef.current || !layerRef.current) return;
    const L = (window as any).L; if (!L) return;
    const map = mapRef.current;
    layerRef.current.clearLayers();
    const list = filter === "all" ? leads : leads.filter(l => l.status === filter);
    const clustered = clusterLeads(list, map, 60);
    for (const c of clustered) {
      if (c.type === "pin") {
        const l: MapLead = c.lead;
        const popup = `<div style="background:#0f0f0f;border:1px solid rgba(200,170,90,0.2);border-radius:6px;padding:10px 14px;min-width:190px;font-family:'Switzer','Inter',sans-serif;font-size:11px;line-height:1.6;color:#e8e4dc">
          ${l.ownerName ? `<b style="color:#c8aa5a;font-size:12px">${l.ownerName}</b><br/>` : ""}
          <span style="color:#797876">${l.address}${l.city ? ", " + l.city : ""}</span><br/>
          <span style="display:inline-block;margin-top:5px;padding:2px 8px;border-radius:3px;background:rgba(200,170,90,0.1);color:#c8aa5a;font-size:10px;letter-spacing:.08em;text-transform:uppercase">${label(l.status)}</span>
          <span style="color:#555;font-size:10px;margin-left:6px">${l.leadType}</span>
        </div>`;
        L.marker([l.lat, l.lng], { icon: pin(color(l.status), L) })
          .bindPopup(popup, { className: "bgre-popup", maxWidth: 270, offset: [0, -6] })
          .addTo(layerRef.current);
      } else {
        // Cluster — tap-to-zoom into the cluster's bounds.
        const items: MapLead[] = c.items;
        const marker = L.marker([c.lat, c.lng], { icon: clusterIcon(c.count, L) });
        marker.on("click", () => {
          try {
            const bounds = L.latLngBounds(items.map(i => [i.lat, i.lng]));
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
          } catch (_) { map.setView([c.lat, c.lng], Math.min(map.getZoom() + 2, 16)); }
        });
        marker.addTo(layerRef.current);
      }
    }
    // Auto-zoom to pin cluster on initial load only
    if (!hasFitRef.current && list.length > 0) {
      hasFitRef.current = true;
      try {
        const bounds = L.latLngBounds(list.map((l: MapLead) => [l.lat, l.lng]));
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
      } catch (_) { /* ignore if bounds fail */ }
    }
  };

  useEffect(() => { renderPins(); }, [leads, filter, lfReady]);

  // Re-cluster on zoom / pan-end so cluster granularity tracks the viewport.
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const handler = () => renderPins();
    map.on("zoomend", handler);
    map.on("moveend", handler);
    return () => { map.off("zoomend", handler); map.off("moveend", handler); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lfReady, leads, filter]);

  const counts = leads.reduce<Record<string, number>>((a, l) => { a[l.status] = (a[l.status] ?? 0) + 1; return a; }, {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 22, fontWeight: 300, color: "#fff", lineHeight: 1, letterSpacing: "0.04em" }}>Territory Map</h2>
          <p style={{ fontSize: 11, color: "rgba(200,170,90,0.55)", marginTop: 4, letterSpacing: "0.08em" }}>Northeast Florida · BGRE Lead Coverage</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ padding: "5px 12px", background: "rgba(200,170,90,0.08)", border: "1px solid rgba(200,170,90,0.2)", borderRadius: 20, fontSize: 11, color: "#c8aa5a" }}>{leads.length} mapped</div>
          {loading && <div style={{ padding: "5px 12px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, fontSize: 11, color: "#797876" }}>Loading…</div>}
        </div>
      </div>

      {/* Status filter chips */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {[{ v: "all", l: "All", c: "#c8aa5a", n: leads.length },
          ...Object.entries(STATUS).map(([v, { label: l, fill: c }]) => ({ v, l, c, n: counts[v] ?? 0 }))
        ].filter(o => o.v === "all" || o.n > 0).map(o => {
          const active = filter === o.v;
          return (
            <button key={o.v} onClick={() => setFilter(o.v)} style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "4px 10px",
              background: active ? `${o.c}20` : "rgba(255,255,255,0.03)",
              border: `1px solid ${active ? o.c + "55" : "rgba(255,255,255,0.07)"}`,
              borderRadius: 16, cursor: "pointer", fontSize: 10,
              color: active ? o.c : "rgba(255,255,255,0.4)",
              letterSpacing: "0.05em", transition: "all 0.15s",
            }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: o.c, flexShrink: 0 }} />
              {o.l} <span style={{ opacity: 0.65 }}>{o.n}</span>
            </button>
          );
        })}
      </div>

      {/* v14.30 — pending-geocode chip: only shown while background geocoder is still filling in coords. */}
      {!loading && pending > 0 && (
        <div style={{
          padding: "6px 12px",
          background: "rgba(200,170,90,0.06)",
          border: "1px solid rgba(200,170,90,0.18)",
          borderRadius: 20,
          fontSize: 10,
          color: "rgba(200,170,90,0.7)",
          letterSpacing: "0.08em",
          display: "inline-flex",
          alignSelf: "flex-start",
          alignItems: "center",
          gap: 8,
          textTransform: "uppercase",
        }}>
          <span style={{ opacity: 0.9 }}>{bgRunning ? "◷ geocoding" : "○"}</span>
          <span>{leads.length} of {totalCount} mapped · {pending} pending</span>
        </div>
      )}

      {/* Map container */}
      <div style={{ height: "calc(100vh - 320px)", minHeight: 440, position: "relative", borderRadius: 10, overflow: "hidden", border: "1px solid rgba(200,170,90,0.15)" }}>
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
        {!loading && lfReady && leads.length === 0 && !err && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 999, pointerEvents: "none" }}>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.2)" }}>No leads yet</p>
            <p style={{ fontSize: 11, color: "rgba(200,170,90,0.3)", marginTop: 4 }}>Upload leads to see them pinned on the map</p>
          </div>
        )}
        <div style={{ position: "absolute", bottom: 10, left: 14, zIndex: 500, pointerEvents: "none", fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 11, color: "rgba(200,170,90,0.2)", letterSpacing: "0.18em", textTransform: "uppercase" }}>BGRE · Lead Depot</div>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "10px 14px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 8 }}>
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", letterSpacing: "0.14em", textTransform: "uppercase", alignSelf: "center", marginRight: 4 }}>Legend</span>
        {Object.entries(STATUS).map(([s, { fill: f, label: l }]) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: f }} />
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }}>{l}</span>
          </div>
        ))}
      </div>

      <style>{`.bgre-popup .leaflet-popup-content-wrapper{background:transparent!important;box-shadow:0 8px 32px rgba(0,0,0,0.8)!important;border-radius:6px!important;padding:0!important}.bgre-popup .leaflet-popup-content{margin:0!important}.bgre-popup .leaflet-popup-tip-container{display:none}.leaflet-control-zoom a{background:#111!important;color:#c8aa5a!important;border-color:rgba(200,170,90,0.2)!important}.leaflet-control-zoom a:hover{background:#1a1a1a!important}`}</style>
    </div>
  );
}
