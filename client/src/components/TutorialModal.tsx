/**
 * TutorialModal — full app tutorial accessible via the help (?) button in the header.
 * Designed for phone browsers. Shows a concise, section-by-section walkthrough.
 */
import { useState } from "react";
import {
  X, Trophy, Phone, Briefcase, UserPlus, UserCircle2,
  ChevronRight, ChevronLeft, Heart, CheckCircle2,
  PhoneMissed, XCircle, AlertTriangle, RefreshCw,
  Map, MessageSquare, Star, Target, Layers, Home as HomeIcon, Flame,
} from "lucide-react";

interface Slide {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}

const GOLD = "#c8aa5a";
const CARD: React.CSSProperties = {
  background: "linear-gradient(135deg,#0f0d08 0%,#0a0908 100%)",
  border: "1px solid rgba(200,170,90,0.15)",
  borderRadius: 14, padding: "18px 16px", marginBottom: 14,
};
const TAG = (color: string): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "4px 10px", borderRadius: 99,
  background: color + "18", border: `1px solid ${color}55`,
  color, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em",
  margin: "2px 3px",
});
const SECTION_TITLE: React.CSSProperties = {
  fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase",
  color: "rgba(200,170,90,0.5)", fontWeight: 700, marginBottom: 14,
};

// ─── Slides ───────────────────────────────────────────────────────────────────
const SLIDES: Slide[] = [
  {
    icon: <Star size={26} style={{ color: GOLD }} />,
    title: "Welcome to Lead Depot",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          Lead Depot is your daily driver for working buyer and seller leads at Brothers Group. Every lead in your queue is a real person who has expressed interest — treat them with care, not urgency.
        </p>
        <div style={CARD}>
          <p style={{ color: "rgba(200,170,90,0.7)", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>The golden rule</p>
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>
            We're never pushy. Our goal is to build a relationship. A lead who says "not now" today can become your best client in six months — log the outcome honestly and stay in their life.
          </p>
        </div>
        <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, lineHeight: 1.6 }}>
          Swipe through these slides to learn each section. It takes about 3 minutes.
        </p>
      </div>
    ),
  },
  {
    icon: <HomeIcon size={26} style={{ color: GOLD }} />,
    title: "Home",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          Your dashboard. Live team leaderboard, Team Pot progress toward the $1,000 monthly pool, the ON AIR / Prime Time banner, and today's dial count — all in one glance.
        </p>
        <div style={CARD}>
          <p style={SECTION_TITLE}>What you'll see</p>
          {[
            ["Rank", "Where you stand vs the team today."],
            ["Dials", "Every call attempt you've logged."],
            ["Contacts", "Leads where you actually spoke to someone."],
            ["Appts", "Appointments set — the most valuable outcome."],
            ["Team Pot", "Live progress bar toward the $1,000 monthly pool."],
            ["On Air", "Prime Time / Mid / Downtime banner — tap to see the full research-locked schedule."],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <span style={{ color: GOLD, fontSize: 12, fontWeight: 700, minWidth: 70 }}>{k}</span>
              <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.5 }}>{v}</span>
            </div>
          ))}
        </div>
        <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 12 }}>
          The leaderboard resets daily. Weekly stats persist across the full week.
        </p>
      </div>
    ),
  },
  {
    icon: <Layers size={26} style={{ color: GOLD }} />,
    title: "Pipeline",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          Every lead you personally moved forward — permanent, yours forever. Nothing here returns to the shared pool.
        </p>
        <div style={CARD}>
          <p style={SECTION_TITLE}>Six stages</p>
          {[
            ["Lead",           "Assigned to you, not yet contacted."],
            ["Contacted",      "You've reached them; still deciding."],
            ["Nurture",        "Longer-term follow-up (Keep in Touch — Nurture)."],
            ["Hot",            "Close to ready (Keep in Touch — Hot Prospect)."],
            ["Appt Set",       "Meeting on the books."],
            ["Client Active",  "Currently working with you."],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 10, marginBottom: 9 }}>
              <span style={{ color: GOLD, fontSize: 12, fontWeight: 700, minWidth: 90 }}>{k}</span>
              <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.5 }}>{v}</span>
            </div>
          ))}
        </div>
        <p style={{ color: "rgba(200,170,90,0.6)", fontSize: 12, lineHeight: 1.6 }}>
          Toggle List ↔ Kanban view with the button in the tab header. Kanban is horizontal-scroll on mobile.
        </p>
      </div>
    ),
  },
  {
    icon: <Phone size={26} style={{ color: GOLD }} />,
    title: "Working a Lead Card",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          The core of Lead Depot. Each card shows the next lead in your queue with their contact info, property details, and a call script.
        </p>
        <div style={CARD}>
          <p style={SECTION_TITLE}>How to use a lead card</p>
          <ol style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
            <li>Tap the phone number to dial directly from your phone.</li>
            <li>Set the Intent at the top of the card (Sell only / Sell & Buy / Buy only). This decides which script to run.</li>
            <li>For sellers use CPMAMA — Condition, Price, Motivation, Agent, Mortgage, Appointment. For buyers use LPMAMA — Location, Price, Motivation, Agent, Mortgage.</li>
            <li>Add call notes as you speak. Notes are visible to the whole team.</li>
            <li>Fill in the CPMAMA / LPMAMA fields as you learn them.</li>
            <li>Log an outcome when you're done with this call.</li>
          </ol>
        </div>
        <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 12 }}>
          Below the lead card you'll also see <b>Listing Intel</b> (MLS data) and <b>Zillow Intel</b> (price, beds, baths, hero photo) whenever we can pull them.
        </p>
      </div>
    ),
  },
  {
    icon: <MessageSquare size={26} style={{ color: GOLD }} />,
    title: "Logging Outcomes",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 14 }}>
          Always log an outcome after every call. This keeps the team's data clean and ensures follow-ups happen.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 0, marginBottom: 14 }}>
          <span style={TAG("rgb(134,239,172)")}><CheckCircle2 size={11} /> Appt Set</span>
          <span style={TAG("rgb(249,168,212)")}><Heart size={11} /> Keep in Touch</span>
          <span style={TAG("rgb(253,224,71)")}><PhoneMissed size={11} /> No Answer</span>
          <span style={TAG("rgb(252,165,165)")}><XCircle size={11} /> Not Interested</span>
          <span style={TAG("rgba(252,165,165,0.8)")}><AlertTriangle size={11} /> Wrong #</span>
        </div>
        <div style={CARD}>
          {[
            ["Appt Set", "Congratulations — fill in the appointment details. Lead closes out."],
            ["Keep in Touch", "You connected, they're not ready right now. Gets sent to FUB for long-term follow-up. Your team takes it from here."],
            ["No Answer", "Marks that number tried. Lead auto-advances to next phone number."],
            ["Not Interested", "Lead is closed. Respectful and final."],
            ["Wrong #", "Strikes that number. Only removes the lead if every number is invalid."],
          ].map(([k, v]) => (
            <div key={k} style={{ borderBottom: "1px solid rgba(200,170,90,0.08)", paddingBottom: 10, marginBottom: 10 }}>
              <p style={{ color: GOLD, fontSize: 11, fontWeight: 700, margin: "0 0 3px", letterSpacing: "0.05em" }}>{k}</p>
              <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, lineHeight: 1.55, margin: 0 }}>{v}</p>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  // v14.38 — "My Leads" tutorial card removed with the tab itself.
  // KIT is a FUB commitment; agents look in Follow Up Boss for long-term nurture.
  {
    icon: <Phone size={26} style={{ color: GOLD }} />,
    title: "Lead Gen [+] — The gold button",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          The gold [+] in the middle of the bottom nav is the master lead-generation button. Tap it and pick your leg.
        </p>
        <div style={CARD}>
          <p style={SECTION_TITLE}>Five ways to work</p>
          {[
            ["Dial",               "Work your assigned queue. LPMAMA / CPMAMA scripts loaded, offline-safe outcome logging."],
            ["Open House",         "Log an OH and add new sign-in leads on the spot."],
            ["Door Knock",         "Log a knock route; add doors turned into leads."],
            ["Direct Mail",        "Log a mail drop and any callbacks from the piece."],
            ["Network Referral",   "Add a lead from your personal network — church, gym, in person. Auto-assigned to you, admins notified, tracked to closing."],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 10, marginBottom: 9 }}>
              <span style={{ color: GOLD, fontSize: 12, fontWeight: 700, minWidth: 110 }}>{k}</span>
              <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.5 }}>{v}</span>
            </div>
          ))}
        </div>
        <p style={{ color: "rgba(200,170,90,0.5)", fontSize: 12, lineHeight: 1.6, marginTop: 4 }}>
          Every leg counts toward your leaderboard rank, challenge progress, and the Team Pot.
        </p>
      </div>
    ),
  },
  {
    icon: <Target size={26} style={{ color: GOLD }} />,
    title: "Challenges",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          Daily and weekly challenges. Bonus points, streak unlocks, and stackers toward the Champion's Bonus.
        </p>
        <div style={CARD}>
          <p style={SECTION_TITLE}>How it works</p>
          <ol style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
            <li>Open the Challenges tab (fourth slot in the bottom nav).</li>
            <li>Toggle between <b>Daily</b> (37 challenges, refresh every day) and <b>Weekly</b> (25 challenges, refresh every Monday).</li>
            <li>Accept the ones that fit your day. Non-gated challenges auto-track from your normal actions.</li>
            <li>Gated challenges (Direct Mail proof, weekly outcome mixes) need a photo or admin approval to claim.</li>
            <li>Stack them for the <b>Lead Diversity Challenge</b> streak and the <b>Champion's Bonus</b> ladder.</li>
          </ol>
        </div>
        <p style={{ color: "rgba(200,170,90,0.5)", fontSize: 12, lineHeight: 1.6, marginTop: 4 }}>
          Challenges are the fastest way to climb the leaderboard without dialing more. Play the smart mix.
        </p>
      </div>
    ),
  },
  {
    icon: <Map size={26} style={{ color: GOLD }} />,
    title: "Team Map",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          Toggle on the Home tab to see where the whole team is working across Northeast Florida.
        </p>
        <div style={CARD}>
          <p style={SECTION_TITLE}>What you'll see</p>
          {[
            ["Green pins",   "Appointments set. Every green dot is a live booking."],
            ["Gold pins",    "Actively working — assigned, callback due, or dialed today."],
            ["Teal pins",    "Territory coverage — leads BGRE owns in the pool."],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 10, marginBottom: 9 }}>
              <span style={{ color: GOLD, fontSize: 12, fontWeight: 700, minWidth: 84 }}>{k}</span>
              <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.5 }}>{v}</span>
            </div>
          ))}
        </div>
        <p style={{ color: "rgba(200,170,90,0.55)", fontSize: 12, lineHeight: 1.6, marginTop: 4 }}>
          <b>Privacy:</b> pins are anonymized and offset ~350m. No names, addresses, or phone numbers ever appear here. This is a bragging · recruiting surface, not a lead browser.
        </p>
      </div>
    ),
  },
  {
    icon: <Flame size={26} style={{ color: "#f97316" }} />,
    title: "Prime Time",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          The always-visible banner at the top of every screen. Tells you at a glance whether we're PRIME, MID, or DOWNTIME.
        </p>
        <div style={CARD}>
          <p style={SECTION_TITLE}>Three tiers</p>
          {[
            ["PRIME",     "Best answer rates. Every dial + outcome pays 1.5x points. Flashing red banner. Dial away."],
            ["MID",       "Standard yield. 1.0x points. Amber banner."],
            ["DOWNTIME",  "Low yield. The dial button locks out with a toast; outcomes still work. Gray banner."],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <span style={{ color: k === "PRIME" ? "#ef4444" : k === "MID" ? "#f59e0b" : "#9ca3af", fontSize: 12, fontWeight: 700, minWidth: 84 }}>{k}</span>
              <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.5 }}>{v}</span>
            </div>
          ))}
        </div>
        <p style={{ color: "rgba(200,170,90,0.5)", fontSize: 12, lineHeight: 1.6, marginTop: 4 }}>
          The app fires one browser notification at the START of every Prime block (never mid-block). Tap the banner to see the full 7-day heatmap and the research behind each hour.
        </p>
      </div>
    ),
  },
  {
    icon: <UserCircle2 size={26} style={{ color: GOLD }} />,
    title: "Your Profile",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          Manage your personal information, headshot, and account security from the Profile tab.
        </p>
        <div style={CARD}>
          <p style={SECTION_TITLE}>What you can update</p>
          {[
            ["Name & Email", "Your public display name and login email."],
            ["Phone", "Your direct number shown to the admin team."],
            ["Brokerage", "Your affiliated brokerage."],
            ["Home Address", "Used for team records only."],
            ["Headshot", "Your photo, shown on the leaderboard."],
            ["Password", "Change anytime — minimum 8 characters."],
            ["Delete Account", "Permanently removes your account. Cannot be undone."],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 10, marginBottom: 9 }}>
              <span style={{ color: GOLD, fontSize: 12, fontWeight: 700, minWidth: 80 }}>{k}</span>
              <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, lineHeight: 1.5 }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    icon: <RefreshCw size={26} style={{ color: GOLD }} />,
    title: "Tips for Best Results",
    body: (
      <div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.7, marginBottom: 14 }}>
          A few habits that separate top performers on the leaderboard.
        </p>
        {[
          ["Dial in Prime Time", "When the banner is PRIME, every dial + outcome pays 1.5x points. Show up in the green blocks and your rank climbs faster."],
          ["Log every call", "Even no-answers. It keeps the system accurate and protects your numbers."],
          ["Add real notes", "Notes are cumulative and visible to the whole team. Write what you'd want to know if you were reading this lead for the first time."],
          ["Use the script", "CPMAMA (sellers) / LPMAMA (buyers) isn't a rigid script — it's a framework. Hit the highlights naturally."],
          ["Be human", "People can tell when they're being sold to. Ask questions. Listen more than you talk."],
          ["Stack challenges", "Accept 2–3 daily challenges every morning — they auto-track from normal work. Free points."],
          ["Refer generously", "Network Referrals are the highest-quality leads in the system. Add them the same day you hear about them."],
        ].map(([k, v]) => (
          <div key={k} style={CARD}>
            <p style={{ color: GOLD, fontSize: 12, fontWeight: 700, margin: "0 0 6px", letterSpacing: "0.04em" }}>{k}</p>
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>{v}</p>
          </div>
        ))}
      </div>
    ),
  },
];

