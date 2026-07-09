/**
 * FastTrackPage — /join/fast-track
 * The full playbook. How Brothers Group puts a new agent on the fast track.
 * Same luxury dark-gold aesthetic as /join.
 */
import { Link } from "wouter";

const GOLD = "#c8aa5a";
const GOLD_DIM = "rgba(200,170,90,0.55)";
const GOLD_LINE = "rgba(200,170,90,0.2)";

const sectionTitle: React.CSSProperties = {
  fontFamily: "'Cormorant Garamond','Georgia',serif",
  fontSize: "clamp(1.6rem, 5vw, 2.2rem)",
  fontWeight: 300,
  color: "#fff",
  margin: "0 0 12px",
  lineHeight: 1.15,
};

const eyebrow: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.22em",
  textTransform: "uppercase",
  color: GOLD_DIM,
  margin: "0 0 10px",
  fontWeight: 600,
};

const bodyText: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.7,
  color: "rgba(255,255,255,0.7)",
  margin: 0,
};

type Pillar = { num: string; title: string; body: string };

const PILLARS: Pillar[] = [
  {
    num: "01",
    title: "Your Florida License, Handled",
    body: "Not licensed yet? We walk you through DBPR registration, the Florida real estate license course, and every step to sit for the exam. Already licensed? We move you straight to Momentum with zero friction.",
  },
  {
    num: "02",
    title: "Signed with Momentum Realty",
    body: "We get you onboarded at Momentum — one of the most established brokerages in Northeast Florida. Paperwork, MLS, e&o, sign inventory. You show up. We handle the setup.",
  },
  {
    num: "03",
    title: "On the Brothers Group Team",
    body: "You join a team that shows up seven days a week. In-person office hours. Available on the phone when you need us. Team mentality — not a solo hustle where you're the only one answering your own questions.",
  },
  {
    num: "04",
    title: "Real Leads, Day One",
    body: "You get access to Lead Depot — our internal lead distribution app. Real leads. Not scraps. Not multi-split leftovers other teams call \"leads.\" We hand you the phone, you go to work.",
  },
  {
    num: "05",
    title: "50/50 With Real Leads",
    body: "Every other team advertises 50/50 too — and then hands you leads with three splits stacked on top so you're really working at 25/25/25. We don't play that game. Our 50/50 is on real leads, straight up.",
  },
  {
    num: "06",
    title: "Your @watsonbrothersgroup.com Email",
    body: "We set you up on the team domain so every email you send looks like the professional you're becoming — not a personal Gmail. Same for your signature block, headshot, and short bio on our roster.",
  },
  {
    num: "07",
    title: "Scripts, Role-Play, Shadowing",
    body: "Lockbox scripts. Objection frameworks. Role-play sessions until it's second nature. Then real shadowing — in person and over the phone — with agents actually closing deals right now. You watch, then you do.",
  },
  {
    num: "08",
    title: "Every Day Training",
    body: "Not \"we have training resources.\" Every day. Live. In the office or on the phone. If you're new, we bring you up. If you're producing, we sharpen the edge. Growth is scheduled, not accidental.",
  },
  {
    num: "09",
    title: "A Trusted Team, Proven Record",
    body: "Watson Brothers Group at Momentum has the track record. Real closings. Real relationships. Real reviews. You're joining something that already works — and helping us make it work better.",
  },
];

