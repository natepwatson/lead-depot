// shared/password-rules.ts
// v15.10 — Shared password strength rules used by BOTH the server (enforcement)
// AND the client (live UI feedback). Keep this file dependency-free so it can
// be imported by both a Vite React bundle and a Node CommonJS server build.

export const MIN_PASSWORD_LEN = 10;

// Seeded defaults + obvious weak passwords we never want to see again.
const BANNED_LITERALS = [
  "brothers2026",
  "brothers2025",
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty",
  "qwerty123",
  "letmein",
  "welcome",
  "welcome1",
  "admin",
  "admin123",
  "leaddepot",
  "watsonbrothers",
];

export interface PasswordRuleContext {
  email?: string;
  name?: string;
}

export interface PasswordCheckResult {
  ok: boolean;
  errors: string[]; // human-readable, "Password must ..."-style
  strength: "weak" | "fair" | "strong";
}

/**
 * Validate a candidate password against Lead Depot's rules.
 *
 * Rules (v15.10):
 *   1. At least 10 characters
 *   2. Contains at least one letter AND one digit
 *   3. Contains at least one uppercase OR one symbol
 *   4. Not on the banned literal list (case-insensitive substring match)
 *   5. Does not contain the user's email local-part or full name (case-insensitive)
 *   6. Not entirely repeated characters (e.g. "aaaaaaaaaa")
 */
export function checkPassword(
  pw: string,
  ctx: PasswordRuleContext = {}
): PasswordCheckResult {
  const errors: string[] = [];
  const lower = (pw || "").toLowerCase();

  if (!pw || pw.length < MIN_PASSWORD_LEN) {
    errors.push(`Must be at least ${MIN_PASSWORD_LEN} characters`);
  }

  const hasLetter = /[a-z]/i.test(pw);
  const hasDigit = /\d/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasSymbol = /[^A-Za-z0-9]/.test(pw);

  if (!hasLetter || !hasDigit) {
    errors.push("Must contain both letters and numbers");
  }
  if (!hasUpper && !hasSymbol) {
    errors.push("Must contain an uppercase letter or a symbol");
  }

  for (const banned of BANNED_LITERALS) {
    if (lower.includes(banned)) {
      errors.push(`Cannot contain "${banned}"`);
      break;
    }
  }

  // v15.10 — broader ban: any "brothers<4-digits>" or "watson<4-digits>" pattern.
  // This catches brothers2027, brothers2028, watson1234, etc. without having to
  // enumerate every year in BANNED_LITERALS.
  if (/(brothers|watson|leaddepot|momentum)\s*\d{2,}/i.test(pw)) {
    errors.push("Cannot contain your team name followed by digits");
  }

  const email = (ctx.email || "").toLowerCase();
  if (email) {
    const local = email.split("@")[0];
    if (local && local.length >= 3 && lower.includes(local)) {
      errors.push("Cannot contain your email");
    }
  }
  const name = (ctx.name || "").toLowerCase().trim();
  if (name && name.length >= 3) {
    for (const part of name.split(/\s+/)) {
      if (part.length >= 3 && lower.includes(part)) {
        errors.push("Cannot contain your name");
        break;
      }
    }
  }

  if (pw && /^(.)\1+$/.test(pw)) {
    errors.push("Cannot be a single repeated character");
  }

  // Strength score — used for the live meter in the UI.
  let score = 0;
  if (pw.length >= MIN_PASSWORD_LEN) score++;
  if (pw.length >= 14) score++;
  if (hasLetter && hasDigit) score++;
  if (hasUpper) score++;
  if (hasSymbol) score++;
  const strength: PasswordCheckResult["strength"] =
    score >= 4 ? "strong" : score >= 2 ? "fair" : "weak";

  return { ok: errors.length === 0, errors, strength };
}
