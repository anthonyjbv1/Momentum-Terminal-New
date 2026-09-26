import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";

import { FollowPicker } from "@/components/onboarding/follow-picker";
import { ForecastStep } from "@/components/onboarding/forecast-step";
import { PaperStep, StepFrame, WhatStep } from "@/components/onboarding/steps";
import { QuietLayout } from "@/components/shell/quiet-layout";
import { getCurrentProfile } from "@/lib/auth";
import { logEventInBackground } from "@/lib/behavioral/log";
import { isBetaSignupEnabled } from "@/lib/env";
import { ONBOARDING, stepFromParam } from "@/lib/onboarding/copy";
import { forecastChoices } from "@/lib/onboarding/model";
import { getFollowRoster, getMyFollowIds } from "@/lib/onboarding/server";

export const metadata: Metadata = { title: "Welcome", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * /start: the onboarding screens (Phase 32). A new account lands here from
 * its first sign-in link; anyone signed in can come back. Behind
 * BETA_SIGNUP_ENABLED like everything else in this phase: while it is off the
 * page does not exist. The same follow picker serves the profile's "change
 * who you follow" at /start?step=follow&return=profile, without the
 * onboarding frame and without an onboarding event.
 */
export default async function StartPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isBetaSignupEnabled()) notFound();
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login?next=/start");

  const params = await searchParams;
  const step = stepFromParam(params.step);
  const fromProfile = step === "follow" && params.return === "profile";

  if (!fromProfile) logEventInBackground({ eventType: "onboarding_step", metadata: { step, action: "view" } });

  let body: ReactNode;
  if (step === "what") {
    body = <WhatStep />;
  } else if (step === "paper") {
    const balance = Number(profile.wallet_balance_cents);
    body = <PaperStep balanceCents={Number.isSafeInteger(balance) ? balance : 0} />;
  } else if (step === "follow") {
    const [roster, following] = await Promise.all([getFollowRoster(), getMyFollowIds()]);
    const copy = ONBOARDING.follow;
    body = fromProfile ? (
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
  } else {
    const [roster, following] = await Promise.all([getFollowRoster(), getMyFollowIds()]);
    body = (
      <StepFrame step="forecast" title={ONBOARDING.forecast.title}>
        <ForecastStep people={forecastChoices(roster, following)} />
      </StepFrame>
    );
  }

  return <QuietLayout width="lg">{body}</QuietLayout>;
}
