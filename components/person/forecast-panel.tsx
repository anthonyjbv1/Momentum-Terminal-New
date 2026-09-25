"use client";

import Link from "next/link";
import { useState } from "react";

import { cn } from "@/lib/cn";
import {
  DIRECTION_LABELS,
  FORECAST_REASONS,
  FORECAST_SECTION_TITLE,
  REASON_LABELS,
  readCastResult,
  splitPercent,
  type CastForecastResult,
  type ForecastDirection,
  type ForecastReason,
  type ForecastSummary,
  type OwnForecastVote,
  type ReasonCount,
} from "@/lib/forecast/model";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";

import { PROFILE_SURFACE, logProfileEvent } from "./use-profile-logging";

/**
 * FORECAST — the crowd's read on a person's trajectory (Phase 19). Sits
 * below the five forces in their styling, and shows aggregates only:
 * % Rising / % Falling, the count, and the top reason tags per direction,
 * once at least the minimum number of votes exist. Below that it shows the
 * count alone; with none it invites the first forecast rather than drawing
 * an empty chart.
 *
 * Colour: green and red mean direction and only direction — the reported
 * split and the reason tags. The two VOTE buttons are actions the user
 * takes, like Buy and Sell, so they wear exactly the Buy and Sell styling
 * (the light pill and the dark pill), never green or red.
 *
 * Votes influence nothing (the Forecast force ships at weight 0.00); this
 * panel says so in its footnote rather than implying otherwise.
 *
 * Typography (Phase 29c, by the Phase 26 rule): the count and the minimum
 * sit inside sentences — "1 forecast so far … once 5 people have called
 * it" — so they are Inter with tabular figures, not the mono face. "1
 * forecast" in the header is a word too. The split's percentages stand
 * alone and stay mono.
 */
export interface ForecastPanelProps {
  person: { id: string; slug: string; displayName: string; forecastPaused: boolean };
  summary: ForecastSummary;
  signedIn: boolean;
  ownVote: OwnForecastVote | null;
  loggingEnabled: boolean;
  className?: string;
}

type Step = { kind: "idle" } | { kind: "reason"; direction: ForecastDirection } | { kind: "sending"; direction: ForecastDirection; reason: ForecastReason };

export function ForecastPanel({ person, summary: initialSummary, signedIn, ownVote: initialOwnVote, loggingEnabled, className }: ForecastPanelProps) {
  const [summary, setSummary] = useState(initialSummary);
  const [ownVote, setOwnVote] = useState(initialOwnVote);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  // The per-person kill switch: the section is not there at all.
  if (person.forecastPaused) return null;

  const cast = async (direction: ForecastDirection, reason: ForecastReason) => {
    setStep({ kind: "sending", direction, reason });
    setNotice(null);
    let result: CastForecastResult;
    try {
      const response = await fetch("/api/forecast/vote", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId: person.id, direction, reason, surface: PROFILE_SURFACE }),
      });
      result = readCastResult(await response.json().catch(() => null));
    } catch {
      result = { ok: false, code: "unavailable", message: "The forecast could not reach the server. Nothing was recorded." };
    }
    setStep({ kind: "idle" });
    setChanging(false);
    if (!result.ok) {
      setNotice(result.message);
      return;
    }
    const previous = ownVote;
    setOwnVote(result.vote);
    if (result.changed) {
      logProfileEvent(loggingEnabled, { eventType: "cast_forecast", personId: person.id, metadata: { direction, reason, changed: true, surface: PROFILE_SURFACE } });
      // Keep the count honest without a round trip: a first vote adds one; a
      // change moves one. The split itself stays as the server last gave it.
      setSummary((current) => (previous ? current : { ...current, total: current.total + 1 }));
    }
  };

  const showVoting = signedIn && (!ownVote || changing);

  return (
    <section aria-labelledby="forecast-heading" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader title={FORECAST_SECTION_TITLE} meta={summary.total > 0 ? <span className="tabular-nums">{forecastsLabel(summary.total)}</span> : null} />
      <h2 id="forecast-heading" className="sr-only">
        {FORECAST_SECTION_TITLE}
      </h2>

      <Card className="flex flex-col gap-6 p-5 sm:p-6">
        {summary.revealed && summary.rising !== null && summary.falling !== null ? (
          <Split rising={summary.rising} falling={summary.falling} risingReasons={summary.risingReasons ?? []} fallingReasons={summary.fallingReasons ?? []} />
        ) : summary.total > 0 ? (
          <p className="text-sm text-fg-muted">
            <span className="tabular-nums text-fg">{forecastsLabel(summary.total)}</span> so far. The Rising / Falling split shows once{" "}
            <span className="tabular-nums text-fg">{summary.minVotes}</span> people have called it.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-base font-medium text-fg">Make the first forecast.</p>
            <p className="max-w-prose text-sm text-fg-muted">
              Is {person.displayName}&rsquo;s momentum rising or falling over the next month? Your call, with a reason, is the first reading the crowd has on
              them.
            </p>
          </div>
        )}

        {ownVote && !changing ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
            <p className="text-sm text-fg-secondary">
              You forecast <span className={cn("font-medium", ownVote.direction === "rising" ? "text-positive" : "text-negative")}>{DIRECTION_LABELS[ownVote.direction].label}</span>
              <span aria-hidden> · </span>
              {REASON_LABELS[ownVote.reason]}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
              Change
            </Button>
          </div>
        ) : null}

        {showVoting ? (
          <VoteControls person={person} step={step} onDirection={(direction) => setStep({ kind: "reason", direction })} onReason={(direction, reason) => cast(direction, reason)} onCancel={() => { setStep({ kind: "idle" }); setChanging(false); }} canCancel={Boolean(ownVote)} />
        ) : null}

        {!signedIn ? (
          <div className="flex flex-col gap-3 border-t border-line pt-5">
            <div className="flex gap-2">
              <Link href={`/login?next=${encodeURIComponent(`/person/${person.slug}`)}`} className={buttonClassName("buy", "md", "min-w-28")} aria-label={`Sign in to forecast ${person.displayName} rising`}>
                {DIRECTION_LABELS.rising.label}
              </Link>
              <Link href={`/login?next=${encodeURIComponent(`/person/${person.slug}`)}`} className={buttonClassName("sell", "md", "min-w-28")} aria-label={`Sign in to forecast ${person.displayName} falling`}>
                {DIRECTION_LABELS.falling.label}
              </Link>
            </div>
            <p className="text-xs text-fg-muted">Sign in to forecast.</p>
          </div>
        ) : null}

        {notice ? (
          <p role="status" className="text-sm text-fg-muted">
            {notice}
          </p>
        ) : null}
      </Card>

      <p className="px-1 text-xs text-fg-faint">A forecast is a call on where the momentum goes, not a rating of the person. The crowd&rsquo;s calls are shown here and move no score.</p>
    </section>
  );
}

