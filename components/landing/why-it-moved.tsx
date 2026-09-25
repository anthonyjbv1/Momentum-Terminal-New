"use client";

import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
import { WHY } from "@/lib/landing/copy";
import type { FeaturedForce, FeaturedSignal } from "@/lib/landing/model";
import { FORCE_DEFINITIONS, FORCE_IMPACT_DECIMALS, forcesWindowLabel, formatSigned } from "@/lib/person/profile-model";
import { directionAtPrecision } from "@/components/ui/direction-indicator";

import { Sparkline } from "./sparkline";
import { useFeatured } from "./use-featured";

/**
 * WHY IT MOVED: the same reading a profile gives inside the app, for the one
 * person this page is allowed to describe. The last day as a line, the three
 * forces that move the score (Gravity, Signals, Market Mood — never the
 * market forces, which move the market price) over the last hour with the
 * points each added, and the recent
 * signals in plain language — or, honestly, the statement that none has
 * arrived yet.
 *
 * Everything here re-renders from the same payload the hero moves on, so
 * the number and its explanation never describe different ticks.
 */

const fillTones = { heating: "bg-positive", cooling: "bg-negative", neutral: "bg-neutral" } as const;
const figureTones = { heating: "text-positive", cooling: "text-negative", neutral: "text-fg-muted" } as const;

function barScale(forces: FeaturedForce[]): number {
  return Math.max(1, ...forces.map((force) => Math.abs(force.impact ?? 0)));
}

export function WhyItMoved({ className }: { className?: string }) {
  const { payload, now } = useFeatured();
  const forces = payload?.forces ?? [];
  const ticked = forces.some((force) => force.impact !== null);
  const scale = barScale(forces);
  const span = forcesWindowLabel(payload?.windowMinutes ?? 60);

  return (
    <section aria-labelledby="why-heading" className={cn("flex flex-col gap-8", className)}>
      <div className="flex flex-col gap-3">
        <h2 id="why-heading" className="text-label text-fg-muted">
          {WHY.title}
        </h2>
        <p className="max-w-prose text-base leading-relaxed text-fg-secondary">{WHY.sub}</p>
      </div>

      {payload && payload.history.length >= 2 ? (
        <figure className="flex flex-col gap-3">
          <Sparkline points={payload.history} label={`${WHY.historyLabel}: the score as a line`} className="h-16 w-full text-fg-secondary sm:h-20" />
          <figcaption className="flex items-center justify-between text-xs text-fg-faint">
            <span>{WHY.historyLabel}</span>
            <span className="num">
              {formatSigned(payload.change.h24 ?? 0, 1)} over the day
            </span>
          </figcaption>
        </figure>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-fg-secondary">
          {WHY.forcesLabel}
          <span className="text-fg-muted"> · last {span}</span>
        </h3>
        {ticked ? (
          <ol className="divide-y divide-line rounded-2xl border border-line">
            {forces.map((force) => (
              <ForceRow key={force.key} force={force} scale={scale} />
            ))}
          </ol>
        ) : (
          <p className="rounded-2xl border border-line px-5 py-6 text-sm text-fg-muted">{WHY.idle}</p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-fg-secondary">{WHY.signalsLabel}</h3>
        {payload && payload.signals.length > 0 ? (
          <ol className="divide-y divide-line rounded-2xl border border-line">
            {payload.signals.map((signal) => (
              <SignalRow key={`${signal.occurredAt}:${signal.headline}`} signal={signal} now={now} />
            ))}
          </ol>
        ) : (
          <p className="max-w-prose rounded-2xl border border-line px-5 py-6 text-sm leading-relaxed text-fg-muted">{WHY.noSignals}</p>
        )}
      </div>
    </section>
  );
}

function ForceRow({ force, scale }: { force: FeaturedForce; scale: number }) {
  const idle = force.impact === null;
  const direction = directionAtPrecision(force.impact, FORCE_IMPACT_DECIMALS, 0);
  const magnitude = idle ? 0 : Math.min(1, Math.abs(force.impact ?? 0) / scale);
  const halfWidth = `${(magnitude * 50).toFixed(2)}%`;

  return (
    <li className="flex items-center gap-4 px-5 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cn("text-sm font-medium", idle ? "text-fg-muted" : "text-fg")}>{FORCE_DEFINITIONS[force.key].label}</p>
        <p className="text-xs leading-snug text-fg-muted">{WHY.forces[force.key]}</p>
      </div>

      <div className="relative hidden h-1.5 w-32 shrink-0 rounded-full bg-surface-raised sm:block lg:w-44" aria-hidden>
        <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-line-strong" />
        {magnitude > 0 ? (
          <span
            className={cn("absolute top-0 h-full rounded-full", fillTones[direction])}
            style={direction === "cooling" ? { right: "50%", width: halfWidth } : { left: "50%", width: halfWidth }}
          />
        ) : null}
      </div>

      <div className="w-16 shrink-0 text-right">
        {idle ? <span className="text-label text-fg-faint">Idle</span> : <span className={cn("num text-sm font-medium", figureTones[direction])}>{formatSigned(force.impact ?? 0, FORCE_IMPACT_DECIMALS)}</span>}
      </div>
    </li>
  );
}

function SignalRow({ signal, now }: { signal: FeaturedSignal; now: number }) {
  const direction = directionAtPrecision(signal.impact, FORCE_IMPACT_DECIMALS, 0);
  return (
    <li className="flex flex-col gap-2 px-5 py-4">
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <span className="truncate font-medium text-fg-secondary">{signal.source}</span>
        <span aria-hidden>·</span>
        <time dateTime={signal.occurredAt} className="num shrink-0">
          {relativeTime(signal.occurredAt, now)}
        </time>
        {signal.impact !== null ? (
          <span className={cn("num ml-auto shrink-0 font-medium", figureTones[direction])}>{formatSigned(signal.impact, FORCE_IMPACT_DECIMALS)}</span>
        ) : null}
      </div>
      <p className="text-sm leading-relaxed text-fg">{signal.headline}</p>
    </li>
  );
}
