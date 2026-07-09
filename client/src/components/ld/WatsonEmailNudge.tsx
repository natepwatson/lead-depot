/**
 * WatsonEmailNudge — v14.29.1
 * Nag on every login for any user whose email doesn't end in
 * @watsonbrothersgroup.com. Dismissible per session (sessionStorage),
 * so it reappears on the next login. Admins bypass.
 *
 * This is NOT a hard block. It's a persistent nudge encouraging agents
 * to move to their brothersgroup email once onboarding is complete.
 */
import { useState, useEffect } from "react";
import { Mail } from "lucide-react";

interface WatsonEmailNudgeProps {
  userEmail: string;
  userName: string;
}

const DISMISS_KEY = "ld:watsonNudgeDismissed";

export default function WatsonEmailNudge({ userEmail, userName }: WatsonEmailNudgeProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const needsNudge = !!userEmail && !userEmail.toLowerCase().endsWith("@watsonbrothersgroup.com");
    const dismissed = sessionStorage.getItem(DISMISS_KEY) === "1";
    setVisible(needsNudge && !dismissed);
  }, [userEmail]);

  const dismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setVisible(false);
  };

  if (!visible) return null;

  const firstName = (userName || "there").split(" ")[0];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "rgba(0,0,0,0.72)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 20px",
      }}
      onClick={dismiss}
      data-testid="watson-email-nudge"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 440,
          width: "100%",
          background: "linear-gradient(160deg, #14110a 0%, #0f0d08 100%)",
          border: "1px solid rgba(200,170,90,0.3)",
          borderRadius: 12,
          padding: "32px 28px",
          color: "#e5e2dc",
          boxShadow: "0 24px 48px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "linear-gradient(135deg,#c8aa5a,#a8893a)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 20px",
          }}
        >
          <Mail size={26} color="#080808" />
        </div>

        <h2
          style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            fontWeight: 300,
            fontSize: 26,
            color: "#fff",
            textAlign: "center",
            margin: "0 0 12px",
            letterSpacing: "0.01em",
          }}
        >
          Hey {firstName} — one thing.
        </h2>

        <p
          style={{
            fontSize: 14,
            lineHeight: 1.65,
            color: "rgba(255,255,255,0.7)",
            textAlign: "center",
            margin: "0 0 20px",
          }}
        >
          You're logged in with{" "}
          <span style={{ color: "#c8aa5a", fontWeight: 600 }}>{userEmail}</span>.
          Every agent on the team needs a{" "}
          <strong style={{ color: "#fff" }}>@watsonbrothersgroup.com</strong> email
          for outbound and client-facing work.
        </p>

        <div
          style={{
            padding: "12px 14px",
            background: "rgba(200,170,90,0.08)",
            border: "1px solid rgba(200,170,90,0.2)",
            borderRadius: 6,
            marginBottom: 20,
          }}
        >
          <p
            style={{
              fontSize: 12,
              lineHeight: 1.6,
              color: "rgba(255,255,255,0.75)",
              margin: 0,
            }}
          >
            <strong style={{ color: "#c8aa5a" }}>Next step:</strong> Reach out to
            Alex or Nate to get your{" "}
            <span style={{ fontFamily: "monospace", color: "#c8aa5a" }}>
              firstname@watsonbrothersgroup.com
            </span>{" "}
            provisioned. Once you have it, update your profile and this reminder
            goes away.
          </p>
        </div>

        <button
          onClick={dismiss}
          style={{
            width: "100%",
            padding: "12px",
            background: "linear-gradient(135deg,#c8aa5a 0%,#a8893a 100%)",
            border: "none",
            borderRadius: 6,
            color: "#080808",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
          data-testid="button-dismiss-nudge"
        >
          Got it — remind me next login
        </button>
      </div>
    </div>
  );
}
