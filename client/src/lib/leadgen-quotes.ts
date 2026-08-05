// v20.6.9 — Lead Gen motivational quotes.
//
// Shown briefly when Alex/an agent taps the Lead Gen button and the screen
// goes dark before the dial arc is engaged. Powerful, not theatrical:
// editorial serif type, quiet fade-in ~200ms after the backdrop takes over,
// sits still, fades out when the user commits to a lead-gen leg.
//
// Curation rules:
//   • Biblical + stoic + sales/discipline legends
//   • Under ~140 characters ideal (one screen line on iPhone)
//   • No em dashes in the quote body (attribution uses em dash)
//   • No corporate-slop phrasing ("crush it", "smash it", "let's go")
//   • Truth-oriented, not hype
//
// Do NOT localize. Alex reads these; they're English + KJV in feel.

export type MotivationalQuote = {
  text: string;
  author: string;
};

export const LEADGEN_QUOTES: MotivationalQuote[] = [
  // ─── Biblical ─────────────────────────────────────────────────────────
  { text: "Whatever your hand finds to do, do it with your might.", author: "Ecclesiastes 9:10" },
  { text: "The diligent hand shall bear rule; the slothful shall be under tribute.", author: "Proverbs 12:24" },
  { text: "The soul of the sluggard desireth, and hath nothing; but the soul of the diligent shall be made fat.", author: "Proverbs 13:4" },
  { text: "In all labour there is profit; but the talk of the lips tendeth only to penury.", author: "Proverbs 14:23" },
  { text: "Seest thou a man diligent in his business? he shall stand before kings.", author: "Proverbs 22:29" },
  { text: "The plans of the diligent lead surely to abundance, but everyone who is hasty comes only to poverty.", author: "Proverbs 21:5" },
  { text: "Let us not be weary in well doing: for in due season we shall reap, if we faint not.", author: "Galatians 6:9" },
  { text: "For God hath not given us the spirit of fear; but of power, and of love, and of a sound mind.", author: "2 Timothy 1:7" },
  { text: "I can do all things through Christ which strengtheneth me.", author: "Philippians 4:13" },
  { text: "Be strong and of a good courage; be not afraid, neither be thou dismayed.", author: "Joshua 1:9" },
  { text: "Commit thy works unto the Lord, and thy thoughts shall be established.", author: "Proverbs 16:3" },
  { text: "The race is not to the swift, nor the battle to the strong, but time and chance happeneth to them all.", author: "Ecclesiastes 9:11" },
  { text: "Whatsoever ye do, do it heartily, as to the Lord, and not unto men.", author: "Colossians 3:23" },
  { text: "Thou shalt remember the Lord thy God: for it is he that giveth thee power to get wealth.", author: "Deuteronomy 8:18" },

  // ─── Stoic / classical ────────────────────────────────────────────────
  { text: "You have power over your mind, not outside events. Realize this, and you will find strength.", author: "Marcus Aurelius" },
  { text: "Waste no more time arguing what a good man should be. Be one.", author: "Marcus Aurelius" },
  { text: "The impediment to action advances action. What stands in the way becomes the way.", author: "Marcus Aurelius" },
  { text: "First say to yourself what you would be; and then do what you have to do.", author: "Epictetus" },
  { text: "No man is free who is not master of himself.", author: "Epictetus" },
  { text: "Difficulties strengthen the mind, as labor does the body.", author: "Seneca" },
  { text: "It is not that we have a short time to live, but that we waste a lot of it.", author: "Seneca" },
  { text: "Luck is what happens when preparation meets opportunity.", author: "Seneca" },

  // ─── Sales / discipline legends ───────────────────────────────────────
  { text: "Success is neither magical nor mysterious. Success is the natural consequence of consistently applying basic fundamentals.", author: "Jim Rohn" },
  { text: "You cannot escape the responsibility of tomorrow by evading it today.", author: "Abraham Lincoln" },
  { text: "Discipline equals freedom.", author: "Jocko Willink" },
  { text: "Get after it.", author: "Jocko Willink" },
  { text: "The most important thing about goals is having one.", author: "Geoffrey F. Abert" },
  { text: "Your big opportunity may be right where you are now.", author: "Napoleon Hill" },
  { text: "Do not wish it were easier; wish you were better.", author: "Jim Rohn" },
  { text: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
  { text: "You will never change your life until you change something you do daily.", author: "John C. Maxwell" },
  { text: "Sell or be sold.", author: "Grant Cardone" },
  { text: "Average is a failing formula.", author: "Grant Cardone" },
  { text: "The rest of the world will believe in you when you believe in yourself.", author: "Grant Cardone" },
  { text: "Great things are done by a series of small things brought together.", author: "Vincent van Gogh" },
  { text: "Everything you have ever wanted is on the other side of fear.", author: "George Addair" },
  { text: "The only place where success comes before work is in the dictionary.", author: "Vidal Sassoon" },
  { text: "Hard work beats talent when talent doesn't work hard.", author: "Tim Notke" },
  { text: "You miss 100% of the shots you don't take.", author: "Wayne Gretzky" },
  { text: "Rest at the end, not in the middle.", author: "Kobe Bryant" },
  { text: "The most important thing is to try and inspire people so that they can be great in whatever they want to do.", author: "Kobe Bryant" },
  { text: "Great moments are born from great opportunity.", author: "Herb Brooks" },
];

/**
 * Picks a quote at random, avoiding the last shown key stored in localStorage
 * so back-to-back Lead Gen taps don't repeat the same quote.
 */
export function pickLeadGenQuote(): MotivationalQuote {
  if (LEADGEN_QUOTES.length === 0) {
    return { text: "Do the next right thing.", author: "" };
  }
  let lastKey = "";
  try {
    lastKey = localStorage.getItem("ld:leadgen:lastquote") || "";
  } catch { /* SSR / private mode */ }

  const pool = LEADGEN_QUOTES.filter((q) => `${q.author}|${q.text}` !== lastKey);
  const source = pool.length > 0 ? pool : LEADGEN_QUOTES;
  const pick = source[Math.floor(Math.random() * source.length)];

  try {
    localStorage.setItem("ld:leadgen:lastquote", `${pick.author}|${pick.text}`);
  } catch { /* SSR / private mode */ }

  return pick;
}
