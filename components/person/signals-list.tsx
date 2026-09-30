"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
import { FORCE_IMPACT_DECIMALS, formatSigned, signalIdOf, type ProfileEvidence, type ProfileSignal } from "@/lib/person/profile-model";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { directionAtPrecision } from "@/components/ui/direction-indicator";
import { SectionHeader } from "@/components/ui/page-header";

import { PROFILE_SURFACE, logProfileEvent } from "./use-profile-logging";

/**
 * Signals and the Engine's narratives about one person, newest first. Each
 * item is a source, a time, a headline and, when the Engine has scored it,
 * the points it moved. Tapping an item opens its detail and logs
 * expand_signal. Read-only: nothing here is acted on.
 */
export interface SignalsListProps {
  items: ProfileSignal[];
  personId: string;
  personName: string;
  loggingEnabled: boolean;
  /** Server render time, so relative ages agree between server and client. */
  renderedAt: number;
  className?: string;
}

const impactTones = {
  heating: "text-positive",
  cooling: "text-negative",
  neutral: "text-fg-muted",
} as const;

export function SignalsList({ items, personId, personName, loggingEnabled, renderedAt, className }: SignalsListProps) {
  return (
    <section aria-labelledby="signals-heading" data-tour="signals" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader
        title="Signals"
        meta={
          items.length > 0 ? (
            <>
              <span className="num">{items.length}</span> recent
            </>
          ) : (
            <Badge tone="warning" dot>
              Standby
            </Badge>
          )
        }
      />
      <h2 id="signals-heading" className="sr-only">
        Signals
      </h2>

      {items.length === 0 ? (
        <Card tone="ghost">
          <div className="flex flex-col gap-2 px-5 py-8 text-center">
            <p className="text-sm font-medium text-fg-secondary">No signals yet</p>
            <p className="text-sm text-fg-muted">
              Signals about {personName} and the Engine&rsquo;s read on them appear here once ingestion runs.
            </p>
          </div>
        </Card>
      ) : (
        <Card className="flex flex-col divide-y divide-line">
          {items.map((item) => (
            <SignalItem key={item.id} item={item} personId={personId} loggingEnabled={loggingEnabled} renderedAt={renderedAt} />
          ))}
        </Card>
      )}
    </section>
  );
}

const detailTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function SignalItem({ item, personId, loggingEnabled, renderedAt }: { item: ProfileSignal; personId: string; loggingEnabled: boolean; renderedAt: number }) {
  const [open, setOpen] = useState(false);
  // Coloured by the figure below, at the decimals it is shown to: an impact
  // that rounds to 0.00 reads as nothing happened, so it takes no colour.
  const direction = directionAtPrecision(item.impact, FORCE_IMPACT_DECIMALS, 0);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      const signalId = signalIdOf(item);
      logProfileEvent(loggingEnabled, {
        eventType: "expand_signal",
        personId,
        metadata: {
          ...(signalId ? { signal_id: signalId } : {}),
          headline: item.headline.slice(0, 200),
          kind: item.kind,
          surface: PROFILE_SURFACE,
        },
      });
    }
  };

  return (
    <article className="flex flex-col">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn(
          "flex w-full flex-col gap-2 px-5 py-4 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl",
          "hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
        )}
      >
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span className="truncate font-medium text-fg-secondary">{item.source}</span>
          <span aria-hidden>·</span>
          <time dateTime={item.occurredAt} className="num shrink-0">
            {relativeTime(item.occurredAt, renderedAt)}
          </time>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {item.impact !== null ? (
              <span className={cn("text-sm font-medium tabular-nums", impactTones[direction])}>{formatSigned(item.impact, FORCE_IMPACT_DECIMALS)}</span>
            ) : item.processed === false ? (
              <span className="text-label text-fg-faint">Unscored</span>
            ) : null}
            <ChevronDown className={cn("size-4 text-fg-faint transition-transform", open && "rotate-180")} aria-hidden />
          </span>
        </div>

        <p className={cn("text-sm leading-relaxed text-fg-secondary", !open && "line-clamp-2")}>{item.headline}</p>
      </button>

      {open ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 pb-5 pt-1 text-xs animate-fade-in">
          <Detail label="Recorded" value={detailTime.format(new Date(item.occurredAt))} />
          {item.kind === "narrative" && item.scoreBefore !== null && item.scoreAfter !== null ? (
            <Detail label="Score">
              <span className="num">{item.scoreBefore.toFixed(1)}</span> <span className="text-fg-faint">→</span> <span className="num">{item.scoreAfter.toFixed(1)}</span>
            </Detail>
          ) : null}
          {item.sentiment ? (
            <Detail label="Sentiment">
              <span className="capitalize">{item.sentiment.label}</span>
              {item.sentiment.confidence !== null ? (
                <>
                  {" "}
                  <span className="text-fg-faint">·</span> <span className="num">{Math.round(item.sentiment.confidence * 100)}%</span> confidence
                </>
              ) : null}
            </Detail>
          ) : null}
          {item.kind === "signal" ? <Detail label="Engine" value={item.processed ? "Scored" : "Awaiting scoring"} /> : null}
          {/*
            Phase 21+: what a metric actually observed, and what it was judged
            against. The sentence above says "3x their usual pace"; these are
            the numbers that claim is made of, so a reader can check it rather
            than take it. Empty for every non-metric signal.
          */}
          {item.detail.map((line) => (
            <Detail key={line.label} label={line.label} value={line.value} />
          ))}
          {item.link ? (
            <Detail label="Article">
              <a href={item.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-fg-secondary underline-offset-4 hover:underline">
                Read the article
                <ArrowUpRight className="size-3" aria-hidden />
              </a>
            </Detail>
          ) : null}
          {/*
            Phase 31, rule 8: a signal the Engine linked to this narrative is
            not an item of its own in the list, so it is read here, as the
            Feed's "What the Engine saw" lists it.
          */}
          {item.kind === "narrative" && item.evidence.length > 0 ? (
            <div className="col-span-2 flex flex-col gap-1">
              <dt className="text-label text-fg-faint">What the Engine saw</dt>
              <dd>
                <ul className="flex flex-col divide-y divide-line">
                  {item.evidence.map((evidence) => (
                    <EvidenceRow key={evidence.id} evidence={evidence} />
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </article>
  );
}

function EvidenceRow({ evidence }: { evidence: ProfileEvidence }) {
  const lines = evidence.lines;
  return (
    <li className="flex items-start gap-3 py-2.5 first:pt-1 last:pb-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-fg-muted">
          {evidence.personName ? (
            <>
              <span className="text-fg-secondary">{evidence.personName}</span>
              <span className="text-fg-faint"> · </span>
            </>
          ) : null}
          {evidence.source}
        </span>
        {evidence.link ? (
          <a href={evidence.link} target="_blank" rel="noopener noreferrer" className="text-sm leading-relaxed text-fg-secondary underline-offset-4 hover:underline">
            {evidence.headline}
          </a>
        ) : (
          <span className="text-sm leading-relaxed text-fg-secondary">{evidence.headline}</span>
        )}
        {lines.length > 0 ? (
          <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
            {lines.map((line) => (
              <span key={line.label}>
                <span className="text-fg-faint">{line.label}:</span> {line.value}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {evidence.impact !== null ? (
        <span className={cn("num shrink-0 text-xs font-medium", impactTones[directionAtPrecision(evidence.impact, FORCE_IMPACT_DECIMALS, 0)])}>
          {formatSigned(evidence.impact, FORCE_IMPACT_DECIMALS)}
        </span>
      ) : null}
    </li>
  );
}

function Detail({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-label text-fg-faint">{label}</dt>
      <dd className="text-fg-secondary">{value ?? children}</dd>
    </div>
  );
}
