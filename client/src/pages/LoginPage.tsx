import { useState, useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";

// ─── 12 Unsplash photos — 2400px retina quality ──────────────────────────────
const PHOTOS = [
  { id: "1613977257363-707ba9348227", label: "Scottsdale · Desert Ridge Estate",    headline: "Desert Prestige,\nUnrivaled <em>Scale.</em>" },
  { id: "1600596542815-ffad4c1539a9", label: "Los Angeles · Hollywood Hills",       headline: "Hillside Living\nAt Its <em>Finest.</em>" },
  { id: "1600585154340-be6161a56a0c", label: "Malibu · Pacific Coast",              headline: "Where The Ocean\nMeets <em>Luxury.</em>" },
  { id: "1512917774080-9991f1c4c750", label: "Miami · Star Island",                 headline: "Island Estate,\nStar <em>Caliber.</em>" },
  { id: "1631049307264-da0ec9d70304", label: "Manhattan · Central Park West",       headline: "Above The City,\nBeyond <em>Compare.</em>" },
  { id: "1564013799919-ab600027ffc6", label: "Palm Beach · Estate Row",             headline: "Legacy Estates,\nEndless <em>Prestige.</em>" },
  { id: "1558618666-fcd25c85cd64",   label: "Aspen · Snowmass Ridge",              headline: "Mountain Grandeur,\nModern <em>Opulence.</em>" },
  { id: "1582268611958-ebfd161ef9cf", label: "Beverly Hills · Sunset Strip",        headline: "Views Worth\nEvery <em>Dollar.</em>" },
  { id: "1523217582562-09d0def993a6", label: "Scottsdale · Desert Mountain",        headline: "Architectural\nMastery <em>Perfected.</em>" },
  { id: "1600047509358-9dc75507daeb", label: "Austin · Barton Creek Reserve",       headline: "Hill Country\nLives <em>Beautifully.</em>" },
  { id: "1560448204-e02f11c3d0e2",   label: "Chicago · Gold Coast Penthouse",       headline: "Penthouse Views,\nGold Coast <em>Living.</em>" },
  { id: "1568605114967-8130f3a36994", label: "Naples · Gulf Shore",                headline: "Gulf Waters,\nPrivate <em>Sanctuary.</em>" },
];

function getPhotoUrl(id: string) {
  return `https://images.unsplash.com/photo-${id}?w=2400&q=90&fit=crop&auto=format`;
}

function getDayIndex() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  return dayOfYear % PHOTOS.length;
}

