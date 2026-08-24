# Vendor Pricing, In-House Scope Expansion, FUB Milestones & Contract Disclosures — Spec

Single source of truth for this build. Companion to `ONBOARDING_SPEC.md`, `ABSENTEE_SPEC.md`,
and `REPAIR_INTEL_SPEC.md` — same "spec first, then build in phases" discipline. Read this
before touching inspection pricing, the repair catalog, FUB task code, the vendor directory,
work-order fields, or either contract's liability language.

**Status:** Plan finalized 8/24/26. Not yet built — no code changes, no version bump, no
deploy have happened for anything in this file. Kept local to the sandbox repo (not pushed)
until Phase 1 actually ships, so we don't burn a Railway deploy cycle on a docs-only commit.

## Origin

Alex, 8/24/26: "Use what jason gave as base pricing for that vendor specifically. each vendor
will have different pricing... depending on square footage or other criteria it can vary the
price. We need to have this verbiage on our contracts... look into industry standard pricing...
Let me know what questions to ask Nate about the payment portal... All of these items are
priority so we just need to build it all."

Plus his original 9-item list (water heater, roof, electrical, inspection pricing/markup, FUB
milestones, full system audit, meeting cadence/work orders, vendor list w/ quote upload,
inspection contract liability page) and Jason Brown's actual reply on his pricing.

## Part 1 — Per-vendor inspection pricing (replaces the flat placeholder catalog)

### Why the current schema doesn't work

`inspection_items` (see `server/inspections.ts`) is one global flat `client_price` /
`vendor_cost` per item type (Home Inspection, WDO, 4pt, WM, Pool, Septic). That assumes one
vendor and one price. Reality: **every vendor has their own pricing, and most vendors price by
square footage or other criteria** (age of home, insurance-only vs. bundled, etc.). The schema
needs to move from "one price per item" to "one price per (vendor, item, sqft band, context)."

### New data model

