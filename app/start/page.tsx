import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { OnboardingScreen } from "@/components/onboarding/onboarding-screen";
import { QuietLayout } from "@/components/shell/quiet-layout";
import { getCurrentProfile } from "@/lib/auth";
import { logEventInBackground } from "@/lib/behavioral/log";
import { isBetaSignupEnabled } from "@/lib/env";
import { stepFromParam } from "@/lib/onboarding/copy";
import { getFollowRoster, getMyFollowIds } from "@/lib/onboarding/server";

/** The title follows the switch: while it is off, the 404 says nothing about what would have been here. */
export function generateMetadata(): Metadata {
  const base: Metadata = { robots: { index: false, follow: false } };
  return isBetaSignupEnabled() ? { ...base, title: "Welcome" } : base;
}
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

  const needsRoster = step === "follow" || step === "forecast";
  const [roster, following] = needsRoster ? await Promise.all([getFollowRoster(), getMyFollowIds()]) : [[], [] as string[]];
  const balance = Number(profile.wallet_balance_cents);

  return (
    <QuietLayout width="lg">
      <OnboardingScreen step={step} fromProfile={fromProfile} balanceCents={Number.isSafeInteger(balance) ? balance : 0} roster={roster} following={following} />
    </QuietLayout>
  );
}
