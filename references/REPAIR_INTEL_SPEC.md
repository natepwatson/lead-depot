# Repair Program — Change Orders + Photo Intel Spec

Single source of truth for the next phase of the Repair Quote program. Read this
before touching change-order, photo, or property-data code. Companion to
`ONBOARDING_SPEC.md` and `ABSENTEE_SPEC.md` — same "spec first, then build in
phases" discipline.

## Ground rules (non-negotiable, confirmed by Alex)

1. **The quote stays a template.** No AI ever generates or edits quote/invoice
   text. The client's name and the agent-selected scope of work are the quote.
2. **Photo intel is advisory only.** Anything derived from a photo (counts,
   material guesses, measurements) is presented to the agent as a labeled
   "Intel — not guaranteed accurate" hint. It NEVER auto-populates a line item,
   quantity, price, or the approval flow. The agent always manually selects
   what goes on the invoice. This is a liability protection, not just a UX
   choice — say so in the UI copy itself.
3. **Evidence rule:** we can only quote what we have a photo of. Every scoped
   item needs a photo. The same photo set doubles as before/after proof of
   completed work.
4. **Speed is a feature.** Every added photo step gets compressed client-side
   immediately on selection (already shipped in v20.11.0) — never wait to
   compress at send time.
5. **Not renovating — value-adding.** Recommendations are constrained to
   services Brothers Group actually offers (the existing `repair_items`
   catalog), scoped toward "bring value up to an appropriate sale-ready level,"
   not full remodels.

## Current data model (v20.11.0, verified from `server/repairConsult.ts`)

- `repair_items` — the catalog of things we sell. `category` is `in_house` |
  `vendor`. `trade`, `name`, `unit` (`sqft`|`linear_ft`|`each`|`flat`),
  `default_rate`, `min_charge`, `two_story_eligible`, `instruction`.
- `repair_vendors` — trade, name, email, phone.
- `repair_consults` — one per quote. `property_address`, `hero_photo_url`,
  `property_photos` (JSON array — currently just a flat gallery), `status`
  (`draft`|`quoted`|`sent`|`accepted`|`work_order_sent`), `subtotal`, `total`,
  `deposit_amount`, `final_amount`, `quote_token`, `accepted_at`,
  `work_order_sent_at`.
- `repair_consult_items` — the actual line items on a quote. `item_key`,
  `quantity`, `unit_rate`, `line_total`, `photos` (JSON array, currently
  unused per-item — removed from UI in v20.11.0), `measurement_notes`.
- `repair_vendor_dispatches` — outbound vendor-quote-request tracking per
  trade/consult.

## Part A — Change Orders

**Problem:** once a consult is `accepted` or `work_order_sent`, there's
currently no way to add scope and get it approved without redoing the whole
quote.

**Design:**
- New table `repair_change_orders`: `id`, `consult_id`, `agent_id`,
  `item_key` (or `custom_description` for anything off-catalog),
  `quantity`, `unit_rate`, `line_total`, `reason` (free text — why this is
  needed), `photos` (JSON array, reuses the same upload endpoint/pattern),
  `status` (`pending`|`approved`|`declined`), `requested_at`, `decided_at`,
  `decided_by`.
- Agent flow: from an accepted/in-progress consult, "Request Change Order" →
  pick an existing catalog item or describe a custom one → attach photo(s) as
  evidence → quantity/estimated rate → submit. Status `pending`.
- Admin flow (you/Alex): a Change Orders queue (mirrors the existing Consults
  admin tab pattern from v20.9.0) — approve or decline. Approving:
  1. Inserts a normal row into `repair_consult_items` linked back to the
     change order (so it flows through the same PDF/invoice generator you
     already have — no parallel code path).
  2. Recalculates `subtotal`/`total`/`final_amount` on `repair_consults`
     using the exact same math already in `generateQuotePdf`.
  3. Generates a short "Change Order Approved" PDF/email to the client: what
     was added, why, the new amount now due (the delta, not just the new
     total — avoid confusion), using the same template styling as the main
     quote (no AI-generated copy — a fill-in-the-blanks template like the
     rest of the app).
- Declining just closes the row with a reason, no financial impact.

**Open question for Alex:** does the client need to e-sign the change order
the same way they sign the original agreement, or is an emailed notice
sufficient since it's smaller dollar amounts? Affects whether we reuse the
print/e-sign flow from v20.9.0 or just send-and-record.

## Part B — Agent photography instructions (shot list)

Shown once, prominently, at the very start of the consult (Info step or a
new interstitial before it) — not buried in a tooltip. Plain checklist,
no AI, just clear instructions:

> **Before you start pricing anything, plan to photograph:**
> - All four sides of the home (front, back, both sides)
> - Full yard and landscaping (front and back)
> - Every room inside — including patios, porches, garages, sheds
> - Anything you're pricing in-house (close + wide shot of each item)
> - Anything going to a vendor (roofing, electrical, plumbing, HVAC, etc.) —
>   vendors quote off these photos, so get clear, well-lit, close shots
> - **Rule: if it's not photographed, it can't be quoted.** The photo is
>   your evidence and your before/after proof.

