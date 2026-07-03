/**
 * JoinPage — Agent Recruiting Intake Form
 * join.watsonbrothersgroup.com → /join
 * Luxury dark gold, mobile-first, all 14 fields + honeypot
 */
import { useState } from "react";

const API_BASE = ""; // same origin

const TERRITORIES = [
  "North Jax & Nassau",
  "Jacksonville West",
  "Jacksonville East",
  "Intracoastal/Beaches",
  "Ponte Vedra/Nocatee/St. Aug",
  "St. Johns County",
  "Clay County",
  "Not sure yet",
];

const inp: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(200,170,90,0.25)",
  padding: "13px 14px",
  borderRadius: 8,
  fontFamily: "'Switzer','Inter',sans-serif",
  fontSize: 15,
  color: "#fff",
  outline: "none",
  boxSizing: "border-box",
  WebkitAppearance: "none",
};

const lbl: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "rgba(200,170,90,0.65)",
  marginBottom: 6,
  fontWeight: 600,
};

const fieldWrap: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

export default function JoinPage() {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    licenseStatus: "active",
    licenseNumber: "",
    licenseState: "FL",
    yearsExperience: "",
    currentBrokerage: "",
    reasonForLeaving: "",
    gciRange: "",
    transactionsLast12mo: "",
    territory: "",
    referralSource: "",
    referredByName: "",
    applicantNotes: "",
    website: "", // honeypot — hidden from real users
  });

  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const formatPhone = (val: string) => {
    const digits = val.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError("Please enter your full name."); return;
    }
    if (!form.email.trim() && !form.phone.trim()) {
      setError("Please provide at least an email or phone number."); return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/agent-leads/public`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          transactionsLast12mo: form.transactionsLast12mo ? Number(form.transactionsLast12mo) : undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        setError(d.error || "Something went wrong. Please try again."); return;
      }
      setDone(true);
    } catch {
      setError("Network error — please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      minHeight: "100dvh",
      background: "linear-gradient(160deg, #080808 0%, #0d0b07 100%)",
      fontFamily: "'Switzer','Inter',sans-serif",
      color: "#fff",
    }}>
      {/* Ambient glow */}
      <div style={{
        position: "fixed", top: "20%", left: "50%", transform: "translateX(-50%)",
        width: 500, height: 500, borderRadius: "50%", pointerEvents: "none",
        background: "radial-gradient(circle, rgba(200,170,90,0.05) 0%, transparent 70%)",
      }} />

      {/* Header */}
      <header style={{
        padding: "20px 20px 0",
        display: "flex", flexDirection: "column", alignItems: "center",
        textAlign: "center",
      }}>
        {/* Logo */}
        <div style={{ marginBottom: 16 }}>
          <svg width="44" height="44" viewBox="0 0 36 36" fill="none" style={{ display: "block", margin: "0 auto 8px" }}>
            <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.6"/>
            <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
            <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.4"/>
          </svg>
          <p style={{ fontSize: 10, letterSpacing: "0.22em", color: "rgba(200,170,90,0.55)", margin: 0, textTransform: "uppercase" }}>
            Brothers Group · Momentum Realty
          </p>
        </div>

        <h1 style={{
          fontFamily: "'Cormorant Garamond','Georgia',serif",
          fontSize: "clamp(2rem, 8vw, 3rem)",
          fontWeight: 300, color: "#fff", margin: "0 0 10px", lineHeight: 1.1,
        }}>
          Your Split Just Got Better.
        </h1>
        <p style={{ fontSize: 15, color: "rgba(255,255,255,0.45)", maxWidth: 360, margin: "0 auto 24px", lineHeight: 1.6 }}>
          50/50 split. 7 open territories. Real lead flow. Join Watson Brothers Group at Momentum Realty.
        </p>

        {/* Trust strip */}
        <div style={{
          display: "flex", flexWrap: "wrap", justifyContent: "center",
          gap: 10, marginBottom: 32, maxWidth: 500,
        }}>
          {[
            ["50 / 50", "Flat split, no cap games"],
            ["Momentum Realty", "Established brand & infrastructure"],
            ["Live Lead Flow", "Real leads handed to you"],
            ["Training & Shadow", "Hands-on from day one"],
          ].map(([title, sub]) => (
            <div key={title} style={{
              background: "rgba(200,170,90,0.06)",
              border: "1px solid rgba(200,170,90,0.18)",
              borderRadius: 10, padding: "10px 14px", textAlign: "center",
              minWidth: 130, flex: "1 1 130px",
            }}>
              <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "#c8aa5a", letterSpacing: "0.05em" }}>{title}</p>
              <p style={{ margin: "3px 0 0", fontSize: 10, color: "rgba(255,255,255,0.35)", lineHeight: 1.4 }}>{sub}</p>
            </div>
          ))}
        </div>
      </header>

      {/* Form */}
      <main style={{ padding: "0 16px 60px", maxWidth: 480, margin: "0 auto" }}>

        {done ? (
          /* ── Success state ── */
          <div style={{
            background: "rgba(15,13,8,0.96)",
            border: "1px solid rgba(200,170,90,0.2)",
            borderRadius: 18, padding: "40px 28px",
            textAlign: "center",
            boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
          }}>
            <div style={{
              width: 60, height: 60, borderRadius: "50%",
              background: "rgba(200,170,90,0.1)",
              border: "1px solid rgba(200,170,90,0.3)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 20px",
            }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="#c8aa5a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h2 style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: "1.8rem", fontWeight: 300, color: "#fff", margin: "0 0 10px",
            }}>
              Thanks, {form.firstName}.
            </h2>
            <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 14, lineHeight: 1.7, margin: 0 }}>
              Alex will reach out within one business day to start the conversation. We're looking forward to it.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} autoComplete="on">
            {/* Honeypot — hidden from real users */}
            <input
              type="text" name="website" value={form.website}
              onChange={set("website")} tabIndex={-1} aria-hidden="true"
              style={{ position: "absolute", left: -9999, width: 1, height: 1, opacity: 0 }}
            />

            {/* ── Section 1: You ── */}
            <div style={{ marginBottom: 28 }}>
              <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(200,170,90,0.5)", marginBottom: 16, fontWeight: 600 }}>
                About You
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ flex: 1, ...fieldWrap }}>
                    <label style={lbl}>First Name *</label>
                    <input style={inp} value={form.firstName} onChange={set("firstName")} placeholder="Alex" autoComplete="given-name" required />
                  </div>
                  <div style={{ flex: 1, ...fieldWrap }}>
                    <label style={lbl}>Last Name *</label>
                    <input style={inp} value={form.lastName} onChange={set("lastName")} placeholder="Watson" autoComplete="family-name" required />
                  </div>
                </div>
                <div style={fieldWrap}>
                  <label style={lbl}>Email</label>
                  <input style={inp} type="email" inputMode="email" value={form.email} onChange={set("email")} placeholder="you@email.com" autoComplete="email" />
                </div>
                <div style={fieldWrap}>
                  <label style={lbl}>Phone</label>
                  <input style={inp} type="tel" inputMode="tel" value={form.phone}
                    onChange={e => setForm(f => ({ ...f, phone: formatPhone(e.target.value) }))}
                    placeholder="(904) 555-0100" autoComplete="tel" />
                </div>
              </div>
            </div>

            {/* ── Section 2: License & Business ── */}
            <div style={{ marginBottom: 28 }}>
              <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(200,170,90,0.5)", marginBottom: 16, fontWeight: 600 }}>
                Your License & Business
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={fieldWrap}>
                  <label style={lbl}>License Status *</label>
                  <select style={{ ...inp, color: form.licenseStatus ? "#fff" : "rgba(255,255,255,0.4)" }} value={form.licenseStatus} onChange={set("licenseStatus")} required>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="pending">Pending / In Course</option>
                  </select>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ flex: 2, ...fieldWrap }}>
                    <label style={lbl}>License Number</label>
                    <input style={inp} value={form.licenseNumber} onChange={set("licenseNumber")} placeholder="SL3456789 (optional)" />
                  </div>
                  <div style={{ flex: 1, ...fieldWrap }}>
                    <label style={lbl}>State</label>
                    <select style={inp} value={form.licenseState} onChange={set("licenseState")}>
                      {["FL","GA","SC","NC","AL","TX","CA","NY"].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <div style={fieldWrap}>
                  <label style={lbl}>Years of Experience</label>
                  <select style={{ ...inp, color: form.yearsExperience ? "#fff" : "rgba(255,255,255,0.4)" }} value={form.yearsExperience} onChange={set("yearsExperience")}>
                    <option value="">Select range</option>
                    <option value="<1">Less than 1 year</option>
                    <option value="1-2">1–2 years</option>
                    <option value="3-5">3–5 years</option>
                    <option value="6-10">6–10 years</option>
                    <option value="10+">10+ years</option>
                  </select>
                </div>
                <div style={fieldWrap}>
                  <label style={lbl}>Current Brokerage</label>
                  <input style={inp} value={form.currentBrokerage} onChange={set("currentBrokerage")} placeholder="e.g. Keller Williams, independent, etc." />
                </div>
                <div style={fieldWrap}>
                  <label style={lbl}>GCI Last 12 Months</label>
                  <select style={{ ...inp, color: form.gciRange ? "#fff" : "rgba(255,255,255,0.4)" }} value={form.gciRange} onChange={set("gciRange")}>
                    <option value="">Prefer not to say / N/A</option>
                    <option value="$0-25k">$0 – $25k</option>
                    <option value="$25k-75k">$25k – $75k</option>
                    <option value="$75k-150k">$75k – $150k</option>
                    <option value="$150k-300k">$150k – $300k</option>
                    <option value="$300k+">$300k+</option>
                    <option value="new_agent">New agent / not applicable</option>
                  </select>
                </div>
                <div style={fieldWrap}>
                  <label style={lbl}>Closed Transactions (last 12 mo)</label>
                  <input style={inp} type="number" inputMode="numeric" min="0" value={form.transactionsLast12mo} onChange={set("transactionsLast12mo")} placeholder="e.g. 12 (optional)" />
                </div>
                <div style={fieldWrap}>
                  <label style={lbl}>Territory / Market You Work</label>
                  <select style={{ ...inp, color: form.territory ? "#fff" : "rgba(255,255,255,0.4)" }} value={form.territory} onChange={set("territory")}>
                    <option value="">Select a territory</option>
                    {TERRITORIES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* ── Section 3: A Bit More ── */}
            <div style={{ marginBottom: 28 }}>
              <p style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(200,170,90,0.5)", marginBottom: 16, fontWeight: 600 }}>
                A Bit More
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={fieldWrap}>
                  <label style={lbl}>What are you hoping to find in your next brokerage?</label>
                  <textarea style={{ ...inp, minHeight: 80, resize: "vertical", lineHeight: 1.6 }}
                    value={form.reasonForLeaving} onChange={set("reasonForLeaving")}
                    placeholder="Better split, more leads, training, culture..." />
                </div>
                <div style={fieldWrap}>
                  <label style={lbl}>How did you hear about us?</label>
                  <select style={{ ...inp, color: form.referralSource ? "#fff" : "rgba(255,255,255,0.4)" }} value={form.referralSource} onChange={set("referralSource")}>
                    <option value="">Select one</option>
                    <option value="referral">Referral</option>
                    <option value="social">Instagram / Social Media</option>
                    <option value="google">Google Search</option>
                    <option value="job_board">Indeed / Job Board</option>
                    <option value="event">Event / Networking</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                {form.referralSource === "referral" && (
                  <div style={fieldWrap}>
                    <label style={lbl}>Referred by (name)</label>
                    <input style={inp} value={form.referredByName} onChange={set("referredByName")} placeholder="Who sent you our way?" />
                  </div>
                )}
                <div style={fieldWrap}>
                  <label style={lbl}>Anything else you'd like us to know?</label>
                  <textarea style={{ ...inp, minHeight: 72, resize: "vertical", lineHeight: 1.6 }}
                    value={form.applicantNotes} onChange={set("applicantNotes")}
                    placeholder="Optional — any context that would help us have a better first conversation." />
                </div>
              </div>
            </div>

            {error && (
              <div style={{
                padding: "12px 14px", borderRadius: 8, marginBottom: 16,
                background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
                fontSize: 13, color: "#f87171",
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                width: "100%", padding: "15px",
                background: submitting
                  ? "rgba(200,170,90,0.3)"
                  : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                border: "none", borderRadius: 10,
                fontSize: 13, fontWeight: 700, letterSpacing: "0.14em",
                textTransform: "uppercase", color: submitting ? "rgba(255,255,255,0.4)" : "#080808",
                cursor: submitting ? "not-allowed" : "pointer",
                boxShadow: submitting ? "none" : "0 6px 24px rgba(200,170,90,0.3)",
                transition: "all 0.2s",
              }}
            >
              {submitting ? "Sending…" : "Start the Conversation"}
            </button>

            <p style={{ textAlign: "center", fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 14, lineHeight: 1.6 }}>
              No commitment. Alex will reach out personally within one business day.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
