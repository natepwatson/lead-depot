/**
 * CandidateQuestionnaire — v15.6 public 28-question application form.
 * Rendered inline inside CandidateLanding when the user clicks "Start Application".
 *
 * Behavior:
 *  - 6 sections, one visible at a time with a progress bar.
 *  - Section 1 (Basics) is fully required to submit.
 *  - Section 6 (Agreements) has two required checkboxes.
 *  - Save-as-you-go: every text/select change triggers a debounced /save-progress
 *    call so the candidate can close the tab and come back later on the same link.
 *  - On submit, POSTs full answers to /submit and shows a thank-you card.
 *
 * Server contract mirrored here:
 *  POST /api/candidates/by-token/:token/save-progress   body: { answers, currentSection }
 *  POST /api/candidates/by-token/:token/submit          body: { answers }
 */
import { useEffect, useMemo, useRef, useState } from "react";

const GOLD = "#c8aa5a";
const GOLD_SOFT = "#8a6a20";

interface QuestionnaireProps {
  token: string;
  firstName: string;
  lastName: string;
  prefillEmail?: string;
  prefillPhone?: string;
  initialAnswers?: Record<string, any> | null;
  initialSection?: number | null;
  onSubmitted: (result: { recommendation: string; score: number; reason: string }) => void;
}

type Answers = Record<string, any>;

// Section 1
const LICENSE_STATUSES = [
  { v: "active_fl",             l: "Actively licensed in FL" },
  { v: "inactive_fl",           l: "License on file in FL but inactive" },
  { v: "active_other",          l: "Licensed in another state" },
  { v: "in_course",             l: "Enrolled in the FL license course" },
  { v: "unlicensed_interested", l: "Not licensed \u2014 interested in getting started" },
];

// Section 2
const BROKERAGE_TENURE = ["<6mo", "6-12mo", "1-2yr", "2-5yr", "5+yr"];
const CLOSED_12MO = ["0", "1-2", "3-5", "6-10", "11-20", "20+"];
const GCI_RANGE = [
  { v: "<25k",             l: "< $25K" },
  { v: "25-75k",           l: "$25K \u2013 $75K" },
  { v: "75-150k",          l: "$75K \u2013 $150K" },
  { v: "150-300k",         l: "$150K \u2013 $300K" },
  { v: "300k+",            l: "$300K+" },
  { v: "na",               l: "N/A \u2014 not yet earning" },
  { v: "prefer_not_say",   l: "Prefer not to say" },
];
const YEARS_IN_RE = [
  { v: "<1",     l: "Less than a year" },
  { v: "1-2",    l: "1\u20132 years" },
  { v: "3-5",    l: "3\u20135 years" },
  { v: "6-10",   l: "6\u201310 years" },
  { v: "10+",    l: "10+ years" },
  { v: "not_yet", l: "Not yet in real estate" },
];

// Section 3
const SEVEN_DAY_WILLINGNESS = [
  { v: "yes",             l: "Yes \u2014 whatever the client needs" },
  { v: "depends",         l: "Depends on the day/season, generally yes" },
  { v: "no_boundaries",   l: "No \u2014 I have firm work-week boundaries" },
];

// Section 4
const LOCAL_NETWORK_SIZE = [
  { v: "<50",       l: "Under 50 local contacts" },
  { v: "50-200",    l: "50 \u2013 200" },
  { v: "200-500",   l: "200 \u2013 500" },
  { v: "500+",      l: "500+" },
  { v: "not_local", l: "Newer to the area" },
];

// Section 5
const TEAM_VS_SOLO = [
  { v: "team",    l: "Team \u2014 I want to plug into a system" },
  { v: "solo",    l: "Solo \u2014 I run my own book" },
  { v: "both",    l: "Both \u2014 team support with independence" },
  { v: "neither", l: "Neither \u2014 I'm still figuring it out" },
];
const HOPES_OPTIONS = [
  { v: "dbpr_help",         l: "Help with DBPR / getting active" },
  { v: "getting_licensed",  l: "Getting licensed" },
  { v: "more_leads",        l: "More leads / better lead flow" },
  { v: "better_training",   l: "Better training" },
  { v: "better_split",      l: "Better commission split" },
  { v: "mentorship",        l: "Mentorship" },
  { v: "office",            l: "Office / desk space" },
  { v: "community",         l: "Community with other agents" },
  { v: "other",             l: "Something else" },
];
const START_WHEN = [
  { v: "immediately", l: "Immediately" },
  { v: "2weeks",      l: "Within 2 weeks" },
  { v: "1month",      l: "Within a month" },
  { v: "2-3months",   l: "2\u20133 months out" },
  { v: "later",       l: "Later / still deciding" },
];