export default function FastTrackPage() {
  return (
    <div style={{
      minHeight: "100dvh",
      background: "linear-gradient(160deg, #080808 0%, #0d0b07 100%)",
      fontFamily: "'Switzer','Inter',sans-serif",
      color: "#fff",
    }}>
      {/* Ambient glow */}
      <div style={{
        position: "fixed", top: "15%", left: "50%", transform: "translateX(-50%)",
        width: 600, height: 600, borderRadius: "50%", pointerEvents: "none",
        background: "radial-gradient(circle, rgba(200,170,90,0.05) 0%, transparent 70%)",
        zIndex: 0,
      }} />

      <div style={{ position: "relative", zIndex: 1 }}>

        {/* Back link */}
        <div style={{ padding: "18px 20px 0", maxWidth: 720, margin: "0 auto" }}>
          <Link href="/join" style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase",
            color: GOLD_DIM, textDecoration: "none", fontWeight: 600,
          }}>
            ← Back to Join
          </Link>
        </div>

        {/* Header */}
        <header style={{
          padding: "36px 20px 40px",
          maxWidth: 720, margin: "0 auto", textAlign: "center",
        }}>
          <svg width="44" height="44" viewBox="0 0 36 36" fill="none" style={{ display: "block", margin: "0 auto 12px" }}>
            <rect x="2" y="18" width="32" height="15" rx="1" stroke={GOLD} strokeWidth="1.6"/>
            <path d="M2 18 L18 5 L34 18" stroke={GOLD} strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
            <rect x="13" y="24" width="10" height="9" rx="0.5" stroke={GOLD} strokeWidth="1.4"/>
          </svg>
          <p style={{ ...eyebrow, textAlign: "center" }}>Brothers Group · Momentum Realty</p>

          <h1 style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            fontSize: "clamp(2.2rem, 8vw, 3.4rem)",
            fontWeight: 300, color: "#fff", margin: "0 0 16px", lineHeight: 1.05,
          }}>
            How We Put You<br/>on the Fast Track.
          </h1>
          <p style={{
            fontSize: 15, color: "rgba(255,255,255,0.5)",
            maxWidth: 480, margin: "0 auto", lineHeight: 1.7,
          }}>
            We don't hand out participation trophies. We hand out real leads, real training, and a real 50/50 split. Here's exactly how we get you producing — fast.
          </p>
        </header>

        {/* Pillars */}
        <section style={{
          padding: "0 20px 40px",
          maxWidth: 720, margin: "0 auto",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {PILLARS.map(p => (
              <article key={p.num} style={{
                background: "rgba(200,170,90,0.04)",
                border: `1px solid ${GOLD_LINE}`,
                borderRadius: 14, padding: "22px 22px 20px",
                display: "flex", gap: 18, alignItems: "flex-start",
              }}>
                <div style={{
                  fontFamily: "'Cormorant Garamond','Georgia',serif",
                  fontSize: 28, fontWeight: 300, color: GOLD,
                  minWidth: 44, lineHeight: 1, paddingTop: 2,
                }}>
                  {p.num}
                </div>
                <div style={{ flex: 1 }}>
                  <h3 style={{
                    fontFamily: "'Cormorant Garamond','Georgia',serif",
                    fontSize: "1.35rem", fontWeight: 400, color: "#fff",
                    margin: "0 0 6px", lineHeight: 1.25,
                  }}>
                    {p.title}
                  </h3>
                  <p style={{ ...bodyText, fontSize: 14 }}>{p.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* Pull quote */}
        <section style={{
          padding: "20px 20px 40px",
          maxWidth: 720, margin: "0 auto", textAlign: "center",
        }}>
          <div style={{
            borderTop: `1px solid ${GOLD_LINE}`,
            borderBottom: `1px solid ${GOLD_LINE}`,
            padding: "36px 20px",
          }}>
            <p style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: "clamp(1.5rem, 5.5vw, 2rem)",
              fontWeight: 300, color: "#fff",
              margin: 0, lineHeight: 1.3, fontStyle: "italic",
            }}>
              "Things don't happen on accident.<br/>
              They happen when people step up<br/>
              to the plate and put in the work."
            </p>
          </div>
        </section>

        {/* Close */}
        <section style={{
          padding: "10px 20px 60px",
          maxWidth: 560, margin: "0 auto", textAlign: "center",
        }}>
          <p style={{ ...eyebrow, textAlign: "center" }}>The Bottom Line</p>
          <h2 style={{ ...sectionTitle, textAlign: "center" }}>
            We're here to cut you to the chase.
          </h2>
          <p style={{ ...bodyText, margin: "0 auto 32px", maxWidth: 460 }}>
            We're straight up. We're here to help you become a top producer in the shortest time possible. If that sounds like what you've been looking for — welcome to the team.
          </p>

          <Link href="/join" style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "15px 32px",
            background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
            border: "none", borderRadius: 10,
            fontSize: 13, fontWeight: 700, letterSpacing: "0.14em",
            textTransform: "uppercase", color: "#080808",
            textDecoration: "none",
            boxShadow: "0 6px 24px rgba(200,170,90,0.3)",
          }}>
            Start the Conversation →
          </Link>

          <p style={{
            fontSize: 11, color: "rgba(255,255,255,0.25)",
            marginTop: 18, letterSpacing: "0.05em",
          }}>
            Alex will reach out personally within one business day.
          </p>
        </section>

      </div>
    </div>
  );
}
