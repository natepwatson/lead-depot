// v20.32.14 — Shared "which property is this about?" picker. A FUB client
// can own multiple properties (e.g. an out-of-state primary residence plus
// a local vacant lot). Selecting the contact in "Find in FUB" used to
// silently autofill whichever address FUB happened to list first/primary —
// for a client like Ross Wood that meant a Colorado home address landed in
// a Jacksonville land-clearing consult meant for his vacant "0 Charles Ave"
// lot. This component surfaces every on-file address so the agent picks the
// right one, with an explicit manual-entry escape hatch as the final
// fallback when the property isn't in FUB at all (e.g. a brand-new vacant
// parcel that hasn't been added to the client's FUB record yet).
import { MapPin, Pencil } from "lucide-react";

const GOLD = "#c8aa5a";

export type FubAddress = { street: string; city: string | null; state: string | null; zip: string | null; label: string | null };

export function formatFubAddress(a: FubAddress): string {
  return [a.street, [a.city, a.state].filter(Boolean).join(", "), a.zip].filter(Boolean).join(", ");
}

export function FubAddressChooser({
  clientName,
  addresses,
  onPick,
  onManual,
}: {
  clientName: string;
  addresses: FubAddress[];
  onPick: (addressStr: string) => void;
  onManual: () => void;
}) {
  return (
    <div style={{
      marginBottom: 14, padding: 12, borderRadius: 8,
      background: "rgba(200,170,90,0.06)", border: "1px solid rgba(200,170,90,0.3)",
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", marginBottom: 2 }}>
        {clientName} has {addresses.length} properties on file — which one is this about?
      </div>
      <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)", margin: "0 0 8px" }}>
        Pick the property this consult concerns, or enter a different one manually below.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {addresses.map((a, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onPick(formatFubAddress(a))}
            style={{
              display: "flex", alignItems: "center", gap: 8, textAlign: "left", padding: "8px 10px",
              borderRadius: 6, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)",
              color: "#fff", fontSize: 12, cursor: "pointer",
            }}
          >
            <MapPin size={13} style={{ color: GOLD, flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{formatFubAddress(a)}</span>
            {a.label && (
              <span style={{
                fontSize: 9.5, fontWeight: 700, padding: "2px 6px", borderRadius: 999,
                background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.55)", flexShrink: 0,
              }}>{a.label}</span>
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={onManual}
          style={{
            display: "flex", alignItems: "center", gap: 8, textAlign: "left", padding: "8px 10px",
            borderRadius: 6, background: "transparent", border: "1px dashed rgba(255,255,255,0.2)",
            color: "rgba(255,255,255,0.6)", fontSize: 12, cursor: "pointer",
          }}
        >
          <Pencil size={13} style={{ flexShrink: 0 }} />
          <span>None of these — I'll enter the property address myself</span>
        </button>
      </div>
    </div>
  );
}
