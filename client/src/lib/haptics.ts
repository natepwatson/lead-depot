// v15.11.10 — Vibration API haptics.
// Progressive enhancement: navigator.vibrate exists on Android; iOS silently ignores.
// Patterns kept short — >300ms feels like a machine, <150ms feels like a nudge.

function safeVibrate(pattern: number | number[]) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch { /* silent */ }
}

/** On Air window opened — the "wake up" pattern. */
export function hapticOnAirStart() { safeVibrate([100, 60, 100, 60, 200]); }

/** Appt Set logged — a small celebration. */
export function hapticApptSet() { safeVibrate([80, 40, 80, 40, 300]); }

/** KIT logged — quiet acknowledgment. */
export function hapticKit() { safeVibrate([60, 40, 60]); }

/** Generic outcome tap — 30ms tick. */
export function hapticTap() { safeVibrate(30); }

/** Recycle / soft outcome — two short taps. */
export function hapticSoft() { safeVibrate([40, 30, 40]); }