const SECTIONS: { key: string; label: string; hint?: string }[] = [
  { key: "basics",     label: "Basics",           hint: "Confirm the essentials." },
  { key: "background", label: "Your Background",  hint: "So we know where you're coming from." },
  { key: "drive",      label: "Your Drive",       hint: "This is the section Alex reads twice." },
  { key: "network",    label: "Network & Style",  hint: "How you already work." },
  { key: "fit",        label: "Fit With Us",      hint: "What you're looking for." },
  { key: "agreements", label: "Agreements",       hint: "Two quick confirmations." },
];

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number) {
  let t: any = null;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export default function CandidateQuestionnaire({
  token,
  firstName,
  lastName,
  prefillEmail,
  prefillPhone,
  initialAnswers,
  initialSection,
  onSubmitted,
}: QuestionnaireProps) {
  const [answers, setAnswers] = useState<Answers>(() => ({
    full_name: initialAnswers?.full_name || `${firstName} ${lastName}`.trim(),
    phone: initialAnswers?.phone || prefillPhone || "",
    email: initialAnswers?.email || prefillEmail || "",
    cold_call_comfort: initialAnswers?.cold_call_comfort ?? 7,
    learning_comfort: initialAnswers?.learning_comfort ?? 8,
    hopes: initialAnswers?.hopes || [],
    ...(initialAnswers || {}),
  }));
  const [section, setSection] = useState<number>(
    typeof initialSection === "number" && initialSection >= 0 && initialSection < SECTIONS.length
      ? initialSection
      : 0
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const savingRef = useRef(false);

  // Save-as-you-go
  const saveDraft = useMemo(
    () =>
      debounce(async (a: Answers, s: number) => {
        if (savingRef.current) return;
        savingRef.current = true;
        try {
          const r = await fetch(`/api/candidates/by-token/${encodeURIComponent(token)}/save-progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ answers: a, currentSection: s }),
          });
          if (r.ok) {
            const j = await r.json();
            setSavedAt(j?.savedAt || new Date().toISOString());
          }
        } catch {} finally {
          savingRef.current = false;
        }
      }, 1200),
    [token]
  );

  useEffect(() => {
    // Skip initial autosave until user actually edits something.
    // (Draft only fires on setField below.)
  }, []);

  function setField(key: string, value: any) {
    setAnswers(prev => {
      const next = { ...prev, [key]: value };
      saveDraft(next, section);
      return next;
    });
  }

  function toggleHope(v: string) {
    setAnswers(prev => {
      const cur: string[] = Array.isArray(prev.hopes) ? prev.hopes : [];
      const next = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
      const updated = { ...prev, hopes: next };
      saveDraft(updated, section);
      return updated;
    });
  }

  function validateSection(idx: number): string[] {
    const missingLocal: string[] = [];
    if (idx === 0) {
      if (!String(answers.full_name || "").trim()) missingLocal.push("Full name");
      if (!String(answers.city_county || "").trim()) missingLocal.push("City / county");
      if (!String(answers.license_status || "").trim()) missingLocal.push("License status");
      if (
        answers.license_status &&
        answers.license_status !== "unlicensed_interested" &&
        answers.license_status !== "in_course" &&
        !String(answers.license_number || "").trim()
      ) {
        missingLocal.push("License number");
      }
    }
    if (idx === 5) {
      if (!answers.agreement_team_ethic) missingLocal.push("Team ethic agreement");
      if (!answers.agreement_verify) missingLocal.push("License verification agreement");
    }
    return missingLocal;
  }

  function nextSection() {
    const m = validateSection(section);
    if (m.length) {
      setMissing(m);
      setError(`Please fill in: ${m.join(", ")}`);
      return;
    }
    setError("");
    setMissing([]);
    const nx = Math.min(section + 1, SECTIONS.length - 1);
    setSection(nx);
    saveDraft(answers, nx);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function prevSection() {
    setError("");
    setMissing([]);
    const px = Math.max(section - 1, 0);
    setSection(px);
    saveDraft(answers, px);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitAll() {
    const m1 = validateSection(0);
    const m5 = validateSection(5);
    const m = [...m1, ...m5];
    if (m.length) {
      setMissing(m);
      setError(`Missing required fields: ${m.join(", ")}`);
      // Jump back to the first missing section
      if (m1.length) setSection(0);
      else if (m5.length) setSection(5);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const r = await fetch(`/api/candidates/by-token/${encodeURIComponent(token)}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j?.detail || j?.error || `Submission failed (${r.status})`);
        setSubmitting(false);
        return;
      }
      onSubmitted({
        recommendation: j.recommendation,
        score: j.score,
        reason: j.reason,
      });
    } catch (e: any) {
      setError(e?.message || "Network error \u2014 please try again.");
      setSubmitting(false);
    }
  }

  const progress = Math.round(((section + 1) / SECTIONS.length) * 100);
  const cur = SECTIONS[section];

  return (
    <div>
      {/* Progress + section header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: "#8a8478", marginBottom: 8 }}>
          <span>Step {section + 1} of {SECTIONS.length}</span>
          <span>{progress}%</span>
        </div>
        <div style={{ height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 6, overflow: "hidden" }}>
          <div style={{ width: `${progress}%`, height: "100%", background: `linear-gradient(90deg, ${GOLD_SOFT}, ${GOLD})`, transition: "width .3s ease" }} />
        </div>
        <h2 style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 500, fontSize: 26, margin: "18px 0 4px" }}>{cur.label}</h2>
        {cur.hint && <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>{cur.hint}</div>}
        {savedAt && <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>Saved as you go</div>}
      </div>

      {/* Section body */}
      {section === 0 && <SectionBasics answers={answers} setField={setField} missing={missing} firstName={firstName} lastName={lastName} />}
      {section === 1 && <SectionBackground answers={answers} setField={setField} />}
      {section === 2 && <SectionDrive answers={answers} setField={setField} />}
      {section === 3 && <SectionNetwork answers={answers} setField={setField} />}
      {section === 4 && <SectionFit answers={answers} setField={setField} toggleHope={toggleHope} />}
      {section === 5 && <SectionAgreements answers={answers} setField={setField} missing={missing} />}

      {/* Error / nav */}
      {error && (
        <div style={{ marginTop: 16, padding: "12px 14px", background: "rgba(200,80,80,0.12)", border: "1px solid rgba(200,80,80,0.4)", borderRadius: 8, color: "#ffb0b0", fontSize: 13 }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
        {section > 0 && (
          <button onClick={prevSection} disabled={submitting} style={btnGhost}>
            Back
          </button>
        )}
        {section < SECTIONS.length - 1 ? (
          <button onClick={nextSection} disabled={submitting} style={btnGold}>
            Continue
          </button>
        ) : (
          <button onClick={submitAll} disabled={submitting} style={{ ...btnGold, opacity: submitting ? 0.6 : 1 }}>
            {submitting ? "Sending\u2026" : "Submit Application"}
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------- Sections -------------------

function SectionBasics({ answers, setField, firstName, lastName }: { answers: Answers; setField: (k: string, v: any) => void; missing: string[]; firstName: string; lastName: string }) {
  return (
    <>
      <FieldText
        label="Full name *"
        value={answers.full_name || `${firstName} ${lastName}`.trim()}
        onChange={v => setField("full_name", v)}
      />
      <FieldText
        label="Phone number *"
        value={answers.phone || ""}
        onChange={v => setField("phone", v)}
        placeholder="(904) 555-0100"
      />
      <FieldText
        label="Email *"
        value={answers.email || ""}
        onChange={v => setField("email", v)}
        placeholder="you@example.com"
      />
      <FieldText
        label="Which Northeast Florida city or county do you live in? *"
        value={answers.city_county || ""}
        onChange={v => setField("city_county", v)}
        placeholder="e.g., Jacksonville / Duval County"
      />
      <FieldRadio
        label="Real estate license status *"
        options={LICENSE_STATUSES}
        value={answers.license_status || ""}
        onChange={v => setField("license_status", v)}
      />
      {answers.license_status && answers.license_status !== "unlicensed_interested" && answers.license_status !== "in_course" && (
        <FieldText
          label="License number (SL / BK)"
          value={answers.license_number || ""}
          onChange={v => setField("license_number", v)}
          placeholder="e.g., SL3123456"
        />
      )}
    </>
  );
}

function SectionBackground({ answers, setField }: { answers: Answers; setField: (k: string, v: any) => void }) {
  const licensed = answers.license_status && answers.license_status !== "unlicensed_interested" && answers.license_status !== "in_course";
  return (
    <>
      <FieldText
        label="Current brokerage (if any)"
        value={answers.current_brokerage || ""}
        onChange={v => setField("current_brokerage", v)}
        placeholder="Brokerage name, or 'none' / 'just licensed'"
      />
      {licensed && (
        <>
          <FieldSelect
            label="How long have you been there?"
            options={BROKERAGE_TENURE.map(v => ({ v, l: v }))}
            value={answers.brokerage_tenure || ""}
            onChange={v => setField("brokerage_tenure", v)}
          />
          <FieldTextarea
            label="What would make you leave?"
            value={answers.why_leaving || ""}
            onChange={v => setField("why_leaving", v)}
            placeholder="Optional \u2014 as much or as little as you want."
          />
        </>
      )}
      <FieldSelect
        label="Closed transactions in the last 12 months"
        options={CLOSED_12MO.map(v => ({ v, l: v }))}
        value={answers.closed_transactions_12mo || ""}
        onChange={v => setField("closed_transactions_12mo", v)}
      />
      <FieldSelect
        label="Rough GCI range last year"
        options={GCI_RANGE}
        value={answers.gci_range || ""}
        onChange={v => setField("gci_range", v)}
      />
      <FieldSelect
        label="Years in real estate"
        options={YEARS_IN_RE}
        value={answers.years_in_re || ""}
        onChange={v => setField("years_in_re", v)}
      />
    </>
  );
}

function SectionDrive({ answers, setField }: { answers: Answers; setField: (k: string, v: any) => void }) {
  return (
    <>
      <FieldTextarea
        label="Why real estate?"
        value={answers.why_real_estate || ""}
        onChange={v => setField("why_real_estate", v)}
        placeholder="A paragraph is plenty."
      />
      <FieldTextarea
        label="What would earning $150K in the next 12 months mean to you?"
        value={answers.income_meaning || ""}
        onChange={v => setField("income_meaning", v)}
        placeholder="Concrete goals help \u2014 debt paid off, house, kids, etc."
      />
      <FieldSlider
        label="How comfortable are you making cold calls? (1 = uncomfortable, 10 = love it)"
        value={Number(answers.cold_call_comfort ?? 7)}
        onChange={v => setField("cold_call_comfort", v)}
      />
      <FieldSlider
        label="How much do you enjoy learning new things? (1 = hate it, 10 = love it)"
        value={Number(answers.learning_comfort ?? 8)}
        onChange={v => setField("learning_comfort", v)}
      />
      <FieldRadio
        label="How do you feel about a 7-day-a-week availability window?"
        options={SEVEN_DAY_WILLINGNESS}
        value={answers.seven_day_willingness || ""}
        onChange={v => setField("seven_day_willingness", v)}
      />
      <FieldTextarea
        label="How do you handle rejection?"
        value={answers.rejection_handling || ""}
        onChange={v => setField("rejection_handling", v)}
        placeholder="Honest is better than polished."
      />
    </>
  );
}

function SectionNetwork({ answers, setField }: { answers: Answers; setField: (k: string, v: any) => void }) {
  return (
    <>
      <FieldSelect
        label="Rough size of your local network in NE Florida"
        options={LOCAL_NETWORK_SIZE}
        value={answers.local_network_size || ""}
        onChange={v => setField("local_network_size", v)}
      />
      <FieldTextarea
        label="Have you been in sales before real estate? What kind?"
        value={answers.prior_sales_background || ""}
        onChange={v => setField("prior_sales_background", v)}
      />
      <FieldText
        label="Describe yourself in one sentence"
        value={answers.self_description || ""}
        onChange={v => setField("self_description", v)}
      />
      <FieldTextarea
        label="What's the last thing you learned that you were excited about?"
        value={answers.recent_learning || ""}
        onChange={v => setField("recent_learning", v)}
      />
    </>
  );
}

function SectionFit({ answers, setField, toggleHope }: { answers: Answers; setField: (k: string, v: any) => void; toggleHope: (v: string) => void }) {
  const hopes: string[] = Array.isArray(answers.hopes) ? answers.hopes : [];
  return (
    <>
      <FieldRadio
        label="Team, solo, or both?"
        options={TEAM_VS_SOLO}
        value={answers.team_vs_solo || ""}
        onChange={v => setField("team_vs_solo", v)}
      />
      <div style={{ marginBottom: 22 }}>
        <div style={fieldLabelStyle}>What are you hoping to get out of a new team?</div>
        <div style={{ display: "grid", gap: 8 }}>
          {HOPES_OPTIONS.map(opt => {
            const checked = hopes.includes(opt.v);
            return (
              <label key={opt.v} style={checkRowStyle(checked)}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleHope(opt.v)}
                  style={{ accentColor: GOLD, marginRight: 10 }}
                />
                <span>{opt.l}</span>
              </label>
            );
          })}
        </div>
      </div>
      <FieldSelect
        label="When are you looking to start?"
        options={START_WHEN}
        value={answers.start_when || ""}
        onChange={v => setField("start_when", v)}
      />
      <FieldTextarea
        label="Anything else you want us to know?"
        value={answers.anything_else || ""}
        onChange={v => setField("anything_else", v)}
        placeholder="Optional."
      />
      <FieldText
        label="Referred by anyone at Brothers Group?"
        value={answers.referred_by || ""}
        onChange={v => setField("referred_by", v)}
        placeholder="Name is fine \u2014 optional."
      />
    </>
  );
}

function SectionAgreements({ answers, setField, missing }: { answers: Answers; setField: (k: string, v: any) => void; missing: string[] }) {
  return (
    <>
      <div style={{ marginBottom: 16, padding: 16, background: "rgba(200,170,90,0.06)", border: `1px solid ${GOLD_SOFT}40`, borderRadius: 8 }}>
        <label style={agreementRow(!!answers.agreement_team_ethic, missing.includes("Team ethic agreement"))}>
          <input
            type="checkbox"
            checked={!!answers.agreement_team_ethic}
            onChange={e => setField("agreement_team_ethic", e.target.checked)}
            style={{ accentColor: GOLD, marginTop: 3, marginRight: 12 }}
          />
          <span>
            <strong>Team ethic. *</strong>
            <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
              I understand Brothers Group is a team environment. Leads are shared, wins are shared, and I'll help teammates when I can. I'm not looking to work in a silo.
            </div>
          </span>
        </label>
      </div>
      <div style={{ marginBottom: 16, padding: 16, background: "rgba(200,170,90,0.06)", border: `1px solid ${GOLD_SOFT}40`, borderRadius: 8 }}>
        <label style={agreementRow(!!answers.agreement_verify, missing.includes("License verification agreement"))}>
          <input
            type="checkbox"
            checked={!!answers.agreement_verify}
            onChange={e => setField("agreement_verify", e.target.checked)}
            style={{ accentColor: GOLD, marginTop: 3, marginRight: 12 }}
          />
          <span>
            <strong>License verification. *</strong>
            <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
              I authorize Brothers Group to verify my Florida DBPR license status, or my enrollment in a licensing course, as part of this review.
            </div>
          </span>
        </label>
      </div>
      <div style={{ marginBottom: 8, padding: 16, background: "rgba(255,255,255,0.03)", border: `1px solid rgba(255,255,255,0.08)`, borderRadius: 8 }}>
        <label style={agreementRow(!!answers.agreement_marketing, false)}>
          <input
            type="checkbox"
            checked={!!answers.agreement_marketing}
            onChange={e => setField("agreement_marketing", e.target.checked)}
            style={{ accentColor: GOLD, marginTop: 3, marginRight: 12 }}
          />
          <span>
            <strong>Text / email consent</strong>
            <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>
              I'm okay with Brothers Group texting or emailing me about this application and next steps. Optional.
            </div>
          </span>
        </label>
      </div>
    </>
  );
}

// ------------------- Small field components -------------------

const fieldWrap: React.CSSProperties = { marginBottom: 22 };
const fieldLabelStyle: React.CSSProperties = { display: "block", fontSize: 14, fontWeight: 500, marginBottom: 8, color: "#f2ead4" };

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.05)",
  border: `1px solid ${GOLD_SOFT}40`,
  borderRadius: 8,
  color: "#fff",
  fontSize: 15,
  padding: "12px 14px",
  fontFamily: "'Switzer','Inter',sans-serif",
  outline: "none",
  boxSizing: "border-box",
};

const btnGold: React.CSSProperties = {
  flex: 1,
  background: `linear-gradient(180deg, ${GOLD} 0%, ${GOLD_SOFT} 100%)`,
  color: "#0d0b08",
  fontFamily: "'Switzer','Inter',sans-serif",
  fontWeight: 600,
  fontSize: 15,
  letterSpacing: 1,
  textTransform: "uppercase",
  padding: "14px 20px",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  boxShadow: "0 6px 20px rgba(200,170,90,0.25)",
};
const btnGhost: React.CSSProperties = {
  background: "transparent",
  color: "#e6ddc4",
  border: `1px solid ${GOLD_SOFT}55`,
  padding: "14px 22px",
  fontSize: 14,
  borderRadius: 8,
  cursor: "pointer",
  fontFamily: "'Switzer','Inter',sans-serif",
};

function checkRowStyle(checked: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    padding: "10px 12px",
    borderRadius: 8,
    background: checked ? "rgba(200,170,90,0.10)" : "rgba(255,255,255,0.03)",
    border: `1px solid ${checked ? GOLD_SOFT : "rgba(255,255,255,0.08)"}`,
    cursor: "pointer",
    fontSize: 14,
    transition: "background .15s, border .15s",
  };
}

function agreementRow(checked: boolean, error: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    cursor: "pointer",
    color: error ? "#ffb0b0" : "#fff",
    fontSize: 14,
    lineHeight: 1.5,
  };
}

function FieldText({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div style={fieldWrap}>
      <label style={fieldLabelStyle}>{label}</label>
      <input
        type="text"
        value={value || ""}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={inputStyle}
      />
    </div>
  );
}

function FieldTextarea({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div style={fieldWrap}>
      <label style={fieldLabelStyle}>{label}</label>
      <textarea
        value={value || ""}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        rows={4}
        style={{ ...inputStyle, resize: "vertical", minHeight: 90 }}
      />
    </div>
  );
}

function FieldSelect({ label, options, value, onChange }: { label: string; options: { v: string; l: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={fieldWrap}>
      <label style={fieldLabelStyle}>{label}</label>
      <select
        value={value || ""}
        onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
      >
        <option value="" style={{ background: "#0d0b08" }}>Choose one\u2026</option>
        {options.map(o => (
          <option key={o.v} value={o.v} style={{ background: "#0d0b08" }}>{o.l}</option>
        ))}
      </select>
    </div>
  );
}

function FieldRadio({ label, options, value, onChange }: { label: string; options: { v: string; l: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={fieldWrap}>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={{ display: "grid", gap: 8 }}>
        {options.map(o => {
          const checked = value === o.v;
          return (
            <label key={o.v} style={checkRowStyle(checked)}>
              <input
                type="radio"
                name={label}
                checked={checked}
                onChange={() => onChange(o.v)}
                style={{ accentColor: GOLD, marginRight: 10 }}
              />
              <span>{o.l}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function FieldSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={fieldWrap}>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{ flex: 1, accentColor: GOLD }}
        />
        <div style={{ minWidth: 42, textAlign: "center", padding: "6px 10px", background: "rgba(200,170,90,0.1)", border: `1px solid ${GOLD_SOFT}55`, borderRadius: 6, fontWeight: 600 }}>
          {value}
        </div>
      </div>
    </div>
  );
}
