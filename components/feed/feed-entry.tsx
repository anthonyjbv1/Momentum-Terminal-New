"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { categoryLabel, type FeedEntry as FeedEntryModel } from "@/lib/feed/feed-model";
import { relativeTime } from "@/lib/home/relative-time";
import { formatSigned } from "@/lib/person/profile-model";
import { Avatar } from "@/components/ui/avatar";
import { DirectionIndicator, directionOf } from "@/components/ui/direction-indicator";

/**
 * One entry on the wire. The Engine's sentence is the hero; the person is
 * identified and tappable; the recorded score impact is the only colour;
 * the source line is small, grey and last. A `prominent` entry (the pinned
 * treatment) is the same composition set larger and given more air: it is
 * structural prominence, not an alarm.
 *
 * Detail opens beneath: for a narrative, the signals the Engine read that
 * tick; for a raw signal, how the Engine has treated it so far.
 */
export interface FeedEntryProps {
  entry: FeedEntryModel;
  /** Index in the visible stream, for the impression log. */
  position: number;
  prominent?: boolean;
  /** Wall-clock time relative ages are measured from (the server's at first, then live). */
  now: number;
  onOpen: (entry: FeedEntryModel) => void;
  onExpand: (entry: FeedEntryModel, expanded: boolean) => void;
}

const impactTones = {
  heating: "text-positive",
  cooling: "text-negative",
  neutral: "text-fg-muted",
} as const;

const detailTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function FeedEntry({ entry, position, prominent = false, now, onOpen, onExpand }: FeedEntryProps) {
  const [open, setOpen] = useState(false);
  const href = `/person/${entry.person.slug}`;
  const hasDetail = entry.kind === "narrative" ? entry.evidence.length > 0 || entry.scoreBefore !== null : true;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    onExpand(entry, next);
  };

  return (
    <article
      data-entry-id={entry.id}
      data-person-id={entry.person.id}
      data-entry-kind={entry.kind}
      data-entry-position={position}
      data-entry-pinned={prominent ? "true" : "false"}
      className={cn("flex flex-col", prominent ? "gap-5 px-6 py-8 sm:px-8 sm:py-9" : "gap-4 px-5 py-6 sm:px-6 sm:py-7")}
    >
      <header className="flex items-center gap-3">
        <Link
          href={href}
          onClick={() => onOpen(entry)}
          className="group flex min-w-0 items-center gap-3 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
          <Avatar name={entry.person.name} src={entry.person.avatarUrl} size={prominent ? "lg" : "md"} />
          <span className="flex min-w-0 flex-col">
            <span className={cn("truncate font-medium text-fg transition-colors group-hover:text-fg-secondary", prominent ? "text-base" : "text-sm")}>
              {entry.person.name}
            </span>
            <span className="truncate text-xs text-fg-muted">{categoryLabel(entry.person.category)}</span>
          </span>
        </Link>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {entry.impact !== null ? <DirectionIndicator change={entry.impact} size={prominent ? "lg" : "sm"} precision={1} /> : null}
          <time dateTime={entry.occurredAt} className="num text-xs text-fg-faint">
            {relativeTime(entry.occurredAt, now)}
          </time>
        </div>
      </header>

      <Link
        href={href}
        onClick={() => onOpen(entry)}
        className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
      >
        <p className={cn("text-fg", prominent ? "text-2xl font-semibold leading-snug tracking-tight sm:text-3xl" : "text-lg leading-relaxed")}>{entry.text}</p>
      </Link>

      {entry.quote ? (
        <blockquote className={cn("border-l border-line-strong pl-4 leading-relaxed text-fg-secondary", prominent ? "text-lg" : "text-base")}>
          &ldquo;{entry.quote}&rdquo;
        </blockquote>
      ) : null}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-faint">
        <span>{attribution(entry)}</span>
        {hasDetail ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="ml-auto inline-flex items-center gap-1 rounded-full text-xs font-medium text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {entry.kind === "narrative" ? "What the Engine saw" : "Detail"}
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
          </button>
        ) : null}
      </footer>

      {open ? <Detail entry={entry} /> : null}
    </article>
  );
}

/** "The Engine · via YouTube, RSS" for a narrative; "Observed via YouTube" for a raw signal. */
function attribution(entry: FeedEntryModel): string {
  if (entry.kind === "narrative") {
    return entry.sources.length > 0 ? `The Engine · via ${entry.sources.join(", ")}` : "The Engine";
  }
  return entry.sources.length > 0 ? `Observed via ${entry.sources.join(", ")}` : "Observed";
}

function Detail({ entry }: { entry: FeedEntryModel }) {
  if (entry.kind === "signal") {
    const own = entry.evidence[0];
    return (
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-md bg-surface-raised/60 px-4 py-3 text-xs animate-fade-in sm:grid-cols-3">
        <DetailItem label="Engine" value={own?.processed === false ? "Awaiting its read" : "Read"} />
        {own?.sentiment ? (
          <DetailItem label="Sentiment">
            <span className="capitalize">{own.sentiment}</span>
            {own.confidence !== null ? (
              <>
                {" "}
                <span className="text-fg-faint">·</span> <span className="num">{Math.round(own.confidence * 100)}%</span>
              </>
            ) : null}
          </DetailItem>
        ) : null}
        <DetailItem label="Observed" value={detailTime.format(new Date(entry.occurredAt))} />
      </dl>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md bg-surface-raised/60 px-4 py-3 animate-fade-in">
      {entry.scoreBefore !== null && entry.scoreAfter !== null ? (
        <p className="text-xs text-fg-muted">
          Score <span className="num text-fg-secondary">{entry.scoreBefore.toFixed(1)}</span> <span className="text-fg-faint">→</span>{" "}
          <span className="num text-fg-secondary">{entry.scoreAfter.toFixed(1)}</span>
          {entry.tickNumber !== null ? (
            <>
              {" "}
              <span className="text-fg-faint">·</span> tick <span className="num">{entry.tickNumber}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {entry.evidence.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {entry.evidence.map((item) => (
            <li key={item.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-xs text-fg-muted">{item.source ?? "Signal"}</span>
                <span className="text-sm leading-relaxed text-fg-secondary">&ldquo;{item.headline}&rdquo;</span>
              </div>
              {item.impact !== null ? (
                <span className={cn("num shrink-0 text-xs font-medium", impactTones[directionOf(item.impact, 0)])}>{formatSigned(item.impact, 2)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-fg-muted">No signals were processed for this move; the other forces carried it.</p>
      )}
    </div>
  );
}

function DetailItem({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-label text-fg-faint">{label}</dt>
      <dd className="text-fg-secondary">{value ?? children}</dd>
    </div>
  );
}