// ─── Logo SVG ────────────────────────────────────────────────────────────────
function LogoIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 36 36" fill="none" aria-label="Lead Depot">
      <rect x="2" y="18" width="32" height="15" rx="1" stroke="#c8aa5a" strokeWidth="1.4"/>
      <path d="M2 18 L18 5 L34 18" stroke="#c8aa5a" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
      <rect x="13" y="24" width="10" height="9" rx="0.5" stroke="#c8aa5a" strokeWidth="1.2"/>
    </svg>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [current, setCurrent] = useState(getDayIndex());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const photoRef = useRef<HTMLDivElement>(null);

  // Auto-advance photos
  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCurrent(c => (c + 1) % PHOTOS.length);
    }, 8000);
  };

  useEffect(() => {
    startTimer();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const handleDotClick = (idx: number) => {
    setCurrent(idx);
    startTimer(); // reset timer on manual click
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await login(email.trim(), password);
    } catch {
      setError("Invalid credentials. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const photo = PHOTOS[current];
  const headlineHtml = photo.headline.replace(/\n/g, "<br>");

  return (
    <div style={{ display: "flex", height: "100dvh", background: "#080808", fontFamily: "'Switzer','Inter',sans-serif" }}>

      {/* ── PHOTO SIDE ─────────────────────────────────────────────────────── */}
      <div
        ref={photoRef}
        onMouseEnter={() => { if (timerRef.current) clearInterval(timerRef.current); }}
        onMouseLeave={startTimer}
        style={{
          flex: "0 0 58%",
          position: "relative",
          overflow: "hidden",
        }}
        className="hidden md:block"
      >
        {/* Photo slides */}
        {PHOTOS.map((p, i) => (
          <div
            key={p.id}
            style={{
              position: "absolute", inset: 0,
              opacity: i === current ? 1 : 0,
              transition: "opacity 1.2s cubic-bezier(0.4,0,0.2,1)",
            }}
          >
            <img
              src={getPhotoUrl(p.id)}
              alt={p.label}
              style={{
                width: "100%", height: "100%", objectFit: "cover",
                filter: "brightness(0.72) contrast(1.06) saturate(0.82)",
              }}
              loading={i === current ? "eager" : "lazy"}
            />
          </div>
        ))}

        {/* Gradient overlay */}
        <div style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(to right, rgba(0,0,0,0) 50%, #080808 100%), linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0) 25%)",
          pointerEvents: "none",
        }} />

        {/* Caption */}
        <div style={{ position: "absolute", bottom: 52, left: 52, zIndex: 2 }}>
          <p style={{
            fontSize: 9, letterSpacing: "0.28em", textTransform: "uppercase",
            color: "rgba(255,255,255,0.45)", marginBottom: 14,
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <span style={{ display: "block", width: 24, height: 1, background: "rgba(200,170,90,0.55)" }} />
            Exclusive Properties
          </p>
          <h2
            style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: "clamp(2.2rem,3.5vw,4rem)", fontWeight: 300,
              color: "#fff", lineHeight: 1.0, letterSpacing: "-0.01em",
              textShadow: "0 4px 40px rgba(0,0,0,0.5)",
            }}
            dangerouslySetInnerHTML={{ __html: headlineHtml.replace(/<em>/g, '<em style="font-style:italic;color:rgba(200,170,90,0.88)">') }}
          />
        </div>

        {/* Location label */}
        <p style={{
          position: "absolute", bottom: 14, left: 52, zIndex: 2,
          fontSize: 9, letterSpacing: "0.14em",
          color: "rgba(255,255,255,0.22)",
        }}>
          {photo.label}
        </p>

        {/* Dot indicators */}
        <div style={{
          position: "absolute", bottom: 52, right: 28, zIndex: 2,
          display: "flex", flexDirection: "column", gap: 6, alignItems: "center",
        }}>
          {PHOTOS.map((_, i) => (
            <button
              key={i}
              onClick={() => handleDotClick(i)}
              aria-label={`Photo ${i + 1}`}
              style={{
                width: 4,
                height: i === current ? 14 : 4,
                borderRadius: i === current ? 2 : "50%",
                background: i === current ? "rgba(200,170,90,0.75)" : "rgba(255,255,255,0.2)",
                border: "none", padding: 0, cursor: "pointer",
                transition: "background 0.3s, height 0.3s",
              }}
            />
          ))}
        </div>
      </div>

      {/* ── FORM SIDE ──────────────────────────────────────────────────────── */}
      <div style={{
        flex: 1,
        background: "#080808",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: "60px 52px",
        overflowY: "auto",
      }}>
        <div style={{ width: "100%", maxWidth: 360 }}>
          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 52 }}>
            <LogoIcon />
            <span style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: 16, fontWeight: 400, letterSpacing: "0.22em",
              color: "#fff", textTransform: "uppercase",
            }}>
              Lead Depot
            </span>
          </div>

          {/* Heading */}
          <h1 style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            fontSize: "clamp(2.2rem,3.5vw,3rem)", fontWeight: 300,
            color: "#fff", letterSpacing: "-0.01em", marginBottom: 8, lineHeight: 1.05,
          }}>
            Welcome<br />Back.
          </h1>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", marginBottom: 40, letterSpacing: "0.02em" }}>
            Access your exclusive property pipeline
          </p>

          {/* Form */}
          <form onSubmit={handleSubmit}>
            {/* Email */}
            <div style={{ marginBottom: 22 }}>
              <label style={{
                display: "block", fontSize: 9, letterSpacing: "0.22em",
                textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 9,
              }}>Email Address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@watsonbrothers.com"
                autoComplete="email"
                style={{
                  width: "100%", background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  padding: "14px 18px", borderRadius: 3,
                  fontFamily: "'Switzer','Inter',sans-serif", fontSize: 14,
                  color: "#fff", outline: "none",
                  transition: "border-color 0.2s, background 0.2s",
                }}
                onFocus={e => { e.target.style.borderColor = "rgba(200,170,90,0.45)"; e.target.style.background = "rgba(255,255,255,0.06)"; }}
                onBlur={e => { e.target.style.borderColor = "rgba(255,255,255,0.1)"; e.target.style.background = "rgba(255,255,255,0.04)"; }}
              />
            </div>

            {/* Password */}
            <div style={{ marginBottom: 22 }}>
              <label style={{
                display: "block", fontSize: 9, letterSpacing: "0.22em",
                textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 9,
              }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••••"
                autoComplete="current-password"
                style={{
                  width: "100%", background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  padding: "14px 18px", borderRadius: 3,
                  fontFamily: "'Switzer','Inter',sans-serif", fontSize: 14,
                  color: "#fff", outline: "none",
                  transition: "border-color 0.2s, background 0.2s",
                }}
                onFocus={e => { e.target.style.borderColor = "rgba(200,170,90,0.45)"; e.target.style.background = "rgba(255,255,255,0.06)"; }}
                onBlur={e => { e.target.style.borderColor = "rgba(255,255,255,0.1)"; e.target.style.background = "rgba(255,255,255,0.04)"; }}
              />
            </div>

            {/* Error */}
            {error && (
              <p style={{ fontSize: 12, color: "#f87171", marginBottom: 14, letterSpacing: "0.02em" }}>
                {error}
              </p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%", marginTop: 10,
                background: loading ? "rgba(200,170,90,0.4)" : "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
                border: "none", padding: "16px",
                borderRadius: 3,
                fontFamily: "'Switzer','Inter',sans-serif",
                fontSize: 11, fontWeight: 600, letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "#080808", cursor: loading ? "not-allowed" : "pointer",
                transition: "opacity 0.2s, transform 0.15s",
              }}
              onMouseEnter={e => { if (!loading) { (e.target as HTMLButtonElement).style.opacity = "0.88"; (e.target as HTMLButtonElement).style.transform = "translateY(-1px)"; } }}
              onMouseLeave={e => { (e.target as HTMLButtonElement).style.opacity = "1"; (e.target as HTMLButtonElement).style.transform = "translateY(0)"; }}
            >
              {loading ? "Signing In…" : "Sign In to Dashboard"}
            </button>
          </form>

          <p style={{
            marginTop: 32, fontSize: 10, color: "rgba(255,255,255,0.16)",
            letterSpacing: "0.08em", textAlign: "center", textTransform: "uppercase",
          }}>
            Watson Brothers Group · Confidential
          </p>
          <p style={{
            marginTop: 8, fontSize: 9, color: "rgba(255,255,255,0.1)",
            letterSpacing: "0.14em", textAlign: "center", textTransform: "uppercase",
          }}>
            Lead Depot v9.0
          </p>
        </div>
      </div>


    </div>
  );
}
