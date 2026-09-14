// v20.58.6 — Request Buyer / Seller Package. Agents book a consult and ask
// ops (Alex + Nate) for a Digital / Print / Both package. Property research
// is delivered inside the package. Reuses FUB contact search (same endpoint
// as Past Client Appt) and awards Appt Set points (+ network referral when
// the client is new to the database).
import { useEffect, useState } from "react";
import { X, Package, Loader2, Calendar, MapPin, UserPlus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const GOLD = "#c8aa5a";
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 10, letterSpacing: "0.18em",
  textTransform: "uppercase", color: "rgba(200,170,90,0.55)", marginBottom: 6, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(200,170,90,0.2)",
  padding: "11px 14px", borderRadius: 8,
  fontFamily: "'Switzer','Inter',sans-serif", fontSize: 14,
  color: "#fff", outline: "none", boxSizing: "border-box",
};

type FubContact = { id: number; name: string; phone: string; email: string; address?: string };
type PackageFormat = "digital" | "print" | "both";
type PropertyMode = "specific" | "generic";
type ClientMode = "fub" | "new";

function defaultApptLocal(): string {
  const d = new Date();
  d.setHours(16, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ChoiceChip({
  label, active, onClick, flex,
}: { label: string; active: boolean; onClick: () => void; flex?: number }) {
  return (
    <button type="button" onClick={onClick} style={{
      flex: flex ?? 1, padding: "10px 8px", borderRadius: 8, cursor: "pointer",
      fontSize: 12, fontWeight: 600, letterSpacing: "0.02em", textAlign: "center",
      background: active ? "rgba(200,170,90,0.18)" : "rgba(255,255,255,0.03)",
      border: `1px solid ${active ? "rgba(200,170,90,0.5)" : "rgba(255,255,255,0.10)"}`,
      color: active ? GOLD : "rgba(255,255,255,0.7)",
    }}>{label}</button>
  );
}

export function PackageRequestSheet({
  side,
  agentId,
  agentName,
  onClose,
}: {
  side: "buyer" | "seller";
  agentId?: number;
  agentName?: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const title = side === "buyer" ? "Request Buyer Package" : "Request Seller Package";
  const intentLabel = side === "buyer" ? "Buyer Consult" : "Listing Consult";

  const [clientMode, setClientMode] = useState<ClientMode>("fub");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FubContact[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<FubContact | null>(null);

  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");

  const [propertyMode, setPropertyMode] = useState<PropertyMode | null>(null);
  const [propertyAddress, setPropertyAddress] = useState("");
  const [format, setFormat] = useState<PackageFormat | null>(null);
  const [apptDatetime, setApptDatetime] = useState(defaultApptLocal);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);

  useEffect(() => {
    if (clientMode !== "fub" || selected) return;
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/fub/search-contacts?q=${encodeURIComponent(q)}`, { credentials: "include" });
        if (cancelled) return;
        const data = await r.json();
        setResults(data.contacts || []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, selected, clientMode]);

  const pickContact = (c: FubContact) => {
    setSelected(c);
    setQuery(c.name);
    setResults([]);
    if (c.address && !propertyAddress) setPropertyAddress(c.address);
  };

  const clearContact = () => {
    setSelected(null);
    setQuery("");
    setResults([]);
  };

  const clientReady = clientMode === "fub"
    ? Boolean(selected)
    : Boolean(newName.trim() && newPhone.trim());

  const canSubmit = clientReady
    && propertyMode != null
    && (propertyMode === "generic" || Boolean(propertyAddress.trim()))
    && format != null
    && Boolean(apptDatetime)
    && !submitting
    && Boolean(agentId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !agentId || !propertyMode || !format) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        agentId,
        side,
        clientMode,
        propertyMode,
        propertyAddress: propertyMode === "specific" ? propertyAddress.trim() : "",
        format,
        apptDatetime: new Date(apptDatetime).toISOString(),
        notes: notes.trim(),
      };
      if (clientMode === "fub" && selected) {
        body.fubPersonId = selected.id;
        body.clientName = selected.name;
        body.clientPhone = selected.phone;
        body.clientEmail = selected.email;
      } else {
        body.clientName = newName.trim();
        body.clientPhone = newPhone.trim();
        body.clientEmail = newEmail.trim();
      }

      const r = await fetch("/api/package-request", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Agent-Id": String(agentId) },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast({
          title: "Could not submit package request",
          description: data.error || `HTTP ${r.status}`,
          variant: "destructive",
        });
        return;
      }
      const pts = data.pointsAwarded ?? 0;
      const leadPts = data.leadPointsAwarded ?? 0;
      const ptsNote = pts || leadPts
        ? `+${pts + leadPts} pts`
        : "Submitted";
      toast({
        title: "Package request sent",
        description: `${ptsNote} — Alex & Nate notified. ${intentLabel} booked.`,
      });
      qc.invalidateQueries({ queryKey: ["/api/agent/leaderboard"] });
      onClose();
    } catch {
      toast({ title: "Could not submit package request", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "radial-gradient(circle at 50% 20%, rgba(30,25,10,0.98) 0%, rgba(0,0,0,0.96) 55%, #000 100%)",
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 18px", borderBottom: "1px solid rgba(200,170,90,0.18)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 34, height: 34, borderRadius: "50%",
            background: "rgba(200,170,90,0.15)", border: "1px solid rgba(200,170,90,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Package size={15} style={{ color: GOLD }} />
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", color: GOLD, fontWeight: 700 }}>
              {title}
            </p>
            <p style={{ margin: "2px 0 0", fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
              {agentName || "Agent"} · property research included in package
            </p>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" style={{
          width: 36, height: 36, borderRadius: 18,
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
          color: "rgba(255,255,255,0.75)", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
        }}><X size={16} /></button>
      </div>

      <form onSubmit={submit} style={{
        flex: 1, overflowY: "auto", padding: "18px 18px 28px",
        display: "flex", flexDirection: "column", gap: 14, maxWidth: 520, width: "100%",
        margin: "0 auto", boxSizing: "border-box",
      }}>
        <p style={{ margin: 0, fontSize: 13, color: "rgba(255,255,255,0.55)", lineHeight: 1.55 }}>
          Book the {side === "buyer" ? "buyer" : "listing"} consult and request the package Ops will prepare.
          Research for a specific property (when selected) is included in the delivered package.
        </p>

        {/* Client in FUB? */}
        <div>
          <label style={labelStyle}>Client in Follow Up Boss? *</label>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <ChoiceChip label="Yes — find in FUB" active={clientMode === "fub"} onClick={() => { setClientMode("fub"); }} />
            <ChoiceChip label="No — new client" active={clientMode === "new"} onClick={() => { setClientMode("new"); clearContact(); }} />
          </div>

          {clientMode === "fub" ? (
            selected ? (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "11px 14px", borderRadius: 8,
                background: "rgba(200,170,90,0.12)", border: "1px solid rgba(200,170,90,0.35)",
              }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 14, color: "#fff", fontWeight: 600 }}>{selected.name}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                    {selected.phone || "No phone"}{selected.email ? ` · ${selected.email}` : ""}
                  </p>
                </div>
                <button type="button" onClick={clearContact} style={{
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: 6, padding: "5px 8px", cursor: "pointer", color: "rgba(255,255,255,0.7)", fontSize: 11,
                }}>Change</button>
              </div>
            ) : (
              <>
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Start typing a FUB contact name…"
                  style={inputStyle}
                  autoComplete="off"
                />
                {searching && (
                  <p style={{ fontSize: 10, color: "rgba(200,170,90,0.55)", marginTop: 6, letterSpacing: "0.08em" }}>
                    Searching Follow Up Boss…
                  </p>
                )}
                {results.length > 0 && (
                  <div style={{
                    marginTop: 6, borderRadius: 8, overflow: "hidden",
                    border: "1px solid rgba(200,170,90,0.25)",
                  }}>
                    {results.map(c => (
                      <button key={c.id} type="button" onClick={() => pickContact(c)} style={{
                        display: "block", width: "100%", textAlign: "left",
                        padding: "10px 12px", background: "rgba(255,255,255,0.03)",
                        border: "none", borderBottom: "1px solid rgba(255,255,255,0.06)", cursor: "pointer",
                      }}>
                        <p style={{ margin: 0, fontSize: 13, color: "#fff", fontWeight: 600 }}>{c.name}</p>
                        <p style={{ margin: "2px 0 0", fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                          {c.phone || "No phone"}{c.email ? ` · ${c.email}` : ""}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
                {!searching && query.trim().length >= 2 && results.length === 0 && (
                  <p style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 6 }}>
                    No matching FUB contacts. Switch to “No — new client” to add them.
                  </p>
                )}
              </>
            )
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <label style={labelStyle}>Client Name *</label>
                <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Full name" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Phone *</label>
                <input value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="(904) 555-0100" style={inputStyle} inputMode="tel" />
              </div>
              <div>
                <label style={labelStyle}>Email</label>
                <input value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="optional@" style={inputStyle} inputMode="email" />
              </div>
              <p style={{ margin: 0, fontSize: 11, color: "rgba(200,170,90,0.65)", display: "flex", alignItems: "center", gap: 6 }}>
                <UserPlus size={12} /> Adds them as a network lead (+20 pts) and books the consult.
              </p>
            </div>
          )}
        </div>

        {/* Specific vs generic */}
        <div>
          <label style={labelStyle}>Package Scope *</label>
          <div style={{ display: "flex", gap: 6, marginBottom: propertyMode === "specific" ? 10 : 0 }}>
            <ChoiceChip
              label="Specific Property"
              active={propertyMode === "specific"}
              onClick={() => setPropertyMode("specific")}
            />
            <ChoiceChip
              label={side === "buyer" ? "Generic Buyer Package" : "Generic Seller Package"}
              active={propertyMode === "generic"}
              onClick={() => setPropertyMode("generic")}
            />
          </div>
          {propertyMode === "specific" && (
            <div>
              <label style={labelStyle}>Property Address *</label>
              <div style={{ position: "relative" }}>
                <MapPin size={13} style={{ position: "absolute", left: 12, top: 14, color: GOLD }} />
                <input
                  value={propertyAddress}
                  onChange={e => setPropertyAddress(e.target.value)}
                  placeholder="123 Oak St, Fernandina Beach, FL"
                  style={{ ...inputStyle, paddingLeft: 32 }}
                />
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                Ops will include property research in the package.
              </p>
            </div>
          )}
        </div>

        {/* Format */}
        <div>
          <label style={labelStyle}>Format *</label>
          <div style={{ display: "flex", gap: 6 }}>
            {([
              ["digital", "Digital"],
              ["print", "Print"],
              ["both", "Both"],
            ] as const).map(([key, label]) => (
              <ChoiceChip key={key} label={label} active={format === key} onClick={() => setFormat(key)} />
            ))}
          </div>
        </div>

        {/* Appt */}
        <div>
          <label style={labelStyle}>Consult Date &amp; Time *</label>
          <div style={{ position: "relative" }}>
            <Calendar size={13} style={{ position: "absolute", left: 12, top: 14, color: GOLD, pointerEvents: "none" }} />
            <input
              type="datetime-local"
              value={apptDatetime}
              onChange={e => setApptDatetime(e.target.value)}
              style={{ ...inputStyle, paddingLeft: 32, colorScheme: "dark" }}
            />
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
            Logged as an Appt Set and pushed to Follow Up Boss for Denise, Alex, and Nate.
          </p>
        </div>

        <div>
          <label style={labelStyle}>Notes for Ops</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional context for the package or consult"
            rows={2}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, minHeight: 64 }}
          />
        </div>

        <button type="submit" disabled={!canSubmit} style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          padding: "14px 20px", marginTop: 4,
          background: !canSubmit ? "rgba(200,170,90,0.3)" : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
          border: "none", borderRadius: 8, cursor: !canSubmit ? "not-allowed" : "pointer",
          fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
          color: "#080808",
        }}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
          {submitting ? "Submitting…" : "Submit Package Request"}
        </button>
      </form>
    </div>
  );
}
