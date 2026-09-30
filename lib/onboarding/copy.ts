import { ONBOARDING_STEPS, TOUR_STEPS } from "@/lib/behavioral/events";

/**
 * THE ONBOARDING'S WORDS (Phase 32, reshaped in Phase 32b), all of them, in
 * one file so one test can hold them to the rules: paper trading said
 * plainly, the score and the price told apart, trading never pushed, no
 * countdown, no "act now", no manufactured scarcity. The components carry
 * no sentence of their own.
 *
 * Three screens, in order: the WELCOME (the paper balance and what paper
 * means; seen once, before anything else), the TOUR (eight stops on one
 * real person's page, each a caption beside one element), and the FOLLOW
 * picker, exactly as it was. Each screen says where it is ("1 of 3") in
 * words, never with a bar that fills (a bar that fills is a small urgency
 * of its own).
 */

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type TourStep = (typeof TOUR_STEPS)[number];
export { ONBOARDING_STEPS, TOUR_STEPS };

export const ONBOARDING = {
  progress: "{n} of {total}",
  skip: "Skip for now",
  next: "Next",
  back: "Back",
  paper: {
    title: "Your paper balance",
    balance: "You start with {balance} in paper credit.",
    lines: [
      "It is not real money. It cannot be deposited, withdrawn or exchanged for anything.",
      "You cannot lose more than you put in. There is no borrowing and no selling what you do not hold, so the most a position can lose is what it cost.",
      "Everything here is for learning how momentum moves, not for making money.",
    ],
    /** What Next leads to: the tour. Said in words so nobody lands on a stranger's page unwarned. */
    next: "Next: a short tour of one person's page, on the real thing.",
  },
  follow: {
    title: "Pick a few people to follow",
    body: "Following gives you a Following filter on Home, so the people you care about are one tap away. You can change it any time from your profile.",
    none: "Nobody picked yet. That is fine too.",
    picked: "{count} picked",
    save: "Save and continue",
    /** The same picker, opened from the profile to change who you follow. */
    profileTitle: "People you follow",
    profileBody: "Following gives you a Following filter on Home. Tick or untick anyone, then save.",
    profileSave: "Save",
    cancel: "Cancel",
  },
} as const;

/**
 * THE TOUR (Phase 32b). One element at a time on a real, tradeable person's
 * page, spotlit, with a short caption. Nothing in it acts: tapping the lit
 * element moves to the next stop, and no trade, vote or navigation happens
 * until the tour is over. "Skip tour" is on every stop.
 */
export interface TourStop {
  key: TourStep;
  /** The element's `data-tour` attribute. lib/onboarding/copy.test.ts fails if no component carries it. */
  anchor: string;
  title: string;
  body: string;
  /** Where the caption sits on a phone: the bottom panel, or the top when the element itself is fixed at the bottom. */
  panel: "bottom" | "top";
}

export const TOUR = {
  progress: "{n} of {total}",
  skip: "Skip tour",
  back: "Back",
  next: "Next",
  done: "Finish tour",
  /** The lit element is a button that goes to the next stop; this names it for a screen reader. */
  tapToContinue: "{title}: tap to continue the tour",
  stops: [
    {
      key: "score",
      anchor: "score",
      title: "Momentum Score",
      body: "Where a person is heading, read from the world outside this platform: news, streams, releases and games. It is worked out the same way for everyone, and nothing anyone does here can move it.",
      panel: "bottom",
    },
    {
      key: "market",
      anchor: "market",
      title: "Market price",
      body: "The price you trade at. It starts at the score, moves when people buy and sell, and drifts back toward the score over time.",
      panel: "bottom",
    },
    {
      key: "signals",
      anchor: "signals",
      title: "Why it moved",
      body: "What the world said and did, newest first: the stories, streams and numbers the Engine read to move the score. Open one to see what it saw.",
      panel: "bottom",
    },
    {
      key: "forces",
      anchor: "forces",
      title: "The forces",
      body: "Moving the score: what each force added over the last hour. Moving the market: what trading did to the price. Trading never touches the score.",
      panel: "bottom",
    },
    {
      key: "forecast",
      anchor: "forecast",
      title: "Forecast",
      body: "Say whether you think this person's momentum is rising or falling, and why. It is free, it moves nothing, and you can change it later. Make one once the tour ends, if you like.",
      panel: "bottom",
    },
    {
      key: "buy",
      anchor: "buy",
      title: "Buy",
      body: "Trading is optional. Nothing here asks you to. When you want to, Buy opens an order in paper money; the tour places nothing.",
      panel: "top",
    },
    {
      key: "portfolio",
      anchor: "nav-portfolio",
      title: "Portfolio",
      body: "What you hold, how it is doing, and every trade you have made.",
      panel: "top",
    },
    {
      key: "feed",
      anchor: "nav-feed",
      title: "Feed",
      body: "The Engine, narrating every move across the board as it lands.",
      panel: "top",
    },
  ] as const satisfies readonly TourStop[],
} as const;

export function stepNumber(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step) + 1;
}

export function stepFromParam(value: string | string[] | undefined): OnboardingStep {
  const raw = Array.isArray(value) ? value[0] : value;
  return (ONBOARDING_STEPS as readonly string[]).includes(raw ?? "") ? (raw as OnboardingStep) : "paper";
}

export function nextStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  return index >= 0 && index < ONBOARDING_STEPS.length - 1 ? ONBOARDING_STEPS[index + 1] : null;
}

export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  return index > 0 ? ONBOARDING_STEPS[index - 1] : null;
}

export function progressLabel(step: OnboardingStep): string {
  return ONBOARDING.progress.replace("{n}", String(stepNumber(step))).replace("{total}", String(ONBOARDING_STEPS.length));
}

/** "3 of 8", for the tour's stop at `index` (zero-based). */
export function tourProgressLabel(index: number): string {
  return TOUR.progress.replace("{n}", String(index + 1)).replace("{total}", String(TOUR.stops.length));
}

/** Every string above, for the rules test. */
export function allOnboardingStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(ONBOARDING);
  walk(TOUR);
  return out;
}
