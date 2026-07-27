// Alex's expired listing script — canonical version.
// This is the FILE-LEVEL DEFAULT. It only gets written to the DB on first boot
// (INSERT ... ON CONFLICT DO NOTHING in server/db.ts). Any admin edits via the
// Script Editor stay in the DB and survive every future deploy.
//
// If you want to change the file-level default, edit this file — but note that
// existing production DB rows are NEVER overwritten by the seed. To make a file
// change take effect on production, either (a) accept that new installs pick it
// up, or (b) manually PATCH /api/scripts/expired after deploy.
//
// Restored 2026-07-27 from Alex's own hand-written source.
export const EXPIRED_SCRIPT_V14_16: string = `"Hey [First Name] — it's [Agent First Name]. I'm calling about the property at [Street number and name only] It looks like it was for sale at one point but not anymore. What happened there?

SELLER: Who is this? DOUBLE DOWN ^ This is Agent Name from The Brothers Group Real Estate Team at Momentum Realty.
  1. We know about all the listings that are for sale but my buyers haven't seen this one.  

  2. Are you still open to possibly selling in the future? Other listings typically fail because of how it was priced and marketed.  

  3. If they had sold, what was the plan? Staying in town or leaving? BUY/SELL/BOTH?  SELECT ALL INTENTIONS.

  4. What is your timeline? Are there any deadlines we need to know about?

  5. Is there a mortgage or owned outright? What's the payoff?

  6. GO FOR THE APPOINTMENT!  When would be a good time for us to stop inIt's a no-obligation 5-minute walk-through. I'll show you  what we'd do differently and what the numbers actually look like right now. If it makes sense, we move. If not, at least you know where you stand.

  7. NO APPOINTMENT? GET EMAIL TO KEEP IN TOUCH! Do you have an agent keeping you informed on the pulse of the market? We aren't pushy, only calls just like this one. Could we keep in touch? What's your email?

─────────────────────────────────────────────────
WHY US (only if they ask — never volunteered)

  "26+ years of combined real estate experience. Top 1% of
   teams in NE Florida. RealProducers Top 500. Jacksonville
   Business Journal ranked team. Hundreds of five-star
   reviews. We also bring construction and roofing expertise
   from years in the industry — so when we walk your house
   we can tell you what actually matters before it lists,
   what doesn't, and what buyers and inspectors will flag."

ABOUT US!
1. Just mentioned in the Jacksonville Biz Journal as a top team in NE Florida.
2. We are HYPER LOCAL!
3. 100's of 5 star reviews. Proven track record.
4. We spend 3x on marketing compared to most agents.`;
