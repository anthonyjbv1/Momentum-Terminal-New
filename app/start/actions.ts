"use server";

import { redirect } from "next/navigation";

import { logEventInBackground } from "@/lib/behavioral/log";
import { isBetaSignupEnabled } from "@/lib/env";
import { nextStep, stepFromParam, type OnboardingStep } from "@/lib/onboarding/copy";
import { markOnboarded, setMyFollows } from "@/lib/onboarding/server";

/**
 * The onboarding screens' actions (Phase 32, Phase 32b). Each one records
 * what the person did as an onboarding_step event and moves on. Skipping
 * from any screen marks onboarding done and goes Home; nothing asks twice.
 * The tour's own events are logged from the browser, stop by stop.
 */

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function guard(): void {
  if (!isBetaSignupEnabled()) redirect("/");
}

/** Next on the welcome: on to the tour. */
export async function nextAction(form: FormData): Promise<void> {
  guard();
  const step = stepFromParam(text(form, "step"));
  logEventInBackground({ eventType: "onboarding_step", metadata: { step, action: "next" } });
  const next = nextStep(step);
  redirect(next ? `/start?step=${next}` : "/");
}

export async function skipAction(form: FormData): Promise<void> {
  guard();
  const step: OnboardingStep = stepFromParam(text(form, "step"));
  logEventInBackground({ eventType: "onboarding_step", metadata: { step, action: "skip" } });
  await markOnboarded();
  redirect("/");
}

/**
 * The follow screen, last: replace the set with what is ticked, one event
 * per change, then Home with onboarding marked done. From the profile it is
 * only the set, and back to the profile.
 */
export async function followAction(form: FormData): Promise<void> {
  guard();
  const ids = form.getAll("person").filter((value): value is string => typeof value === "string");
  const { added, removed } = await setMyFollows(ids);
  for (const personId of added) logEventInBackground({ eventType: "follow_person", personId, metadata: { surface: "onboarding" } });
  for (const personId of removed) logEventInBackground({ eventType: "unfollow_person", personId, metadata: { surface: "onboarding" } });
  const back = text(form, "return");
  if (back === "profile") redirect("/profile");
  logEventInBackground({ eventType: "onboarding_step", metadata: { step: "follow", action: "finish", followed: ids.length } });
  await markOnboarded();
  redirect("/");
}
