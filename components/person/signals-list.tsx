"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
import { formatSigned, signalIdOf, type ProfileSignal } from "@/lib/person/profile-model";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { directionOf } from "@/components/ui/direction-indicator";
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
    <section aria-labelledby="signals-heading" className={cn("flex flex-col gap-4", className)}>
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
  const direction = directionOf(item.impact, 0);

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
              <span className={cn("num text-sm font-medium", impactTones[direction])}>{formatSigned(item.impact, 2)}</span>
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
        </dl>
      ) : null}
    </article>
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
