"use client";

import Link from "next/link";
import { useActionState, useState, type ReactNode } from "react";

import { finishAction, forecastAction, type ForecastStepState } from "@/app/start/actions";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonClassName } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { DIRECTION_LABELS, FORECAST_DIRECTIONS, FORECAST_REASONS, REASON_LABELS, type ForecastDirection } from "@/lib/forecast/model";
import { ONBOARDING } from "@/lib/onboarding/copy";
import type { RosterEntry } from "@/lib/onboarding/model";

/**
 * The last onboarding screen (Phase 32): one free forecast, or none. Three
 * small choices (who, which way, why), all radios, so the form posts the
 * same three fields the profile's Forecast panel sends. The Rising / Falling
 * choice wears the Buy and Sell pill styling, as the profile's vote buttons
 * do: an action the person takes, never green or red. Trading is mentioned
 * once, as optional, and nothing links to a trade.
 */
export interface ForecastStepProps {
  /** Who to offer: the people just followed, or the top of the board when nobody was. */
  people: RosterEntry[];
  initialState?: ForecastStepState;
}

export function ForecastStep({ people, initialState }: ForecastStepProps) {
  const [state, formAction, pending] = useActionState(forecastAction, initialState ?? {});
  const copy = ONBOARDING.forecast;

  return (
    <div className="flex flex-col gap-8">
      <p className="px-1 text-base text-fg-secondary">{copy.body}</p>

      {/* Keyed on the attempt: a refusal remounts the form with the choices still made. */}
      <ForecastForm key={state.attempt ?? 0} people={people} state={state} formAction={formAction} pending={pending} />

      <div className="flex flex-col gap-3 border-t border-line px-1 pt-6">
        <p className="text-sm text-fg-muted">{copy.trading}</p>
        <form action={finishAction}>
          <button type="submit" className={buttonClassName("ghost", "md", "-ml-3")}>
            {copy.finish}
          </button>
        </form>
      </div>
    </div>
  );
}

function ForecastForm({ people, state, formAction, pending }: { people: RosterEntry[]; state: ForecastStepState; formAction: (form: FormData) => void; pending: boolean }) {
  const chosen = state.values;
  const [direction, setDirection] = useState<ForecastDirection | null>(chosen?.direction === "rising" || chosen?.direction === "falling" ? chosen.direction : null);
  const copy = ONBOARDING.forecast;

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <Choice legend={copy.person}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {people.map((person) => (
            <label key={person.id} className="relative cursor-pointer">
              <input type="radio" name="person" value={person.id} required defaultChecked={chosen?.person === person.id} className="peer sr-only" />
              <span className={pillFace("flex items-center gap-3 rounded-2xl px-3 py-2")}>
                <Avatar name={person.name} src={person.avatarUrl} size="xs" />
                <span className="truncate text-sm font-medium">{person.name}</span>
              </span>
            </label>
          ))}
        </div>
      </Choice>

      <Choice legend={copy.direction}>
        <div className="flex gap-2">
          {FORECAST_DIRECTIONS.map((value) => (
            <label key={value} className="relative">
              <input type="radio" name="direction" value={value} required defaultChecked={direction === value} className="peer sr-only" onChange={() => setDirection(value)} />
              <span
                className={cn(
                  buttonClassName(value === "rising" ? "buy" : "sell", "md", "min-w-28 cursor-pointer"),
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-ring/60",
                  direction !== null && direction !== value && "opacity-40",
                )}
              >
                {DIRECTION_LABELS[value].label}
              </span>
            </label>
          ))}
        </div>
      </Choice>

      <Choice legend={copy.reason}>
        <div className="flex flex-wrap gap-2">
          {FORECAST_REASONS.map((reason) => (
            <label key={reason} className="relative cursor-pointer">
              <input type="radio" name="reason" value={reason} required defaultChecked={chosen?.reason === reason} className="peer sr-only" />
              <span className={pillFace("inline-flex h-9 items-center rounded-full px-4 text-sm font-medium")}>{REASON_LABELS[reason]}</span>
            </label>
          ))}
        </div>
      </Choice>

      {state.error ? (
        <p role="alert" className="px-1 text-sm text-fg">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
        <Link href="/start?step=follow" className={buttonClassName("outline", "lg")}>
          {ONBOARDING.back}
        </Link>
        <Button type="submit" size="lg" loading={pending} disabled={pending}>
          {copy.save}
        </Button>
      </div>
    </form>
  );
}

function Choice({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-2.5 px-1 text-label text-fg-muted">{legend}</legend>
      {children}
    </fieldset>
  );
}

/** Unchosen: the grey surface. Chosen: inverted, as the category pills are. */
function pillFace(shape: string): string {
  return cn(
    shape,
    "bg-surface text-fg transition-colors hover:bg-surface-raised",
    // Chosen stays chosen under the pointer: without the stacked variant, hover's grey would win over the inverse fill.
    "peer-checked:bg-surface-inverse peer-checked:text-fg-inverse peer-checked:hover:bg-surface-inverse",
    "peer-focus-visible:ring-2 peer-focus-visible:ring-ring/60",
  );
}