// ─── Modal ────────────────────────────────────────────────────────────────────
export default function TutorialModal({ onClose }: { onClose: () => void }) {
  const [slide, setSlide] = useState(0);
  const current = SLIDES[slide];
  const isLast = slide === SLIDES.length - 1;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)",
      display: "flex", flexDirection: "column",
      fontFamily: "'Switzer','Inter',sans-serif",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 20px",
        borderBottom: "1px solid rgba(200,170,90,0.12)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {current.icon}
          <div>
            <p style={{ fontSize: 9, color: "rgba(200,170,90,0.5)", letterSpacing: "0.2em", textTransform: "uppercase", margin: 0 }}>
              {slide + 1} of {SLIDES.length}
            </p>
            <h2 style={{
              fontFamily: "'Cormorant Garamond','Georgia',serif",
              fontSize: "1.1rem", fontWeight: 400, color: "#fff", margin: 0,
            }}>
              {current.title}
            </h2>
          </div>
        </div>
        <button onClick={onClose} style={{
          width: 36, height: 36, borderRadius: "50%",
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", color: "rgba(255,255,255,0.5)",
        }}>
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 16px" }}>
        {current.body}
      </div>

      {/* Navigation + dots (merged row to prevent overlap) */}
      <div style={{
        flexShrink: 0,
        borderTop: "1px solid rgba(200,170,90,0.1)",
        padding: "10px 20px",
        paddingBottom: "max(10px, env(safe-area-inset-bottom))",
      }}>
        {/* Slide dots */}
        <div style={{ display: "flex", gap: 4, justifyContent: "center", marginBottom: 10 }}>
          {SLIDES.map((_, i) => (
            <div
              key={i}
              onClick={() => setSlide(i)}
              style={{
                width: i === slide ? 20 : 6, height: 6, borderRadius: 99,
                background: i === slide ? GOLD : "rgba(200,170,90,0.2)",
                cursor: "pointer", transition: "all 0.25s",
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
        {slide > 0 && (
          <button
            onClick={() => setSlide(s => s - 1)}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "12px", borderRadius: 8,
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
              color: "rgba(255,255,255,0.5)", fontSize: 13, cursor: "pointer",
            }}
          >
            <ChevronLeft size={15} /> Back
          </button>
        )}
        <button
          onClick={() => isLast ? onClose() : setSlide(s => s + 1)}
          style={{
            flex: 2, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            padding: "12px", borderRadius: 8,
            background: isLast
              ? "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)"
              : "rgba(200,170,90,0.08)",
            border: isLast ? "none" : "1px solid rgba(200,170,90,0.25)",
            color: isLast ? "#080808" : GOLD,
            fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer",
          }}
        >
          {isLast ? "Got it — Let's go" : <>Next <ChevronRight size={15} /></>}
        </button>
        </div>
      </div>
    </div>
  );
}
