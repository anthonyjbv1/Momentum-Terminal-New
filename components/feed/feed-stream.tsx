"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import type { RosterPerson } from "@/lib/feed/feed";
import {
  FEED_MAX_ENTRIES,
  FEED_PAGE_SIZE,
  FEED_PREFETCH_MARGIN_PX,
  categoryLabel,
  filterEntries,
  mergeEntries,
  selectPinned,
  type FeedCursor,
  type FeedEntry as FeedEntryModel,
  type FeedPage,
} from "@/lib/feed/feed-model";
import { rankFeed } from "@/lib/feed/ranking";
import type { CategoryOption } from "@/lib/home/board-model";
import { CategoryFilter } from "@/components/home/category-filter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";
import { SkeletonFeedItem } from "@/components/ui/skeleton";

import { FeedEmpty } from "./feed-empty";
import { FeedEntry } from "./feed-entry";
import { FEED_SURFACE, logFeedEvent, useFeedLogging } from "./use-feed-logging";

/**
 * The scrolling half of the Feed: the loaded window of entries, instant
 * category filtering over it, the pinned high-impact section, infinite
 * scroll through a bounded window, and the behavioural logging.
 *
 * Ordering is chronological, newest first, through `rankFeed`: that call is
 * the one place a personalised ranker will plug in later.
 */
export interface FeedStreamProps {
  initialPage: FeedPage;
  categories: CategoryOption[];
  roster: RosterPerson[];
  loggingEnabled: boolean;
  /** Server render time, so relative ages agree between server and client. */
  renderedAt: number;
  /** Where further pages come from. Production uses /api/feed. */
  endpoint?: string;
  className?: string;
}

export function FeedStream({ initialPage, categories, roster, loggingEnabled, renderedAt, endpoint = "/api/feed", className }: FeedStreamProps) {
  const [entries, setEntries] = useState<FeedEntryModel[]>(initialPage.entries);
  const [cursor, setCursor] = useState<FeedCursor | null>(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState("all");
  const [now, setNow] = useState(renderedAt);

  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);

  // Relative ages stay honest while the page is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const capped = entries.length >= FEED_MAX_ENTRIES;
  const exhausted = cursor === null;

  const loadMore = useCallback(async () => {
    if (inFlight.current || cursor === null || capped) return;
    inFlight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("before", cursor.before);
      url.searchParams.set("before_id", cursor.beforeId);
      url.searchParams.set("limit", String(FEED_PAGE_SIZE));
      const response = await fetch(url.toString(), { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error(`feed page ${response.status}`);
      const page = (await response.json()) as FeedPage;
      setEntries((previous) => mergeEntries(previous, page.entries));
      setCursor(page.nextCursor);
      setNow(Date.now());
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [capped, cursor, endpoint]);

  // Infinite scroll: one observer on the sentinel below the list.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || exhausted || capped || failed || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) void loadMore();
      },
      { rootMargin: `${FEED_PREFETCH_MARGIN_PX}px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [capped, exhausted, failed, loadMore]);

  const visible = useMemo(() => rankFeed(filterEntries(entries, category), { now }), [entries, category, now]);
  const pinned = useMemo(() => selectPinned(visible, now), [visible, now]);
  const stream = useMemo(() => {
    const pinnedIds = new Set(pinned.map((entry) => entry.id));
    return visible.filter((entry) => !pinnedIds.has(entry.id));
  }, [visible, pinned]);

  useFeedLogging(listRef, { enabled: loggingEnabled, key: `${category}:${visible.length}:${pinned.length}` });

  const onCategory = (next: string) => {
    setCategory(next);
    logFeedEvent(loggingEnabled, { eventType: "filter_change", metadata: { surface: FEED_SURFACE, filter: "category", value: next } });
  };
  const onOpen = (entry: FeedEntryModel) =>
    logFeedEvent(loggingEnabled, { eventType: "view_person", personId: entry.person.id, metadata: { source: "feed_tap", entry_id: entry.id, kind: entry.kind } });
  const onExpand = (entry: FeedEntryModel, expanded: boolean) => {
    if (!expanded) return;
    const signalId = entry.kind === "signal" ? entry.evidence[0]?.id : undefined;
    logFeedEvent(loggingEnabled, {
      eventType: "expand_signal",
      personId: entry.person.id,
      metadata: { ...(signalId ? { signal_id: signalId } : {}), headline: entry.text.slice(0, 200), kind: entry.kind, entry_id: entry.id, surface: FEED_SURFACE },
    });
  };

  if (entries.length === 0) {
    return (
      <div className={cn("flex flex-col gap-10", className)}>
        <FeedEmpty roster={roster} />
      </div>
    );
  }

  const categoryName = categories.find((option) => option.value === category)?.label ?? categoryLabel(category);

  return (
    <div ref={listRef} className={cn("flex flex-col gap-10", className)}>
      <CategoryFilter options={categories} value={category} onChange={onCategory} />

      {pinned.length > 0 ? (
        <section className="flex flex-col gap-4" aria-label="Notable moves">
          <SectionHeader title="Notable moves" meta="Last 24h" />
          <Card className="flex flex-col divide-y divide-line">
            {pinned.map((entry, index) => (
              <FeedEntry key={entry.id} entry={entry} position={index} prominent now={now} onOpen={onOpen} onExpand={onExpand} />
            ))}
          </Card>
        </section>
      ) : null}

      <section className="flex flex-col gap-4" aria-label="Latest">
        <SectionHeader title="Latest" meta="Newest first" />

        {stream.length === 0 && !loading ? (
          <Card tone="ghost">
            <p className="px-6 py-10 text-center text-sm text-fg-muted">Nothing from {categoryName} on the wire yet.</p>
          </Card>
        ) : (
          <Card className="flex flex-col divide-y divide-line">
            {stream.map((entry, index) => (
              <FeedEntry key={entry.id} entry={entry} position={pinned.length + index} now={now} onOpen={onOpen} onExpand={onExpand} />
            ))}
            {/* The next page's rows take shape in place, inside the same card, so nothing jumps when they land. */}
            {loading ? (
              <>
                <SkeletonFeedItem />
                <SkeletonFeedItem />
              </>
            ) : null}
          </Card>
        )}

        {failed ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="text-sm text-fg-muted">Older entries did not come through.</p>
            <Button variant="outline" size="sm" onClick={() => void loadMore()}>
              Try again
            </Button>
          </div>
        ) : null}

        {!loading && !failed && (exhausted || capped) ? (
          <p className="py-4 text-center text-xs text-fg-faint">
            {capped ? (
              <>
                Showing the latest <span className="num">{FEED_MAX_ENTRIES}</span> entries.
              </>
            ) : (
              "That is everything on the wire."
            )}
          </p>
        ) : null}

        <div ref={sentinelRef} aria-hidden className="h-px" />
      </section>
    </div>
  );
}
