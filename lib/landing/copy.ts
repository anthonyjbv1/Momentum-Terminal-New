/**
 * EVERY WORD ON THE LANDING PAGE, THE WAITLIST AND THE PRIVACY PAGE.
 *
 * One file, so the whole of what a stranger reads can be reviewed in one
 * sitting and sent to counsel as one document. Components import from here
 * and never carry a sentence of their own; lib/landing/copy.test.ts holds
 * every string in this file to the rules below.
 *
 * THE RULES (Phase 28, hard):
 *   1. Only the founder is named. No other tracked person's name appears
 *      anywhere the public can see — this file, the OG image, the metadata.
 *   2. The beta is PAPER TRADING with paper credits. Said plainly.
 *   3. Never: invest, investment, bet, gamble, wager, earn, profit, returns,
 *      income, "get paid". Never a promise or a hint that real-money trading
 *      is coming.
 *   4. No manufactured urgency. Every number on the page is real and live.
 *   5. The product measures momentum and trajectory. Never a person's worth.
 *   6. Terminology: Momentum Score, the Engine, Feed, shares. Never "Oracle";
 *      no Black Mirror, no "Nosedive".
 *
 * Pronouns: the founder is referred to by name or as "the founder", never
 * by a pronoun.
 */

// ---------------------------------------------------------------------------
// The featured subject
// ---------------------------------------------------------------------------

export const FEATURED = {
  /** people.slug. The ONE person the public endpoint will ever describe. */
  slug: "anthony-baptiste",
  name: "Anthony Baptiste",
  firstName: "Anthony",
  role: "Founder, Momentum Terminal",
  /** Above the score. */
  eyebrow: "The founder’s own Momentum Score",
  /** Beneath the name. */
  consent: "Shown with the founder’s consent, exactly as the platform computes it.",
} as const;

// ---------------------------------------------------------------------------
// The headline: three candidates, one chosen
// ---------------------------------------------------------------------------

export const HEADLINES = {
  chosen: "Momentum, measured live.",
  alternatives: [
    "Every 30 seconds, the world moves. This is one person’s share of it.",
    "The press picks who to write about. The Engine measures everyone the same way.",
  ],
} as const;

// ---------------------------------------------------------------------------
// The hero
// ---------------------------------------------------------------------------

export const HERO = {
  eyebrow: "Closed beta",
  headline: HEADLINES.chosen,
  sub: "One score per person for how the world is moving around them, recomputed by the Engine every 30 seconds. The number below is the founder’s — the same score the platform keeps on everyone it tracks.",
  scoreLabel: "Momentum Score",
  /** The heartbeat, when the last tick is recent and the feed is answering. */
  live: "Live",
  nextTick: "next tick",
  /** The heartbeat, when the value shown is the last one received. */
  lastKnown: "Last known",
  asOf: "as of",
  /** Change chips under the score. */
  change: { h1: "past hour", h24: "past 24 hours", d7: "past 7 days" } as const,
  /** When there is no score at all to show. Never a made-up number. */
  unavailable: "The score is unreachable right now.",
  unavailableDetail: "Nothing here is ever estimated. When the Engine answers again, the number appears.",
  paper: "The beta is paper trading. Every position is in paper credits — not real money.",
} as const;

// ---------------------------------------------------------------------------
// How it works: three beats
// ---------------------------------------------------------------------------