This is copy-only — no schema change. Goes on the hero-photo step (upfront,
matches v20.11.0's restructuring) and is restated as a header on the new
end-of-flow gallery step so agents don't forget by the time they get there.

## Part C — County-data property reference panel

**What's real and automatic (no AI, public record + math):**
- Lot size and heated/living sqft — already available via the
  `property-appraiser-lookup` skill for Duval, Nassau, Baker, Clay, St Johns,
  Putnam, Flagler, Volusia (FL) and Camden, Glynn (GA).
- Flooring sqft estimate = heated living area (direct proxy).
- Interior wall area estimate = living area × standard ceiling height, minus
  a standard opening deduction — labeled "estimate."
- Building perimeter / exterior wall area — accurate ONLY where the county
  GIS publishes an actual building-footprint polygon (need to verify this
  per-county before promising it; several NE FL counties do via ArcGIS REST).
  Where unavailable, fall back to a footprint-as-rectangle approximation,
  clearly labeled lower-confidence.

**What needs agent input (not in any county record):**
- Driveway and walkway square footage — agent enters a quick estimate.
- Yard size = lot size − house footprint − agent-entered driveway/walkway.
- Number of stories (usually in the record, but verify) — needed because
  footprint ≠ heated sqft once there's a second story.

**UI placement:** a collapsible "Property Reference" panel on the Info step,
auto-filled from the county lookup, with a one-line "estimate, not exact"
disclaimer on every derived number. Agent can override any field.

## Part D — Photo intel (the big one)

**Categories, captured at upload time (not AI-detected):**
- **Overview photos** — general house/yard condition shots (front, back,
  sides, yard, rooms as a whole).
- **Repair scope photos** — specifically what's being priced (an item, a
  wall, a fixture, a slab, etc.).

Simplest reliable implementation: the new end-of-flow gallery step (shipped
in v20.11.0) gets a two-button toggle per photo (or per batch) — "Overview" /
"Repair Scope" — set by the agent at upload time. Zero AI needed for the
sort itself, which is the least error-prone piece and worth shipping first
regardless of what happens with Part D's AI layer below.

**AI layer (optional, phase 2, needs your sign-off on cost per consult):**
For photos tagged "Repair Scope" only (keeps cost bounded — never runs on
every overview shot):
- Auto-caption: short description of what's in the photo.
- Counts where visually countable: outlets, switches, fixtures, fans,
  hardware pieces.
- Material description where visible: e.g. tile color/texture/approximate
  size/shape, grout color, paint sheen — presented as a guess, not a fact.
- Constrained recommendation: suggest which `repair_items` catalog entry
  (only entries YOU offer) the photo most likely matches — never invents a
  service outside the catalog.
- Everything above renders in a read-only "Intel" card next to the photo,
  visibly labeled "AI estimate — verify before pricing," and a settings
  toggle to turn this off per-consult or app-wide if it's ever noisy.
- Items that don't match anything in your catalog get flagged for the
  vendor-quote-request email — sent only when the agent confirms it's
  actually worth chasing (their judgment call, not automatic), keeping the
  email scoped to "make the sale more viable," not "renovate everything we
  see."

**Explicitly NOT doing (per your correction):** no measurement extrapolation
promised as authoritative from a single 2D photo without a reference scale —
that's a research-grade computer vision problem and would be actively
misleading to present as a real number. Any "measurement" from a photo stays
qualitative (small/medium/large) unless a future version adds a scale
reference (e.g., a tape measure or known-size object in frame).

**Before/after evidence:** each `repair_consult_items` row already has a
`photos` JSON column (currently unused per-item, removed from the UI in
v20.11.0 for capture purposes but kept for backend compatibility). Reuse it,
but populate it two ways instead of one: `before_photos` and `after_photos`
(new columns, or restructure the JSON to `{before: [], after: []}`). "After"
photos get captured at work-completion, giving you the proof-of-completion
record for free once this exists.

## Suggested build order

1. **Ship now, zero AI, low risk:** Photo Overview/Repair-Scope tagging at
   upload (Part D, tagging only) + the agent shot-list copy (Part B). Both
   are UI/copy changes on the step you just shipped in v20.11.0.
2. **Change Orders** (Part A) — self-contained, reuses existing invoice math
   and PDF generator, clear approve/decline admin flow. Needs your answer on
   e-sign vs. emailed-notice above.
3. **County-data reference panel** (Part C) — needs a per-county GIS-
   footprint feasibility check before promising perimeter/wall-area numbers;
   flooring/lot-size math can ship immediately.
4. **AI photo intel** (Part D, AI layer) — last, because it's the only piece
   with real per-photo cost and the highest risk of over-promising accuracy.
   Ship with the "Intel — not guaranteed" framing baked into the UI from day
   one, not bolted on after.
5. **Before/after evidence columns** — small schema addition, can ride along
   with whichever of the above ships first that touches `repair_consult_items`.

## Decisions (confirmed by Alex, 8/19/26)

1. **E-sign + office approval, both required.** Every quote AND every change
   order needs an internal office/admin approval step BEFORE it goes out to
   the owner for e-signature. This is a new gate — today `sendApprovalEmail`
   goes straight to the client with no internal review step. Add a
   `office_approved_at` / `office_approved_by` pair on `repair_consults`
   (and the equivalent on `repair_change_orders`) and block the client-facing
   send until that's set. Client still e-signs exactly like the existing
   accept flow.
2. **AI photo intel: on by default.** Alex explicitly confirmed AI
   involvement is fine here ("finite scope of home repairs" — the catalog is
   bounded, so constrain every AI suggestion to `repair_items` keys only,
   never a freeform guess, which is what makes this reliable without
   ongoing tuning). No opt-out toggle needed for v1.
3. **No dollar threshold — always admin approval.** Every order and every
   change order requires admin approval before it's sent to the owner to
   sign. No fast-path.
4. **CC list, effective immediately, all repair-consult emails:** always CC
   nate@watsonbrothersgroup.com, alex@watsonbrothersgroup.com, and
   denise@watsonbrothersgroup.com. Update the `ADMIN_EMAILS` constant in
   `server/repairConsult.ts` (currently just alex + nate) to include Denise
   — this is a one-line, ship-immediately change, not gated on anything else
   in this spec.
