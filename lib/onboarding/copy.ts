import { ONBOARDING_STEPS } from "@/lib/behavioral/events";

/**
 * THE ONBOARDING SCREENS' WORDS (Phase 32), all of them, in one file so one
 * test can hold them to the rules: paper trading said plainly, the score and
 * the price told apart, trading never pushed, no countdown, no "act now", no
 * manufactured scarcity. The components carry no sentence of their own.
 *
 * Four screens, each skippable, each saying how many there are without a
 * progress bar that fills (a bar that fills is a small urgency of its own).
 */

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export { ONBOARDING_STEPS };

export const ONBOARDING = {
  progress: "{n} of {total}",
  skip: "Skip for now",
  next: "Next",
  back: "Back",
  what: {
    title: "Two numbers for every person",
    score: {
      label: "Momentum Score",
      body: "Measures where a person is heading, read from the world outside this platform: news, streams, releases and games. It is worked out the same way for everyone, and nothing anyone does here can move it.",
    },
    price: {
      label: "Market price",
      body: "What you trade. It starts at the score, moves when people buy and sell, and drifts back toward the score over time.",
    },
    more: "How the price works",
  },
  paper: {
    title: "Your paper balance",
    balance: "You start with {balance} in paper credit.",
    lines: [
      "It is not real money. It cannot be deposited, withdrawn or exchanged for anything.",
      "You cannot lose more than you put in. There is no borrowing and no selling what you do not hold, so the most a position can lose is what it cost.",
      "Everything here is for learning how momentum moves, not for making money.",
    ],
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
  forecast: {
    title: "Make a free forecast",
    body: "A forecast says whether you think a person's momentum is rising or falling, and why. It is free, it moves nothing, and you can change it later.",
    person: "Who",
    direction: "Momentum is",
    reason: "Mainly because of",
    save: "Save forecast and finish",
    finish: "Finish without a forecast",
    trading: "Trading is optional. When you want to, open anyone's profile and use Buy or Sell. Nothing here asks you to.",
    saved: "Forecast saved.",
  },
} as const;

export function stepNumber(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step) + 1;
}

export function stepFromParam(value: string | string[] | undefined): OnboardingStep {
  const raw = Array.isArray(value) ? value[0] : value;
  return (ONBOARDING_STEPS as readonly string[]).includes(raw ?? "") ? (raw as OnboardingStep) : "what";
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

/** Every string above, for the rules test. */
export function allOnboardingStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(ONBOARDING);
  return out;
}
