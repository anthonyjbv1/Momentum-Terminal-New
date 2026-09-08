"use client";

import { useEffect, type RefObject } from "react";

import { startDwell, trackEvent } from "@/lib/behavioral/client";

/**
 * Behavioural logging for a list of people (Phase 5).
 *
 * Watches every `[data-person-id]` element inside the container and, as cards
 * scroll through the viewport, logs one `view_person` impression per person
 * and a `time_spent` dwell for as long as each stays visible. The client queue
 * batches and coalesces both, so a scroll down and back up costs one row per
 * person rather than a stream.
 *
 * Everything here is fire-and-forget: `trackEvent` never throws and never
 * awaits, so logging cannot slow down or break the board.
 */

/** A card must be at least this visible before it counts as seen. */
const IMPRESSION_RATIO = 0.5;

export interface ImpressionOptions {
  /** Off when nobody is signed in — those events would only 401. */
  enabled: boolean;
  /** Recorded on both event types, so Home is distinguishable from other surfaces. */
  surface: string;
  /** Re-scan the container when this changes (e.g. the filtered person list). */
  key: string;
}

export function usePersonImpressions(containerRef: RefObject<HTMLElement | null>, { enabled, surface, key }: ImpressionOptions): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || typeof IntersectionObserver === "undefined") return;

    const seen = new Set<string>();
    const dwells = new Map<string, () => void>();

    const stopDwell = (personId: string) => {
      const stop = dwells.get(personId);
      if (stop) {
        dwells.delete(personId);
        stop();
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const personId = (entry.target as HTMLElement).dataset.personId;
          if (!personId) continue;

          if (entry.isIntersecting && entry.intersectionRatio >= IMPRESSION_RATIO) {
            if (!seen.has(personId)) {
              seen.add(personId);
              trackEvent({ eventType: "view_person", personId, metadata: { source: surface } });
            }
            if (!dwells.has(personId)) dwells.set(personId, startDwell({ personId, surface }));
          } else {
            stopDwell(personId);
          }
        }
      },
      { threshold: [0, IMPRESSION_RATIO] },
    );

    for (const element of container.querySelectorAll<HTMLElement>("[data-person-id]")) {
      observer.observe(element);
    }

    return () => {
      observer.disconnect();
      // Close any dwell still open when the list changes or the page unmounts.
      for (const personId of [...dwells.keys()]) stopDwell(personId);
    };
  }, [containerRef, enabled, surface, key]);
}

/** One-off events from the board. Safe to call when logging is off; it just no-ops. */
export function logBoardEvent(enabled: boolean, event: Parameters<typeof trackEvent>[0]): void {
  if (enabled) trackEvent(event);
}
