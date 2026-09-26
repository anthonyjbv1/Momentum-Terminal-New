import { ONBOARDING, type OnboardingStep } from "@/lib/onboarding/copy";
import { forecastChoices, type RosterEntry } from "@/lib/onboarding/model";

import { FollowPicker } from "./follow-picker";
import { ForecastStep } from "./forecast-step";
import { PaperStep, StepFrame, WhatStep } from "./steps";

/**
 * One onboarding screen, from what the page read (Phase 32). The page loads
 * the data and decides which screen; this decides what it looks like, so the
 * page and anything that renders a screen from fixtures draw the same thing.
 */
export function OnboardingScreen({
  step,
  fromProfile,
  balanceCents,
  roster,
  following,
}: {
  step: OnboardingStep;
  fromProfile: boolean;
  balanceCents: number;
  roster: RosterEntry[];
  following: string[];
}) {
  if (step === "what") return <WhatStep />;
  if (step === "paper") return <PaperStep balanceCents={balanceCents} />;
  if (step === "follow") {
    const copy = ONBOARDING.follow;
    return fromProfile ? (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-3 px-1">
          <h1 className="text-4xl font-bold tracking-tighter text-fg">{copy.profileTitle}</h1>
          <p className="text-base text-fg-secondary">{copy.profileBody}</p>
        </div>
        <FollowPicker roster={roster} following={following} mode="profile" />
      </div>
    ) : (
      <StepFrame step="follow" title={copy.title}>
        <p className="-mt-4 px-1 text-base text-fg-secondary">{copy.body}</p>
        <FollowPicker roster={roster} following={following} mode="onboarding" />
      </StepFrame>
    );
  }
  return (
    <StepFrame step="forecast" title={ONBOARDING.forecast.title}>
      <ForecastStep people={forecastChoices(roster, following)} />
    </StepFrame>
  );
}
