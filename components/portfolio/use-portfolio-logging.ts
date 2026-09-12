"use client";

import { useEffect } from "react";

import { startDwell, trackEvent } from "@/lib/behavioral/client";

/**
 * Behavioural logging for the portfolio (Phase 5 vocabulary, extended in 6f).
 *
 *   view_portfolio     once, when the page mounts            { positions, orders }
 *   time_spent         the dwell, paused while the tab is    { surface: "portfolio" }
 *                      hidden, closed on leaving; about no
 *                      single person, so it carries the
 *                      surface instead
 *   view_person        a tap through to a person, with       { source: portfolio_position | portfolio_history }
 *                      where it came from                    (logged by the lists)
 *   filter_change      the value chart's range               { surface: "portfolio", filter: "range", value }
 *   open_trade_sheet   a close started here rather than on   { side: "SELL", surface: "portfolio" }
 *   abandon_trade_sheet the profile: the surface is what     (logged by the sheet)
 *   close_position     distinguishes the two                 (logged by the order route, surface: "portfolio")
 *
 * Everything is fire-and-forget through the client queue: nothing here can
 * block or break the page.
 */

export const PORTFOLIO_SURFACE = "portfolio";

export function usePortfolioLogging(enabled: boolean, counts: { positions: number; orders: number }): void {
  const { positions, orders } = counts;
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    trackEvent({ eventType: "view_portfolio", metadata: { positions, orders } });

    let stop: (() => void) | null = document.visibilityState === "hidden" ? null : startDwell({ surface: PORTFOLIO_SURFACE });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop?.();
        stop = null;
      } else if (!stop) {
        stop = startDwell({ surface: PORTFOLIO_SURFACE });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop?.();
    };
    // The counts describe the page on arrival; later changes are not new views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

/** One-off events from the page. Safe to call when logging is off; it just no-ops. */
export function logPortfolioEvent(enabled: boolean, event: Parameters<typeof trackEvent>[0]): void {
  if (enabled) trackEvent(event);
}
