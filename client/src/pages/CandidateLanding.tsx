/**
 * CandidateLanding — v15.7 public onboarding page
 * URL: /join/:token
 *
 * Flow (v15.7):
 *   1) Fetch /api/candidates/by-token/:token (server auto-marks 'started' on first open)
 *   2) Show personalized welcome ("Hi <first>") with entry-path-aware copy
 *   3) "Start Application" → mount the 28-question form inline
 *   4) On successful submit → show thank-you card with recommendation-agnostic copy
 *
 * States: loading | ready | filling | submitted | expired | error
 */
import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import CandidateQuestionnaire from "./CandidateQuestionnaire";

const GOLD = "#c8aa5a";
const GOLD_SOFT = "#8a6a20";
const BG = "linear-gradient(180deg, #0d0b08 0%, #17130c 55%, #0d0b08 100%)";

interface CandidatePublic {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  entryPath: string;
  temperature: "nurture" | "hot_prospect" | "vendor";
  fubStage: string;
  status: string;
  tokenExpiresAt?: string;
  draft?: { answers: Record<string, any>; currentSection: number | null; updatedAt?: string } | null;
}

export default function CandidateLanding() {
  const [, params] = useRoute("/join/:token");
  const token = params?.token || "";
  const [state, setState] = useState<"loading" | "ready" | "filling" | "submitted" | "expired" | "error">("loading");
  const [candidate, setCandidate] = useState<CandidatePublic | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");

  useEffect(() => {
    if (!token) {
      setState("error");
      setErrMsg("No invitation token in URL.");
      return;
    }
    (async () => {
      try {
        const r = await fetch(`/api/candidates/by-token/${encodeURIComponent(token)}`);
        if (r.status === 410) {
          setState("expired");
          return;
        }
        if (!r.ok) {
          setErrMsg(`We couldn't find this invitation (status ${r.status}). Please check with the person who sent you the link.`);
          setState("error");
          return;
        }
        const j = await r.json();
        setCandidate(j.candidate);
        // If already submitted/approved, jump straight to the submitted state.
        if (j.candidate.status === "submitted" || j.candidate.status === "approved" || j.candidate.status === "active") {
          setState("submitted");
        } else {
          setState("ready");
        }
      } catch (err: any) {
        setErrMsg(err?.message || "Network error. Please try again.");
        setState("error");
      }
    })();
  }, [token]);

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: BG,
    color: "#fff",
    fontFamily: "'Switzer','Inter',sans-serif",
    padding: "40px 20px 60px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
  };

  const cardStyle: React.CSSProperties = {
    maxWidth: 620,
    width: "100%",
    background: "rgba(255,255,255,0.04)",
    border: `1px solid ${GOLD_SOFT}55`,
    borderRadius: 14,
    padding: "36px 30px",
    marginTop: 24,
    backdropFilter: "blur(6px)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
  };

  const brandStyle: React.CSSProperties = {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 28,
    letterSpacing: 2,
    color: GOLD,
    textTransform: "uppercase",
    marginBottom: 4,
  };

  const subStyle: React.CSSProperties = {
    fontSize: 12,
    letterSpacing: 3,
    textTransform: "uppercase",
    color: "#8a8478",
  };

  if (state === "loading") {
    return (
      <div style={containerStyle}>
        <div style={{ marginTop: 100, opacity: 0.7 }}>Loading your invitation…</div>
      </div>
    );
  }

  if (state === "expired") {
    return (
      <div style={containerStyle}>
        <div style={brandStyle}>Brothers Group</div>
        <div style={subStyle}>Real Estate Team · Momentum Realty</div>
        <div style={cardStyle}>
          <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 500, fontSize: 30, marginTop: 0, marginBottom: 12 }}>
            This link has expired
          </h1>
          <p style={{ lineHeight: 1.6, opacity: 0.85 }}>
            Application links are active for 14 days. Reach out to Alex directly and he'll send a fresh one.
          </p>
          <div style={{ marginTop: 20, padding: 14, background: "rgba(200,170,90,0.08)", borderLeft: `3px solid ${GOLD}`, borderRadius: 4 }}>
            <div style={{ fontSize: 14 }}>Alex Watson</div>
            <div style={{ fontSize: 13, opacity: 0.8 }}>alex@watsonbrothersgroup.com</div>
            <div style={{ fontSize: 13, opacity: 0.8 }}>(904) 800-8846</div>
          </div>
        </div>
      </div>
    );
  }

  if (state === "error" || !candidate) {
    return (
      <div style={containerStyle}>
        <div style={brandStyle}>Brothers Group</div>
        <div style={subStyle}>Real Estate Team · Momentum Realty</div>
        <div style={cardStyle}>
          <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 500, fontSize: 26, marginTop: 0 }}>
            We hit a snag
          </h1>
          <p style={{ lineHeight: 1.6, opacity: 0.85 }}>{errMsg || "Something went wrong."}</p>
        </div>
      </div>
    );
  }

  if (state === "submitted") {
    return (
      <div style={containerStyle}>
        <div style={brandStyle}>Brothers Group</div>
        <div style={subStyle}>Real Estate Team · Momentum Realty</div>
        <div style={cardStyle}>
          <div style={{ fontSize: 13, letterSpacing: 2, textTransform: "uppercase", color: GOLD, marginBottom: 8 }}>
            All done
          </div>
          <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 500, fontSize: 32, margin: "0 0 20px 0", lineHeight: 1.2 }}>
            Thanks, {candidate.firstName}.
          </h1>
          <p style={{ lineHeight: 1.7, fontSize: 16, marginBottom: 16 }}>
            We have your application. Alex will personally read through it and be in touch within two business days.
          </p>
          <p style={{ lineHeight: 1.7, fontSize: 15, opacity: 0.75 }}>
            You should have a confirmation email in your inbox already. If anything comes up in the meantime, just reply to that email or reach out any time.
          </p>
          <div style={{ marginTop: 24, padding: 14, background: "rgba(200,170,90,0.08)", borderLeft: `3px solid ${GOLD}`, borderRadius: 4 }}>
            <div style={{ fontSize: 14 }}>Alex Watson</div>
            <div style={{ fontSize: 13, opacity: 0.8 }}>alex@watsonbrothersgroup.com</div>
            <div style={{ fontSize: 13, opacity: 0.8 }}>(904) 800-8846</div>
          </div>
          <div style={{ marginTop: 28, paddingTop: 20, borderTop: `1px solid ${GOLD_SOFT}33`, fontSize: 12, opacity: 0.6, textAlign: "center" }}>
            Lead Depot v15.7 · depot.watsonbrothersgroup.com
          </div>
        </div>
      </div>
    );
  }

  if (state === "filling") {
    return (
      <div style={containerStyle}>
        <div style={brandStyle}>Brothers Group</div>
        <div style={subStyle}>Real Estate Team · Momentum Realty</div>
        <div style={cardStyle}>
          <CandidateQuestionnaire
            token={token}
            firstName={candidate.firstName}
            lastName={candidate.lastName}
            prefillEmail={candidate.email}
            prefillPhone={candidate.phone}
            initialAnswers={candidate.draft?.answers || null}
            initialSection={candidate.draft?.currentSection ?? null}
            onSubmitted={() => setState("submitted")}
          />
          <div style={{ marginTop: 28, paddingTop: 20, borderTop: `1px solid ${GOLD_SOFT}33`, fontSize: 12, opacity: 0.6, textAlign: "center" }}>
            Lead Depot v15.7 · depot.watsonbrothersgroup.com
          </div>
        </div>
      </div>
    );
  }

  // state === "ready" — landing card (v15.7: RealTrends trajectory + founder-access)
  const hasDraft = !!candidate.draft && candidate.draft.answers && Object.keys(candidate.draft.answers || {}).length > 0;
  const econCell: React.CSSProperties = {
    padding: "14px 10px",
    textAlign: "center",
    borderRight: `1px solid ${GOLD_SOFT}33`,
  };
  const econNum: React.CSSProperties = {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 26,
    color: GOLD,
    lineHeight: 1.1,
    marginBottom: 4,
  };
  const econLbl: React.CSSProperties = {
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: "#a8a29a",
  };
  return (
    <div style={containerStyle}>
      <div style={brandStyle}>Brothers Group</div>
      <div style={subStyle}>Real Estate Team · Momentum Realty</div>

      <div style={cardStyle}>
        {/* Trajectory pill */}
        <div style={{ fontSize: 11, letterSpacing: 2.5, textTransform: "uppercase", color: GOLD, marginBottom: 10, opacity: 0.9 }}>
          RealTrends 500 · #440 in the U.S.
        </div>

        <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 500, fontSize: 30, margin: "0 0 14px 0", lineHeight: 1.2 }}>
          From 4 agents in a Jacksonville office to 268 agents and $583M in volume.
        </h1>
        <p style={{ lineHeight: 1.6, fontSize: 15, opacity: 0.85, marginBottom: 20, fontStyle: "italic", fontFamily: "'Cormorant Garamond', serif" }}>
          Founder-owned. Founder-led. Two operators who still answer their own phones.
        </p>

        {/* Economics block */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          background: "rgba(200,170,90,0.06)",
          border: `1px solid ${GOLD_SOFT}44`,
          borderRadius: 8,
          marginBottom: 24,
          overflow: "hidden",
        }}>
          <div style={econCell}>
            <div style={econNum}>100%</div>
            <div style={econLbl}>Commission</div>
          </div>
          <div style={econCell}>
            <div style={econNum}>$12K</div>
            <div style={econLbl}>Flat Annual Cap</div>
          </div>
          <div style={{ ...econCell, borderRight: "none" }}>
            <div style={econNum}>$0</div>
            <div style={econLbl}>Monthly Fees</div>
          </div>
        </div>

        {/* Personal welcome */}
        <div style={{ fontSize: 13, letterSpacing: 2, textTransform: "uppercase", color: GOLD, marginBottom: 8 }}>
          {candidate.firstName ? `Welcome, ${candidate.firstName}` : "Welcome"}
        </div>
        <p style={{ lineHeight: 1.7, fontSize: 15, marginBottom: 14 }}>
          Below is the application — about 10 minutes, covering your license, experience, and how you work.
        </p>
        <p style={{ lineHeight: 1.7, fontSize: 15, marginBottom: 24, opacity: 0.85 }}>
          Once you send it back, Alex or Nate reviews personally and will be in touch within two business days.
        </p>

        {hasDraft && (
          <div style={{ marginBottom: 16, padding: 12, background: "rgba(200,170,90,0.08)", borderLeft: `3px solid ${GOLD}`, borderRadius: 4, fontSize: 14 }}>
            We saved your progress from earlier — pick up where you left off.
          </div>
        )}

        <button
          onClick={() => setState("filling")}
          style={{
            width: "100%",
            background: `linear-gradient(180deg, ${GOLD} 0%, ${GOLD_SOFT} 100%)`,
            color: "#0d0b08",
            fontFamily: "'Switzer','Inter',sans-serif",
            fontWeight: 600,
            fontSize: 15,
            letterSpacing: 1,
            textTransform: "uppercase",
            padding: "16px 20px",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
            boxShadow: "0 6px 20px rgba(200,170,90,0.25)",
          }}
        >
          {hasDraft ? "Continue Application" : "Start Application"}
        </button>
        <div style={{ marginTop: 12, textAlign: "center", fontSize: 12, opacity: 0.6 }}>
          About 10 minutes · 28 questions · save as you go · no pressure, no pitch deck
        </div>

        <div style={{ marginTop: 28, paddingTop: 20, borderTop: `1px solid ${GOLD_SOFT}33`, fontSize: 11, opacity: 0.55, textAlign: "center", lineHeight: 1.6 }}>
          Momentum Realty · RealTrends 500 (2025 data)<br/>
          Lead Depot v15.7 · depot.watsonbrothersgroup.com
        </div>
      </div>
    </div>
  );
}