export const HOW = {
  title: "How it works",
  beats: [
    {
      number: "01",
      title: "Signals from the world",
      body: "News, uploads, streams, filings and games about a person, read as they happen.",
    },
    {
      number: "02",
      title: "The Engine computes a Momentum Score",
      body: "Three forces, one number, every 30 seconds — what just happened, the tide across the entire platform, and the pull towards a person’s baseline. It measures trajectory, never the person.",
    },
    {
      number: "03",
      title: "You take a view",
      body: "Rising or Falling, in shares, with paper credits. Call it right and the position rises; call it wrong and it falls. Paper trading only: no real money, ever.",
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Why it moved
// ---------------------------------------------------------------------------

export const WHY = {
  title: "Why it moved",
  sub: "The last hour, force by force — the same reading a profile shows inside the app.",
  forcesLabel: "The three forces that move the score",
  /** One line per force that moves the score, in the founder's terms. The market forces are not on this page. */
  forces: {
    gravity: "The pull towards Anthony’s baseline",
    signals: "What the world said about Anthony",
    market_mood: "The tide across the entire platform",
  } as const,
  idle: "The Engine has not ticked this score yet.",
  signalsLabel: "Recent signals",
  /** True today, and the case this page exists to show. */
  noSignals:
    "No signal about Anthony has reached the Engine yet — not one headline, upload or filing. The score above is still real: the sources are watching, and the first one that lands will appear here in plain language, the way it does on every profile.",
  historyLabel: "The last 24 hours",
} as const;

// ---------------------------------------------------------------------------
// The waitlist
// ---------------------------------------------------------------------------

export const WAITLIST = {
  title: "Want a seat when the beta opens?",
  body: "Leave an email. It is the only thing this page asks for.",
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  button: "Join the waitlist",
  buttonBusy: "Joining…",
  /** Below the field. */
  consent: "By joining you agree to be emailed about the beta, and nothing else.",
  privacyLink: "Privacy",
  /** The honeypot. Never seen by a person; a bot that fills it is dropped. */
  honeypotLabel: "Leave this field empty",
  success: {
    title: "You’re on the list.",
    /** {position} is the real row number. */
    withPosition: "You are number {position} on the waitlist. When a place opens, the invite comes by email.",
    withoutPosition: "When a place opens, the invite comes by email.",
  },
  errors: {
    invalid: "That doesn’t look like an email address.",
    rateLimited: "Too many attempts from this connection. Try again in a few minutes.",
    unavailable: "The waitlist is unreachable right now. Nothing was saved — please try again shortly.",
  },
} as const;

// ---------------------------------------------------------------------------
// Header, footer, metadata
// ---------------------------------------------------------------------------

export const CHROME = {
  signIn: "Sign in",
  footer: {
    paper: "Paper trading with paper credits. Not real money.",
    privacy: "Privacy",
    signIn: "Sign in",
  },
} as const;

export const META = {
  title: "Momentum Terminal — Momentum, measured live",
  description:
    "A live Momentum Score for how the world is moving around a person, recomputed by the Engine every 30 seconds. The founder’s own score, and a waitlist for the paper-trading beta.",
  ogAlt: "The founder’s live Momentum Score on Momentum Terminal",
} as const;

/** What the OG image says, beside the score. */
export const OG = {
  brand: "Momentum Terminal",
  scoreLabel: "Momentum Score",
  live: "live · every 30 seconds",
  asOf: "as of",
} as const;

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  PLACEHOLDER — SWAP THIS BEFORE ANY STRANGER SEES THE PAGE.          ║
 * ║                                                                      ║
 * ║  Where a person writes to have their address removed, shown on       ║
 * ║  /privacy as a mailto link. The operator chose (2026-09-23) to ship  ║
 * ║  a clearly flagged placeholder rather than an address; `.example`   ║
 * ║  is a reserved domain and can receive nothing. To go live: put the  ║
 * ║  real address here and set PRIVACY_CONTACT_IS_PLACEHOLDER to false. ║
 * ║  lib/landing/copy.test.ts holds the two in step.                     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */
export const PRIVACY_CONTACT_EMAIL = "privacy@placeholder.example";
export const PRIVACY_CONTACT_IS_PLACEHOLDER = true;

export const PRIVACY = {
  title: "Privacy",
  intro: "This page covers the landing page and the waitlist. The app itself is in closed beta and has its own terms.",
  sections: [
    {
      title: "What is collected",
      body: [
        "When you join the waitlist: your email address, the time you joined, which form you used, any campaign parameters in the link you arrived by (utm_source and the like), and the page that referred you, if your browser sent one.",
        "When you visit the landing page: an anonymous page-view event with a random session id that is not tied to you, the referring site, and the campaign parameters above. No name, no account, no third-party trackers, no analytics scripts.",
      ],
    },
    {
      title: "Why",
      body: [
        "To invite you to the beta by email. That is the only use. Your address is not sold, rented or shared, and the platform sends nothing else to it in this phase.",
      ],
    },
    {
      title: "How long",
      body: ["Until the beta invites are done, or until you ask for it to go — whichever comes first."],
    },
    {
      title: "Deletion",
      /** {contact} is PRIVACY_CONTACT_EMAIL. */
      body: ["Email {contact} from the address you signed up with, and the row is deleted. Nothing else is needed."],
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Everything above, flattened: what the copy test walks
// ---------------------------------------------------------------------------

/** Every string in this file, for the rules test and the report. */
export function allCopyStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk({ FEATURED, HEADLINES, HERO, HOW, WHY, WAITLIST, CHROME, META, OG, PRIVACY });
  return out;
}
