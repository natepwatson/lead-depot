/**
 * CandidateLanding — v15.5 public onboarding welcome page
 * URL: /join/:token
 *
 * Flow:
 *   1) Fetch /api/candidates/by-token/:token (server auto-marks 'started' on first open)
 *   2) Show personalized welcome ("Hi <first>") with entry-path-aware copy
 *   3) "Start Application" → stub for v15.6 questionnaire
 *
 * Handles states: loading | invited | started | submitted | approved | expired | error
 */
import { useEffect, useState } from "react";
import { useRoute } from "wouter";

const GOLD = "#c8aa5a";
const GOLD_SOFT = "#8a6a20";
const BG = "linear-gradient(180deg, #0d0b08 0%, #17130c 55%, #0d0b08 100%)";

interface CandidatePublic {
  firstName: string;
  lastName: string;
  entryPath: string;
  temperature: "nurture" | "hot_prospect" | "vendor";
  fubStage: string;
  status: string;
  tokenExpiresAt?: string;
}

export default function CandidateLanding() {
  const [, params] = useRoute("/join/:token");
  const token = params?.token || "";
  const [state, setState] = useState<"loading" | "ready" | "expired" | "error">("loading");
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
        setState("ready");
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
    maxWidth: 560,
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

  const submitted = candidate.status === "submitted" || candidate.status === "approved" || candidate.status === "active";

  return (
    <div style={containerStyle}>
      <div style={brandStyle}>Brothers Group</div>
      <div style={subStyle}>Real Estate Team · Momentum Realty</div>

      <div style={cardStyle}>
        <div style={{ fontSize: 13, letterSpacing: 2, textTransform: "uppercase", color: GOLD, marginBottom: 8 }}>
          Welcome
        </div>
        <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 500, fontSize: 34, margin: "0 0 20px 0", lineHeight: 1.15 }}>
          Hi {candidate.firstName} —
        </h1>

        {submitted ? (
          <>
            <p style={{ lineHeight: 1.7, fontSize: 16, marginBottom: 20 }}>
              We have your application on file. Alex will be in touch personally within two business days.
            </p>
            <p style={{ lineHeight: 1.7, fontSize: 15, opacity: 0.75 }}>
              If it's been longer than that, reach out any time.
            </p>
          </>
        ) : (
          <>
            <p style={{ lineHeight: 1.7, fontSize: 16, marginBottom: 16 }}>
              Good talking with you. Below is the application — it takes about 10 minutes. It covers your license, experience, and how you like to work.
            </p>
            <p style={{ lineHeight: 1.7, fontSize: 16, marginBottom: 24 }}>
              Once you send it back, Alex reviews personally and will be in touch within two business days.
            </p>

            <button
              onClick={() => {
                // v15.6 stub — questionnaire lives in a future release
                alert("The full application questionnaire ships in v15.6. Alex has been notified that you opened your invitation and will follow up personally.");
              }}
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
              Start Application
            </button>
            <div style={{ marginTop: 12, textAlign: "center", fontSize: 12, opacity: 0.6 }}>
              About 10 minutes · 28 questions · save as you go
            </div>
          </>
        )}

        <div style={{ marginTop: 28, paddingTop: 20, borderTop: `1px solid ${GOLD_SOFT}33`, fontSize: 12, opacity: 0.6, textAlign: "center" }}>
          Lead Depot v15.5 · depot.watsonbrothersgroup.com
        </div>
      </div>
    </div>
  );
}
