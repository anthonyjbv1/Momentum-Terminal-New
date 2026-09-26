"use server";

import { redirect } from "next/navigation";

import { logEventInBackground } from "@/lib/behavioral/log";
import { isBetaSignupEnabled } from "@/lib/env";
import { isForecastDirection, isForecastReason } from "@/lib/forecast/model";
import { castForecastVoteAsUser } from "@/lib/forecast/server";
import { nextStep, stepFromParam, type OnboardingStep } from "@/lib/onboarding/copy";
import { markOnboarded, setMyFollows } from "@/lib/onboarding/server";

/**
 * The onboarding screens' actions (Phase 32). Each one records what the
 * person did as an onboarding_step event and moves on. Skipping from any
 * screen marks onboarding done and goes Home; nothing asks twice.
 */

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function guard(): void {
  if (!isBetaSignupEnabled()) redirect("/");
}

/** Next on a screen that asks nothing (the first two). */
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

/** The last screen's quiet way out: done, with no forecast made. Recorded as a finish, not a skip. */
export async function finishAction(): Promise<void> {
  guard();
  logEventInBackground({ eventType: "onboarding_step", metadata: { step: "forecast", action: "finish" } });
  await markOnboarded();
  redirect("/");
}

/** The follow screen: replace the set with what is ticked, one event per change. */
export async function followAction(form: FormData): Promise<void> {
  guard();
  const ids = form.getAll("person").filter((value): value is string => typeof value === "string");
  const { added, removed } = await setMyFollows(ids);
  for (const personId of added) logEventInBackground({ eventType: "follow_person", personId, metadata: { surface: "onboarding" } });
  for (const personId of removed) logEventInBackground({ eventType: "unfollow_person", personId, metadata: { surface: "onboarding" } });
  const back = text(form, "return");
  if (back === "profile") redirect("/profile");
  logEventInBackground({ eventType: "onboarding_step", metadata: { step: "follow", action: "next", followed: ids.length } });
  redirect("/start?step=forecast");
}

export type ForecastStepState = {
  error?: string;
  /** What was chosen, so a refusal comes back with the choices still made. */
  values?: { person: string; direction: string; reason: string };
  /** Bumped on every refusal so the form remounts with those choices. */
  attempt?: number;
};

/** The last screen: a free forecast, then Home. A refusal comes back in plain words. */
export async function forecastAction(prev: ForecastStepState, form: FormData): Promise<ForecastStepState> {
  guard();
  const personId = text(form, "person");
  const direction = text(form, "direction");
  const reason = text(form, "reason");
  const refuse = (error: string): ForecastStepState => ({ error, values: { person: personId, direction, reason }, attempt: (prev.attempt ?? 0) + 1 });
  if (!personId) return refuse("Pick a person to forecast.");
  if (!isForecastDirection(direction)) return refuse("Choose Rising or Falling.");
  if (!isForecastReason(reason)) return refuse("Choose a reason.");
  const result = await castForecastVoteAsUser({ personId, direction, reason });
  if (!result.ok) return refuse(result.message);
  logEventInBackground({ eventType: "cast_forecast", personId, metadata: { direction, reason, changed: result.changed, surface: "onboarding" } });
  logEventInBackground({ eventType: "onboarding_step", metadata: { step: "forecast", action: "finish" } });
  await markOnboarded();
  redirect("/");
}
