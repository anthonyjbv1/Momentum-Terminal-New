"use client";

import Link from "next/link";

import { FEED_IMPACT_DECIMALS, type FeedEntry as FeedEntryModel } from "@/lib/feed/feed-model";
import { relativeTime } from "@/lib/home/relative-time";
import { Avatar } from "@/components/ui/avatar";
import { DirectionArrow, directionTone, formatChange } from "@/components/ui/direction-indicator";

/**
 * "Also moving" (Phase 34): the small moves between the stories, one compact
 * row each. The person, the headline on one line, the move and the age;
 * the row is a link to the person. Every row still carries the entry data
 * attributes, so the impression log sees it as it sees a card.
 */
export interface AlsoMovingProps {
  entries: FeedEntryModel[];
  /** Index in the visible stream of the first row, for the impression log. */
  position: number;
  now: number;
  onOpen: (entry: FeedEntryModel) => void;
}

export function AlsoMoving({ entries, position, now, onOpen }: AlsoMovingProps) {
  return (
    <section aria-label="Also moving" className="flex flex-col">
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-1 sm:px-6">
        <h3 className="text-label text-fg-muted">Also moving</h3>
        <span className="num text-xs text-fg-faint">{entries.length}</span>
      </header>
      <ul className="flex flex-col divide-y divide-line">
        {entries.map((entry, index) => (
          <li key={entry.id}>
            <article
              data-entry-id={entry.id}
              data-person-id={entry.person.id}
              data-entry-kind={entry.kind}
              data-entry-position={position + index}
              data-entry-pinned="false"
              data-entry-compact="true"
            >
              <Link
                href={`/person/${entry.person.slug}`}
                onClick={() => onOpen(entry)}
                className="flex items-center gap-3 px-5 py-3 transition-colors last:rounded-b-2xl hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 sm:px-6"
              >
                <Avatar name={entry.person.name} src={entry.person.avatarUrl} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-fg">{entry.person.name}</span>
                  <span className="truncate text-xs text-fg-muted">{entry.copy.headline}</span>
                </span>
                {entry.impact !== null ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium tabular-nums leading-none text-fg" aria-label={formatChange(entry.impact, FEED_IMPACT_DECIMALS)}>
                    <DirectionArrow direction={entry.direction} className={directionTone[entry.direction]} />
                    <span>{formatChange(entry.impact, FEED_IMPACT_DECIMALS)}</span>
                  </span>
                ) : null}
                <time dateTime={entry.occurredAt} className="num w-7 shrink-0 text-right text-xs text-fg-faint">
                  {relativeTime(entry.occurredAt, now)}
                </time>
              </Link>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
