// v19.1 — Team Map (public, all agents can see).
// Zero-PII surface: only jittered coords + tier bucket. No popups, no names,
// no addresses, no phones. This is a recruiting / bragging tool.
//
// Data comes from /api/team-map/pins which server-side aggregates to ~180m
// cells so no pin can be reversed to an individual property.
import { useEffect, useRef, useState } from "react";

interface Pin { lat: number; lng: number; tier: "appt" | "contact" | "pool"; count: number; }
interface Totals { total: number; appt: number; contact: number; pool: number; }

const NE_FL = { lat: 30.18, lng: -81.65, zoom: 9 };

const TIER: Record<string, { fill: string; label: string; short: string }> = {
  appt:    { fill: "#6daa45", label: "Appointments Set", short: "Appts" },
  contact: { fill: "#c8aa5a", label: "Active Working",   short: "Working" },
  pool:    { fill: "#4f98a3", label: "Territory Coverage", short: "Coverage" },
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

// Anonymous pin — solid circle, no icon, no tooltip.
function makePin(fill: string, size: number, L: any) {
  const svg = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${fill};box-shadow:0 0 0 2px rgba(0,0,0,0.35),0 2px 6px rgba(0,0,0,0.5);opacity:0.85"></div>`;
  return L.divIcon({ html: svg, className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

export default function TeamMap() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const hasFitRef = useRef(false);
  const [pins, setPins] = useState<Pin[]>([]);
  const [totals, setTotals] = useState<Totals>({ total: 0, appt: 0, contact: 0, pool: 0 });
  const [loading, setLoading] = useState(true);
  const [lfReady, setLfReady] = useState(false);
  const [err, setErr] = useState("");

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
      // Cap max zoom so no one can zoom in tight enough to reverse-engineer an address.
      maxZoom: 13, minZoom: 8,
      scrollWheelZoom: true, doubleClickZoom: true,
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd", maxZoom: 13,
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
    for (const p of pins) {
      // Bigger dot for higher-value tier so appointments pop off the map.
      const size = p.tier === "appt" ? 12 : p.tier === "contact" ? 9 : 7;
      L.marker([p.lat, p.lng], { icon: makePin(TIER[p.tier].fill, size, L), interactive: false })
        .addTo(layerRef.current);
    }
    if (!hasFitRef.current && pins.length > 0) {
      hasFitRef.current = true;
      try {
        const bounds = L.latLngBounds(pins.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 });
      } catch (_) { /* ignore */ }
    }
  }, [pins, lfReady]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 22, fontWeight: 300, color: "#fff", lineHeight: 1, letterSpacing: "0.04em" }}>Team Map</h2>
          <p style={{ fontSize: 11, color: "rgba(200,170,90,0.55)", marginTop: 4, letterSpacing: "0.08em" }}>Where BGRE is on the ground · Northeast Florida</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ padding: "5px 12px", background: "rgba(109,170,69,0.1)", border: "1px solid rgba(109,170,69,0.25)", borderRadius: 20, fontSize: 11, color: "#6daa45", letterSpacing: "0.04em" }}>{totals.appt} appts set</div>
          <div style={{ padding: "5px 12px", background: "rgba(200,170,90,0.08)", border: "1px solid rgba(200,170,90,0.2)", borderRadius: 20, fontSize: 11, color: "#c8aa5a" }}>{totals.total} pins</div>
          {loading && <div style={{ padding: "5px 12px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, fontSize: 11, color: "#797876" }}>Loading…</div>}
        </div>
      </div>

      {/* Privacy notice — visible so nobody thinks this leaks lead info */}
      <div style={{ padding: "8px 12px", background: "rgba(200,170,90,0.05)", border: "1px solid rgba(200,170,90,0.15)", borderRadius: 8, fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>
        <span style={{ color: "#c8aa5a", fontWeight: 600, letterSpacing: "0.06em" }}>PRIVACY</span> — pins are anonymized and offset ~350m. No owner names, addresses, or phone numbers are ever shown here. This map is a recruiting surface.
      </div>

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
        {!loading && lfReady && pins.length === 0 && !err && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 999, pointerEvents: "none" }}>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.2)" }}>No pins yet</p>
            <p style={{ fontSize: 11, color: "rgba(200,170,90,0.3)", marginTop: 4 }}>Work leads to light up the map</p>
          </div>
        )}
        <div style={{ position: "absolute", bottom: 10, left: 14, zIndex: 500, pointerEvents: "none", fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 11, color: "rgba(200,170,90,0.2)", letterSpacing: "0.18em", textTransform: "uppercase" }}>BGRE · Lead Depot</div>
      </div>

      {/* Legend */}
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
    </div>
  );
}
