"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { outletName, sourceNoun, type CardSubject } from "@/lib/feed/card-copy";
import { categoryLabel, evidenceDetailLines, evidenceHeadline, subjectOf, type FeedEntry as FeedEntryModel, type FeedEvidence } from "@/lib/feed/feed-model";
import { relativeTime } from "@/lib/home/relative-time";
import { FORCE_IMPACT_DECIMALS, formatSigned } from "@/lib/person/profile-model";
import { readMetricPayload } from "@/lib/signals/metric-language";
import { Avatar } from "@/components/ui/avatar";
import { DirectionIndicator, directionAtPrecision } from "@/components/ui/direction-indicator";

/**
 * One entry in the Feed (Phase 30 anatomy). The person is identified and
 * tappable; the outlet sits small above an article's title; the headline is
 * the hero — the Engine's sentence, or the publisher's title linked to the
 * piece; one plain line says what it was and how far it moved the score; the
 * attribution is small, grey and last. The recorded score impact is the only
 * colour. A `prominent` entry (the pinned treatment) is the same composition
 * set larger and given more air: it is structural prominence, not an alarm.
 *
 * Detail opens beneath: for a narrative, exactly the signals the Engine
 * linked when it wrote the sentence (an inverse-pair signal is shown as the
 * paired person's), each labelled by its outlet and linked; for a signal,
 * where it came from and how the Engine has treated it so far.
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

const focusRing = "rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-surface";

export function FeedEntry({ entry, position, prominent = false, now, onOpen, onExpand }: FeedEntryProps) {
  const [open, setOpen] = useState(false);
  const href = `/person/${entry.person.slug}`;
  const { copy } = entry;
  const hasDetail = entry.kind === "narrative" ? entry.evidence.length > 0 || entry.scoreBefore !== null : true;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    onExpand(entry, next);
  };

  const headline = (
    <p className={cn("text-fg", prominent ? "text-2xl font-semibold leading-snug tracking-tight sm:text-3xl" : "text-lg leading-relaxed")}>{copy.headline}</p>
  );

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

      <div className="flex flex-col gap-2">
        {copy.label ? <p className="text-label text-fg-muted">{copy.label}</p> : null}
        {copy.link ? (
          <a href={copy.link} target="_blank" rel="noopener noreferrer" className={cn("group/link block", focusRing)}>
            {headline}
            <span className="mt-1 inline-flex items-center gap-1 text-xs text-fg-faint transition-colors group-hover/link:text-fg-muted">
              Read at {copy.label ?? "the source"}
              <ArrowUpRight className="size-3" aria-hidden />
            </span>
          </a>
        ) : (
          <Link href={href} onClick={() => onOpen(entry)} className={cn("block", focusRing)}>
            {headline}
          </Link>
        )}
        <p className={cn("leading-relaxed text-fg-secondary", prominent ? "text-base" : "text-sm")}>{copy.line}</p>
      </div>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-faint">
        <span>{copy.attribution}</span>
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

function Detail({ entry }: { entry: FeedEntryModel }) {
  const subject = subjectOf(entry.person);

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
        {/*
          Phase 21+: for a metric signal this is where "why did this fire"
          gets answered in counts — what was seen, the person's own pace, and
          the window behind it. Phase 30 adds where the signal came from.
        */}
        {entry.detailLines.map((line) => (
          <DetailItem key={line.label} label={line.label} value={line.value} />
        ))}
        {entry.copy.link ? (
          <DetailItem label="Article">
            <a href={entry.copy.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-fg-secondary underline-offset-4 hover:underline">
              Read the article
              <ArrowUpRight className="size-3" aria-hidden />
            </a>
          </DetailItem>
        ) : null}
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
            <EvidenceRow key={item.id} item={item} subject={subject} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-fg-muted">No signal produced this move; the other forces carried it.</p>
      )}
    </div>
  );
}

/** Where a piece of evidence came from: the outlet for an article, the source noun for anything else. */
function evidenceLabel(item: FeedEvidence): string {
  const metric = readMetricPayload(item.payload) !== null;
  const article = !metric && item.detail?.kind === "article";
  return (article ? outletName(item.detail?.outlet, item.detail?.domain) : null) ?? sourceNoun(item.source, metric ? "metric" : item.detail?.kind);
}

function EvidenceRow({ item, subject }: { item: FeedEvidence; subject: CardSubject }) {
  const sentence = evidenceHeadline(item, subject);
  const lines = evidenceDetailLines(item, subject).filter((line) => line.label !== "Source");
  const link = item.detail?.link ?? null;
  return (
    <li className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-fg-muted">
          {item.relation === "inverse_pair" && item.person ? (
            <>
              <Link href={`/person/${item.person.slug}`} className="text-fg-secondary underline-offset-4 hover:underline">
                {item.person.name}
              </Link>
              <span className="text-fg-faint"> · </span>
            </>
          ) : null}
          {evidenceLabel(item)}
        </span>
        {/*
          Phase 21+: a metric's sentence is re-rendered from its payload, so
          a signal stored in sigma reads as plain language here. An article
          keeps its title and links to the piece (Phase 30).
        */}
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className="text-sm leading-relaxed text-fg-secondary underline-offset-4 hover:underline">
            {sentence}
          </a>
        ) : (
          <span className="text-sm leading-relaxed text-fg-secondary">{sentence}</span>
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
      {item.impact !== null ? (
        <span className={cn("num shrink-0 text-xs font-medium", impactTones[directionAtPrecision(item.impact, FORCE_IMPACT_DECIMALS, 0)])}>
          {formatSigned(item.impact, FORCE_IMPACT_DECIMALS)}
        </span>
      ) : null}
    </li>
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
