"use client";

import { useEffect, useRef, type RefObject } from "react";

import { startDwell, trackEvent } from "@/lib/behavioral/client";

/**
 * Behavioural logging for the Feed (Phase 5 vocabulary, extended in 6d).
 *
 *   view_feed      once, when the stream mounts                    { feed }
 *   view_entry     an entry at least half in view, once per entry  { entry_id, kind, feed, position, pinned }
 *   time_spent     for as long as an entry stays in view           { surface, entry_id, kind, duration_ms }
 *   scroll_depth   at 25 / 50 / 75 / 100 % of the page, and the    { feed, depth_pct, entries_seen }
 *                  furthest point reached when the stream unmounts
 *   expand_signal  an entry's detail opened                        (logged by the stream)
 *   filter_change  the category filter changed                     (logged by the stream)
 *   view_person    a tap through to a person, with its entry       (logged by the stream)
 *
 * Impressions come from one IntersectionObserver over the whole stream, not
 * from scroll arithmetic. Everything is fire-and-forget through the client
 * queue, which batches and coalesces, so a fast scroll costs one request per
 * couple of seconds rather than one per entry, and nothing here can block or
 * jank the scroll.
 */

export const FEED_SURFACE = "feed";

/** An entry must be at least this visible before it counts as seen. */
const IMPRESSION_RATIO = 0.5;

const DEPTH_MILESTONES = [25, 50, 75, 100];

export interface FeedLoggingOptions {
  /** Off when nobody is signed in — those events would only 401. */
  enabled: boolean;
  /** Re-scan the container when this changes (entries loaded, filter applied). */
  key: string;
}

export function useFeedLogging(containerRef: RefObject<HTMLElement | null>, { enabled, key }: FeedLoggingOptions): void {
  const seen = useRef(new Set<string>());
  const maxDepth = useRef(0);
  const milestonesLogged = useRef(new Set<number>());

  // view_feed once per mount.
  useEffect(() => {
    if (enabled) trackEvent({ eventType: "view_feed", metadata: { feed: FEED_SURFACE } });
  }, [enabled]);

  // Impressions and dwell.
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || typeof IntersectionObserver === "undefined") return;

    const dwells = new Map<string, () => void>();
    const stopDwell = (entryId: string) => {
      const stop = dwells.get(entryId);
      if (stop) {
        dwells.delete(entryId);
        stop();
      }
    };

    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const element = record.target as HTMLElement;
          const entryId = element.dataset.entryId;
          const personId = element.dataset.personId;
          const kind = element.dataset.entryKind;
          if (!entryId || !personId || !kind) continue;

          if (record.isIntersecting && record.intersectionRatio >= IMPRESSION_RATIO) {
            if (!seen.current.has(entryId)) {
              seen.current.add(entryId);
              trackEvent({
                eventType: "view_entry",
                personId,
                metadata: {
                  entry_id: entryId,
                  kind,
                  feed: FEED_SURFACE,
                  position: Number(element.dataset.entryPosition ?? 0),
                  pinned: element.dataset.entryPinned === "true",
                },
              });
            }
            if (!dwells.has(entryId)) {
              dwells.set(entryId, startDwell({ personId, surface: FEED_SURFACE, metadata: { entry_id: entryId, kind } }));
            }
          } else {
            stopDwell(entryId);
          }
        }
      },
      { threshold: [0, IMPRESSION_RATIO] },
    );

    for (const element of container.querySelectorAll<HTMLElement>("[data-entry-id]")) observer.observe(element);

    return () => {
      observer.disconnect();
      for (const entryId of [...dwells.keys()]) stopDwell(entryId);
    };
  }, [containerRef, enabled, key]);

  // Scroll depth: milestones as they are crossed, the furthest point on the way out.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const seenEntries = seen.current;
    const logged = milestonesLogged.current;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = document.documentElement.scrollHeight;
      if (height <= 0) return;
      const depth = Math.min(100, Math.max(0, Math.round(((window.scrollY + window.innerHeight) / height) * 100)));
      if (depth <= maxDepth.current) return;
      maxDepth.current = depth;
      for (const milestone of DEPTH_MILESTONES) {
        if (depth >= milestone && !logged.has(milestone)) {
          logged.add(milestone);
          trackEvent({ eventType: "scroll_depth", metadata: { feed: FEED_SURFACE, depth_pct: milestone, entries_seen: seenEntries.size } });
        }
      }
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      const depth = maxDepth.current;
      if (depth > 0 && !logged.has(depth)) {
        trackEvent({ eventType: "scroll_depth", metadata: { feed: FEED_SURFACE, depth_pct: depth, entries_seen: seenEntries.size, final: true } });
      }
    };
  }, [enabled]);
}

/** One-off events from the stream. Safe to call when logging is off; it just no-ops. */
export function logFeedEvent(enabled: boolean, event: Parameters<typeof trackEvent>[0]): void {
  if (enabled) trackEvent(event);
}