function forecastsLabel(total: number): string {
  return `${total.toLocaleString("en-US")} ${total === 1 ? "forecast" : "forecasts"}`;
}

/** The two-button vote, then the reason picker. Fast: one tap, one tap. */
function VoteControls({
  person,
  step,
  onDirection,
  onReason,
  onCancel,
  canCancel,
}: {
  person: { displayName: string };
  step: Step;
  onDirection: (direction: ForecastDirection) => void;
  onReason: (direction: ForecastDirection, reason: ForecastReason) => void;
  onCancel: () => void;
  canCancel: boolean;
}) {
  const sending = step.kind === "sending";
  const chosen = step.kind === "idle" ? null : step.direction;

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-5">
      <div className="flex items-center gap-2">
        <Button
          variant="buy"
          size="md"
          className={cn("min-w-28", chosen === "falling" && "opacity-40")}
          disabled={sending}
          aria-pressed={chosen === "rising"}
          aria-label={`Forecast ${person.displayName} rising`}
          onClick={() => onDirection("rising")}
        >
          {DIRECTION_LABELS.rising.label}
        </Button>
        <Button
          variant="sell"
          size="md"
          className={cn("min-w-28", chosen === "rising" && "opacity-40")}
          disabled={sending}
          aria-pressed={chosen === "falling"}
          aria-label={`Forecast ${person.displayName} falling`}
          onClick={() => onDirection("falling")}
        >
          {DIRECTION_LABELS.falling.label}
        </Button>
        {canCancel ? (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onCancel} disabled={sending}>
            Keep mine
          </Button>
        ) : null}
      </div>

      {chosen ? (
        <div className="flex flex-col gap-2.5" role="group" aria-label="Why">
          <p className="text-xs text-fg-muted">
            {DIRECTION_LABELS[chosen].word} because of&hellip;
          </p>
          <div className="flex flex-wrap gap-2">
            {FORECAST_REASONS.map((reason) => (
              <Button
                key={reason}
                variant="outline"
                size="sm"
                loading={sending && step.kind === "sending" && step.reason === reason}
                disabled={sending}
                onClick={() => onReason(chosen, reason)}
              >
                {REASON_LABELS[reason]}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The reported split: a diverging bar, the two percentages, the count and the top reasons, in direction colour. */
function Split({ rising, falling, risingReasons, fallingReasons }: { rising: number; falling: number; risingReasons: ReasonCount[]; fallingReasons: ReasonCount[] }) {
  const pct = splitPercent(rising, falling);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="flex items-baseline gap-2 text-positive">
          <span className="num text-2xl font-semibold tracking-tight">{pct.rising}%</span>
          <span className="text-sm font-medium">{DIRECTION_LABELS.rising.label}</span>
        </p>
        <p className="flex items-baseline gap-2 text-negative">
          <span className="text-sm font-medium">{DIRECTION_LABELS.falling.label}</span>
          <span className="num text-2xl font-semibold tracking-tight">{pct.falling}%</span>
        </p>
      </div>
      <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-raised" aria-hidden>
        <span className="h-full rounded-full bg-positive" style={{ width: `${pct.rising}%` }} />
        <span className="h-full rounded-full bg-negative" style={{ width: `${pct.falling}%` }} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Reasons tone="positive" reasons={risingReasons} />
        <Reasons tone="negative" reasons={fallingReasons} className="sm:justify-end" />
      </div>
    </div>
  );
}

function Reasons({ tone, reasons, className }: { tone: "positive" | "negative"; reasons: ReasonCount[]; className?: string }) {
  if (reasons.length === 0) return <div className={cn("flex", className)} />;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {reasons.map((entry) => (
        <Badge key={entry.reason} tone={tone}>
          {REASON_LABELS[entry.reason]} <span className="num">{entry.count}</span>
        </Badge>
      ))}
    </div>
  );
}
