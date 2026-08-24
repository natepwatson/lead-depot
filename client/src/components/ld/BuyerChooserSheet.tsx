// v20.32.13 — "Buyers" bottom-nav button now opens this chooser overlay
// first: dark radial-gradient backdrop with gold-gradient bubbles ("Write an
// Offer", "Inspections+", "Instant Quote Repair"), matching the Lead Gen
// chooser's visual language (gold liquid-glass bubbles on a dark scrim).
// v20.32.12 — added the third "Instant Repair Quote" bubble (standalone
// repair consult, not tied to a listing) per Alex's ask. Renamed from
// "Instant Quote Repair" to "Instant Repair Quote" to match the seller side.
import { useEffect } from "react";
import { FileSignature, ClipboardCheck, Wrench, X } from "lucide-react";

const GOLD_GRADIENT = "radial-gradient(circle at 50% 22%, rgba(255,240,180,0.65) 0%, rgba(253,224,71,0.42) 30%, rgba(200,170,90,0.32) 62%, rgba(138,111,42,0.42) 100%)";
const GOLD_BORDER = "1px solid rgba(255,220,140,0.75)";

function Bubble({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10,
      width: 132, height: 132, borderRadius: "50%",
      background: GOLD_GRADIENT, border: GOLD_BORDER,
      backdropFilter: "blur(20px) saturate(180%) brightness(1.06)",
      WebkitBackdropFilter: "blur(20px) saturate(180%) brightness(1.06)",
      boxShadow: [
        "0 12px 36px rgba(200,170,90,0.45)",
        "0 4px 14px rgba(0,0,0,0.42)",
        "0 0.5px 0 rgba(255,255,255,0.35) inset",
        "0 2px 0 rgba(255,240,190,0.55) inset",
        "0 -8px 18px rgba(80,50,10,0.30) inset",
      ].join(", "),
      cursor: "pointer", flexShrink: 0,
    }}>
      <span style={{ color: "#0a0700" }}>{icon}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: "#0a0700", textAlign: "center", padding: "0 8px" }}>{label}</span>
    </button>
  );
}

export function BuyerChooserSheet({
  onWriteOffer, onInspectionsPlus, onInstantQuoteRepair, onClose,
}: {
  onWriteOffer: () => void;
  onInspectionsPlus: () => void;
  onInstantQuoteRepair: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    document.body.classList.add("ld-modal-open");
    return () => document.body.classList.remove("ld-modal-open");
  }, []);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 190,
        background: "radial-gradient(circle at 50% 70%, rgba(30,25,10,0.94) 0%, rgba(0,0,0,0.9) 55%, rgba(0,0,0,0.94) 100%)",
        backdropFilter: "blur(6px)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 28,
      }}
    >
      <button type="button" onClick={onClose} aria-label="Close" style={{
        position: "absolute", top: 16, right: 16, width: 38, height: 38, borderRadius: 19,
        background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
        color: "rgba(255,255,255,0.75)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
      }}><X size={18} /></button>

      <p style={{
        margin: 0, fontFamily: "'Cormorant Garamond','Georgia',serif", fontSize: 22, fontWeight: 400,
        color: "#fff", textAlign: "center",
      }}>What are we doing for this buyer?</p>

      <div onClick={e => e.stopPropagation()} style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", justifyContent: "center", maxWidth: 340 }}>
        <Bubble icon={<ClipboardCheck size={26} />} label="Inspections+" onClick={onInspectionsPlus} />
        <Bubble icon={<Wrench size={26} />} label="Instant Repair Quote" onClick={onInstantQuoteRepair} />
        <Bubble icon={<FileSignature size={26} />} label="Write an Offer" onClick={onWriteOffer} />
      </div>
    </div>
  );
}
