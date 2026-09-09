"use client";

import { useEffect } from "react";

import { startDwell, trackEvent } from "@/lib/behavioral/client";

/**
 * Behavioural logging for the profile page (Phase 5 vocabulary).
 *
 *   view_person   once, when the page mounts
 *   time_spent    the dwell, paused while the tab is hidden, closed on unmount
 *
 * Range changes and signal expands are logged where they happen, through
 * `logProfileEvent`. Everything is fire-and-forget: `trackEvent` never throws
 * and never awaits, so logging cannot slow down or break the page.
 */

export const PROFILE_SURFACE = "profile";

export function useProfileLogging(personId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    trackEvent({ eventType: "view_person", personId, metadata: { source: PROFILE_SURFACE } });

    // Dwell counts only while the tab is actually visible: a profile left open
    // in a background tab overnight is not eight hours of attention.
    let stop: (() => void) | null = document.visibilityState === "hidden" ? null : startDwell({ personId, surface: PROFILE_SURFACE });

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop?.();
        stop = null;
      } else if (!stop) {
        stop = startDwell({ personId, surface: PROFILE_SURFACE });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop?.();
    };
  }, [personId, enabled]);
}

/** One-off events from the page. Safe to call when logging is off; it just no-ops. */
export function logProfileEvent(enabled: boolean, event: Parameters<typeof trackEvent>[0]): void {
  if (enabled) trackEvent(event);
}

/** Renders nothing; mounts the page-level logging from a Server Component. */
export function ProfileLogger({ personId, enabled }: { personId: string; enabled: boolean }) {
  useProfileLogging(personId, enabled);
  return null;
}