- `inspection_vendors` — `id`, `name`, `phone`, `email`, `notes`, `subcontractor_name` (e.g.
  "Bug Man Express" for Jason's WDO subcontractor), `active`.
- `inspection_vendor_pricing` — `id`, `vendor_id`, `item_key` (`hi`|`wdo`|`4pt`|`wm`|`pool`|
  `septic`), `context` (`standalone` | `bundled_with_hi` — needed because WM/4pt price
  differently depending on whether a full HI is also ordered), `sqft_min`, `sqft_max`
  (nullable = no upper bound), `vendor_cost`, `notes`.
- `markup_pct` lives on `inspection_vendors` (vendor-level default) with an optional override
  per `inspection_vendor_pricing` row if a specific item needs a different margin.
- `client_price` becomes **computed, not stored**: `vendor_cost × (1 + markup_pct)`, rounded to
  the nearest $5. `inspection_order_items` still stores the resolved `client_price` /
  `vendor_cost` at time of order (so historical orders don't shift if pricing changes later),
  but the catalog itself is now vendor + sqft + context aware.
- `inspection_orders` gains a `subject_sqft` field (pulled from the property-appraiser lookup
  already run on every listing) so the correct tier resolves automatically.

### Jason Brown — first vendor entry, seeded from his actual reply

Jason's reply gives starting prices but not his full sqft ladder:
> Home inspection starts at $349. WM and 4pt differ, with a full home inspection start at $75
> each depending on sqft. Without a home inspection, insurance comp inspections start at $95
> ea. WDO scheduled via Bug Man Express for ~$125, same-day.

**Placeholder tier ladder below — built from his starting numbers + industry-standard
per-sqft scaling (see Part 1a) — clearly marked as a placeholder until Jason sends his real
tier sheet.** Use this to seed the catalog now so pricing doesn't block other work; swap in his
real numbers the moment he sends them (should be a data update, not a schema change).

**Home Inspection (Jason, vendor_cost):**

| Sqft | Vendor Cost |
|---|---|
| 0 – 2,000 | $349 |
| 2,001 – 2,500 | $399 |
| 2,501 – 3,000 | $449 |
| 3,001 – 3,500 | $499 |
| 3,501 – 4,000 | $549 |
| 4,001+ | Call for quote |

**WM + 4pt, bundled with a full HI (Jason, vendor_cost, each):**

| Sqft | Vendor Cost |
|---|---|
| 0 – 2,500 | $75 |
| 2,501 – 3,500 | $95 |
| 3,501+ | $115 |

**WM + 4pt, standalone / insurance-comp-only (Jason, vendor_cost, each):**

| Sqft | Vendor Cost |
|---|---|
| 0 – 2,500 | $95 |
| 2,501 – 3,500 | $115 |
| 3,501+ | $135 |

**WDO (Jason → Bug Man Express subcontractor):** flat $125, no sqft scaling given — leave flat
until told otherwise.

**Pool / Septic:** still no vendor cost from Jason — keep as `TBD`, not on his pricing list.

### Part 1a — Industry-standard sanity check (Florida, 2026)

Pulled to confirm Jason's numbers are reasonable and to build defensible placeholder tiers for
future vendors before we have their real sheets:

- Full home inspection: most FL inspectors run **$300–$450 starting** under ~2,000 sqft, scaling
  up roughly **$50–$100 per 500 sqft band** beyond that, with larger homes (3,500+) landing
  $550–$800+. ([RealPha](https://www.realpha.com/blog/home-inspection-costs-in-florida),
  [InspectAndTest](https://inspectandtest.net/guides/home-inspection-cost-florida/),
  [Target Inspections FL](https://targetinspectionsflorida.com/services-and-pricing/),
  [Residential Inspection FL](https://www.residentialinspectionfla.com/fee-schedule--packages.html))
  Jason's $349 starting price sits right in this band.
- Wind mitigation standalone: **$75–$150** typical, **$100–$300** upper range.
  ([InspectorData](https://inspectordata.com/wind-mitigation-inspection-cost.html),
  [CurrentCost](https://currentcost.org/wind-mitigation-inspection-price-florida/))
- 4-point standalone: **$75–$175**, commonly ~$125.
  ([EssentialsHomeInspections](https://essentialshomeinspections.com/4-point-inspection-cost-florida-2026/),
  [InspectorData](https://inspectordata.com/blog/4-point-inspection-cost.html))
- WM+4pt bundled: **$125–$250** combined, vs. $150–$300+ booked separately.
  ([MyPropFile](https://mypropfile.com/learn/wind-mitigation-inspection),
  [HomeScanFL](https://www.homescanfl.com/blog/wind-mitigation-inspection-in-florida-what-it-is-what-it-costs-and-how-it-can-lower-your-insurance))
- WDO: **$75–$200**, median ~$125. ([WDOInspectionFlorida](https://wdoinspectionflorida.com/),
  [DadePestSolutions](https://dadepestsolutions.com/resource-center/wdo-inspection-cost-florida))

Jason's numbers are all within (or slightly under) the market — his $75/each bundled WM+4pt is
on the cheap end of the $125–$250 combined range, which is a good sign for margin room.

### Markup recommendation

**Default 25% markup on vendor cost, rounded to the nearest $5**, applied automatically per
vendor at the vendor level (editable per vendor, and overridable per item if a specific line
needs different margin). This satisfies "add a profit % to every inspection... should change
dynamically based on vendor pricing" — since it's a %, it scales automatically across sqft
tiers and across vendors without hand-editing every price point when a vendor updates their
sheet.

**Example client pricing at 25% markup (Jason, bundled context, 0–2,000 sqft home):**

| Item | Vendor Cost | Client Price (25%) |
|---|---|---|
| Home Inspection | $349 | $435 |
| WM (bundled) | $75 | $95 |
| 4pt (bundled) | $75 | $95 |
| WDO | $125 | $155 |
| **Full bundle total** | **$624** | **$780** |

That's a **$156 profit per standard bundle** on a sub-2,000 sqft home, growing with sqft.
Confirm 25% is the right number, or tell me a different target — easy to change since it's a
config value, not hardcoded logic.

## Part 2 — Contract verbiage: vendor pricing may vary

Both contract types need a variable-pricing disclosure since neither currently states that
final vendor pricing depends on sqft/site conditions confirmed at scheduling time.

**For the Inspection order e-sign flow (`server/inspections.ts` approval email / agreement):**

> **Pricing Disclosure.** Pricing shown for inspection services in this order is based on our
> vendor's published starting rate for a property of this general size and is provided for
> planning purposes. Final pricing is confirmed by the inspection vendor at the time of
> scheduling and may vary based on the property's square footage, age, accessibility, and other
> site-specific factors. Any change from the price shown here will be communicated to you before
> the inspection is confirmed. Brothers Group coordinates scheduling on your behalf and does not
> perform, warranty, or guarantee any inspection findings — that responsibility belongs solely to
> the licensed inspection vendor.

**For the Repair & Renovation Agreement (extends the existing licensed-trade carve-out
language in `server/repairConsult.ts` around line 568/595):**

> **Vendor Pricing Disclosure.** Any item in this Agreement requiring a licensed trade
> (electrical, plumbing, roofing, HVAC, water heater replacement or upgrade, structural, or
> similar) is quoted and performed by an independent, licensed vendor from our vendor list, not
> by Brothers Group's in-house crew. Vendor pricing may vary based on square footage, site
> conditions, code requirements, permit needs, and material availability, and is only confirmed
> once the vendor completes their own on-site assessment. Brothers Group passes through the
> vendor's quoted price plus a coordination fee and is not the performing party, and carries no
> liability, for any licensed-trade work.

Both slot into the existing liability-section pattern each contract already uses — no new
section structure needed, just new paragraphs in the existing carve-out language.

## Part 3 — In-house catalog additions (defined-line rule applies — every item needs a cap)

Per Alex's standing rule: no open-ended scope, every task needs an explicit maximum.

**Water heater — in-house exact/like-for-like swap only:**
> Water heater replacement — like-for-like swap only. Same fuel type (gas-to-gas or
> electric-to-electric), same tank capacity ± 5 gallons, up to a 50-gallon standard residential
> unit, using existing connections only (no new gas line, no relocation, no code-required
> upsizing). Cap: 1 unit per job. Anything outside this scope — tankless conversion, capacity
> upsize, fuel-type conversion, relocation — routes to the licensed vendor (`v_water_heater`
> stays as-is for those cases).

**Roof — minor repair, in-house:**
> - Nail pop repair — re-set and seal, up to 15 nail pops per job.
> - Glue-down loose/lifted shingles — up to 10 shingles per job.
> - Seal exposed flashing or small hole with roof cement — up to 3 spots, 6 inches or less each.
>
> Anything beyond these caps, or any active leak diagnosis/structural repair, routes to the
> licensed vendor (`v_roofing`).

**Electrical — minor, in-house:**
> - GFCI outlet replacement/install — up to 6 GFCIs per job, existing standard circuit only, no
>   new circuit run. (New in-house item — today's `outlet_replace` explicitly excludes GFCI.)
> - Ceiling fan install — already exists (`ceiling_fan_install`), keep its existing cap (standard
>   fan up to 5 blades, existing box/wiring).
> - Light fixture replacement — already exists (`light_fixture_replace`), keep its existing cap
>   (nothing over 15 lbs).
>
> Anything beyond these — new circuits, panel work, fixture over 15 lbs — routes to the licensed
> vendor (`v_electrical`).

## Part 4 — FUB milestone tasks & appointments

Today, only one hardcoded task exists ("Send accolades email" for Denise) plus `/appointments`
creation on Appt Set. Build a generic milestone-task engine instead of one-off hardcoding:

**New table `fub_milestone_tasks`** (admin-configurable): `id`, `trigger_event` (e.g.
`inspection_scheduled`, `inspection_completed`, `repair_contract_signed`, `repair_start_date`,
`repair_punch_out`, `repair_final_payment_due`, `offer_submitted`, `invoice_sent`), `task_name`,
`days_offset` (relative to the trigger date), `assigned_fub_user_id`, `active`.

**Milestones to cover, mapped to existing app events:**
- Inspection order approved/scheduled → task to confirm scheduling
- Inspection completed → task to follow up on results with client
- Repair consult accepted → "Initial Start Meeting" task (see Part 5)
- Repair start date set → on-site reminder task
- Repair work-order sent → "Schedule Punch-Out Meeting" task
- Repair marked complete → "Final/Payment Meeting" task
- Offer submitted (existing FUB stage change) → task for deadline tracking
- Invoice/payment due (once Part 7's payment portal is wired in) → payment-due reminder task

Reuses the exact `fubRequest("POST", "/tasks", ...)` pattern already proven in `server/fub.ts` —
just parameterized instead of hardcoded to one task.

## Part 5 — Repair project meeting cadence + formal work orders

**New table `repair_project_meetings`**: `id`, `consult_id`, `meeting_type` (`initial_start` |
`punch_out` | `final_payment`), `scheduled_at`, `completed_at`, `notes`, `fub_task_id`
(cross-reference to Part 4's task).

**Work order enhancement** (`repair_consults` already has `work_order_pdf_url` and a punch-out
deadline field per v20.32.0): add `tools_needed` (text list) and `time_block_estimate` (e.g.
"8:00 AM – 12:00 PM") to the work-order generator so every work order specifies instructions,
tools, and an estimated time block — not just line items.

Each of the 3 meetings gets its own FUB task (Part 4) fired automatically off consult status
changes (`accepted` → Initial Start, `work_order_sent` + punch-out deadline approaching → Punch-
Out, completion/final invoice → Final/Payment).

## Part 6 — Vendor directory upgrade

Current `repair_vendors` table: `trade`, `name`, `email`, `phone`, `notes` — no file upload, no
structured pricing, no client-facing presentation.

**Additions:**
- `pricing_sheet_url` — uploaded vendor quote/pricing sheet (PDF or image), stored the same way
  other property-package PDFs are stored today.
- Structured pricing lives in the new `inspection_vendor_pricing` table (Part 1) for inspection
  vendors, or a parallel `repair_vendor_pricing` table (same shape: vendor_id, item/trade,
  sqft or scope band, cost) for repair-trade vendors.
- `license_number`, `insurance_expiration`, `service_area`, `credentials_notes` — so we can show
  a real vendor credibility card, not just a name/email.
- **Client-facing "Vendor Profile" card** — a clean, brand-styled summary (photo/logo if
  available, trade, credentials, service area, blurb) that can be attached to quotes/emails
  instead of exposing the raw internal contact record. This is the "present professionally"
  piece Alex asked for.

## Part 7 — Payment collection (ANSWERED by Nate, 8/24/26)

**Nate's answer: no processor, no API, no webhooks.** Accepted payment rails are check, wire,
Zelle, Cash App, Apple Pay, Venmo, or cash — with a photo and signature captured at the moment
of exchange as proof. This is fully manual/person-to-person, not a merchant account. It
replaces the "wire up an existing API" plan entirely — Part 7 is now a **build-it-ourselves
feature inside Lead Depot**, not an integration.

### Design: "Record Payment" flow

**New table `payment_records`:** `id`, `source_type` (`repair_consult` | `inspection_order`),
`source_id`, `amount`, `method` (`check`|`wire`|`zelle`|`cash_app`|`apple_pay`|`venmo`|`cash`),
`reference_note` (check #, wire confirmation #, Zelle/Venmo/Cash App transaction ID — whatever
applies), `evidence_photo_url` (photo of the cash/check, or a screenshot of the digital payment
confirmation), `receipt_photo_url` (photo of the fully-signed Payment Received line/document),
`company_rep_agent_id` (must be Alex, Nate, or Denise), `company_rep_signature_data`,
`client_signature_name`, `client_signature_data`, `signed_at`, `recorded_by_agent_id`
(restricted to Alex/Nate/Denise), `recorded_at`, `notes`.

Reuses the exact signature-capture component already built for quote acceptance
(`accepted_signature_name`/`accepted_ip` pattern in `repair_consults`) — no new UI paradigm,
just two instances of the same signature pad on one screen. Alex, Nate, or Denise opens the
consult/order, taps **Record Payment**, picks amount + method, uploads the evidence photo,
captures both signatures on the Payment Received line (Company Representative + Client), then
photographs the fully-signed line as the final receipt. That signed photo record IS the receipt
— this is what makes an all-manual/no-processor system defensible.

**Multiple partial payments per job:** since these are informal rails (not a processor with a
running ledger), a job needs to support more than one `payment_records` row — e.g. deposit via
Zelle, final via check — rather than the current single `deposit_amount`/`final_amount` pair.
Sum of `payment_records.amount` for a source should reconcile against `total` on the parent
consult/order.

**FUB tie-in:** recording a payment fires an FUB note/task ("Payment received — $X via
[method]") and can close out the Part 4 "payment due" milestone task automatically instead of
someone flipping status by hand.

**Processing fees:** moot for these rails — Zelle/Venmo/Cash App/Apple Pay/cash are free
person-to-person; check has no fee; wire may carry a flat bank fee (ask Nate if that's passed
through or absorbed). No markup adjustment needed.

### Confirmed by Alex, 8/24/26

1. **Invoice/quote payment options — no pre-filled handles.** List the accepted methods by name
   only (Check, Wire, Zelle, Cash App, Apple Pay, Venmo, Cash) on quotes/invoices. Actual
   account/handle details are communicated directly once the client says which method they want
   to use — not printed on the document itself.
2. **"Payment Received" line — two signatures.** Every recorded payment gets a Payment Received
   line/section with two signature fields: **Company Representative** and **Client**. The
   Company Representative signature must be Alex, Nate, or Denise — confirmed specifically for
   cash exchanges; applying the same two-signature structure to every method by default for
   consistency (check/wire/digital included) unless told otherwise.
3. **Evidence captured, confirmed for cash:** (a) a photo of the cash itself as evidence of the
   amount, and (b) a photo of the fully-signed Payment Received document/line. Applying the same
   "transaction evidence + fully-signed Payment Received photo" pattern to the other methods by
   default (check → photo of the check; Zelle/Cash App/Apple Pay/Venmo/wire → screenshot of the
   confirmation) alongside the same signed Payment Received photo, unless told otherwise.
4. **Who can log a payment in the app — restricted to Alex, Nate, and Denise only.** No general
   agent access to the Record Payment screen. Matches the company-rep signature restriction in
   #2 — the same three people both collect/witness and log it.

## Part 8 — Inspection contract liability back page

Model this on the existing Repair & Renovation Agreement's liability language (non-GC
disclaimer, licensed-trade carve-out, Section 8 pattern already proven there) rather than
writing new legal language from scratch. Add a dedicated back page to the inspection order
e-sign flow (`server/inspections.ts`) covering:
- Brothers Group acts only as a scheduling coordinator for inspections, not the performing party
- No warranty or guarantee of inspection findings — that sits entirely with the licensed
  inspection vendor
- The Part 2 vendor-pricing-may-vary disclosure
- Client responsibility for site access and any conditions that could affect vendor pricing or
  scheduling
- Limitation-of-liability clause matching the repair agreement's Section 8 structure

## Suggested build order (all items are priority — this is about dependencies, not importance)

1. **In-house catalog additions** (Part 3) — no schema needed for vendor pricing, just new
   `repair_items` rows with caps. Ships fastest, zero risk.
2. **Contract verbiage** (Parts 2 & 8) — text-only additions to existing PDF/email templates,
   no new schema. Can ship alongside #1.
3. **Per-vendor pricing schema + Jason seed data** (Part 1) — foundational for #4 and #6, so it
   goes before those. Uses placeholder tiers until Jason's real sheet arrives (swap is a data
   update, not a rebuild).
4. **Vendor directory upgrade** (Part 6) — depends on #3's pricing tables existing.
5. **FUB milestone task engine** (Part 4) — independent of pricing work, can build in parallel
   with #3/#4.
6. **Repair meeting cadence + work order fields** (Part 5) — depends on #4's task engine to fire
   the three meeting tasks automatically.
7. **Payment recording ("Record Payment" flow)** (Part 7) — no longer blocked on an external
   integration now that Nate confirmed it's manual rails only. Only blocked on the 4 small
   config questions in Part 7 (payment handles, who signs, what gets photographed, who can
   record). Can move up once those are answered — it's a self-contained feature, independent
   of #3/#4/#5/#6.

## Open questions for Alex

1. Confirm 25% default markup on inspection vendor cost — or a different number?
2. Jason's real sqft tier breakpoints — worth asking him directly for his fee schedule instead
   of us guessing further, now that we have a reasonable placeholder to seed with?
3. Water heater/roof/electrical caps above — approve as written, or adjust the numbers (e.g. is
   15 nail pops the right ceiling, or should it be lower/higher)?
4. Does every repair project really need all 3 meetings (Initial Start / Punch-Out / Final), or
   only projects above a certain dollar size?

## Part 9 — Land Clearing (vendor trade, built v20.33.0)

Vendor: **Alex Porter** — real Follow Up Boss contact, no email/phone on file yet. Add him
through the existing free-text `trade` field on the Admin → Vendor Directory "Add Vendor" form
(`trade: "land_clearing"`) once his contact info is ready — no code/UI change needed for that.

**Reference job (Alex's own numbers):** 0 Charles Avenue, Jacksonville FL — 0.38 acres
(16,764 sqft), undeveloped/treed. Porter's verbatim quote: "$750 for this small job (4-hour
minimum on his brush cutter)... typically $1,500 for an acre."

**Pricing formula (fully admin-editable, `land_clearing_settings` singleton table):**
- `base_price` (default $750) — flat price below the acreage threshold (his 4-hour minimum)
- `acreage_threshold` (default 0.5 acres) — below this, charge `base_price` flat
- `per_acre_rate` (default $1,500/acre) — at/above threshold, `vendorCost = acres * per_acre_rate`
- `markup_pct` (default 20%) — `clientPrice = vendorCost * (1 + markup_pct)`

**Endpoints:**
- `GET /api/land-clearing/settings` — read current settings (any signed-in agent)
- `PATCH /api/admin/land-clearing/settings` — admin-only, update any of the 4 fields
- `GET /api/land-clearing/estimate?acres=X` or `?propertyAddress=X` — computes the suggested
  vendor cost + client price; if `propertyAddress` is passed without `acres`, pulls acreage
  from Smart Data automatically

**UI:**
- Admin → Vendor Directory tab → "Land Clearing Pricing (Alex Porter)" settings card at the top
  (view + edit all 4 numbers)
- Change Order modal → "Land Clearing Price Helper" — enter/auto-prefill acreage (from Smart
  Data), click "Get Estimate," click "Use $X" to drop the suggested price into the Custom /
  Off-Catalog change order fields. Both quantity and rate remain fully editable after — this is
  a suggestion, not a lock.
- `flooring_epoxy` and `land_clearing` both added to `TRADE_LABELS` for display purposes
  ("Epoxy Flooring", "Land Clearing").

This is a deliberate exception to the general "Brothers Group has no pricing authority over
vendor items" rule — Land Clearing has a known, real vendor formula from Alex directly, so it
gets full auto-suggest treatment where every other vendor trade stays quote-request-only.

## Part 10 — Smart Data (property characteristics, built v20.33.0)

Purpose: capture heated/cooled sqft, lot size, and other property characteristics once per
address, then reuse them anywhere in Lead Depot that needs them (Land Clearing acreage,
inspection order sqft-tiered pricing, future repair-scope math for garage/patio/other areas).

**Data-sourcing priority (per Alex, in order):**
1. **County records** — auto-populate as much as possible. Important architectural note: Lead
   Depot (the live Railway app) has **no in-app browser-automation capability** to run a live
   county property-appraiser lookup itself. "Auto-populate" means data gathered separately (via
   the `property-appraiser-lookup` skill in a Perplexity session, using Comet + `pc` +
   AppleScript) gets **pushed into** Lead Depot's database via `POST /api/smart-data` with
   `source: "county_record"` — not scraped live from inside the app.
2. **Sales package cross-check** — the sales package already prints the county record for
   client review, so it's used as a corroborating/fallback source (`source: "sales_package"`).
3. **Manual fallback** — if neither source has answers, the agent enters the two minimum
   required fields directly in the Smart Data panel: **heated/cooled sqft + lot size**
   (acreage preferred over raw sqft). `source: "manual"`.

**Minimum required fields:** heated sqft + lot size (acres or sqft). Everything else (cooled
sqft, effective sqft, stories, bedrooms, bathrooms, year built) is optional but valuable —
effective sqft in particular helps estimate scope on ancillary areas (garage, patios, etc.) for
painting/flooring line items.

**Schema (`property_smart_data`, unique by `property_address`):** `lot_size_acres`,
`lot_size_sqft`, `heated_sqft`, `cooled_sqft`, `effective_sqft`, `stories`, `bedrooms`,
`bathrooms`, `year_built`, `source` (`county_record` | `sales_package` | `manual`),
`source_url`, `verified_by`, `verified_at`.

**Endpoints:**
- `GET /api/smart-data?propertyAddress=X` — read (never 404s; returns an empty/`found:false`
  shape plus `hasMinimumRequired: false` if nothing is on file yet)
- `POST /api/smart-data` — upsert by address. Non-null incoming fields overwrite; null/omitted
  fields preserve the existing value (`COALESCE` merge) so a later manual top-up doesn't wipe
  earlier county-record data.

**UI:**
- New reusable `SmartDataPanel` component (`client/src/components/ld/SmartDataPanel.tsx`) —
  shows a source badge (County Record / Sales Package / Manual Entry), a 6-field read view, a
  missing-minimum-data warning banner, and an edit mode for the 4 most relevant fields. Wired
  into `RepairConsultSheet.tsx` right under the Property Address field in the intake step.
- `InspectionsPlusSheet.tsx` — added a compact "From Smart Data" button next to the existing
  Subject Property Sqft field; pulls `heatedSqft` for the entered address and reports which
  source it came from (or that none is on file yet).
- Land Clearing's acreage estimate (Part 9) auto-pulls `lotSizeAcres`/`lotSizeSqft` from Smart
  Data for the consult's property address when available.

## Epoxy Flooring (catalog addition, built v20.33.0)

Added `flooring_epoxy` (`v_floor_epoxy`) as a new vendor-category flooring installation option
alongside the existing LVP/carpet/wood-refinish options, per Alex's request. Follows the
standard vendor-item pattern — no in-house pricing authority, quote-request email dispatch on
selection, `TRADE_LABELS` entry "Epoxy Flooring."
