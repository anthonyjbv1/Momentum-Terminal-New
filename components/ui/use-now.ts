"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A coarse clock for render: the current time rounded down to `everyMs`,
 * re-read on that cadence, so a component that asks "has this halt lapsed?"
 * notices without a reload and without calling Date.now() in render. On the
 * server and during hydration it is the server's own render time, so the
 * first paint agrees with the HTML; the first client snapshot then takes
 * over.
 */
export function useNow(serverNow: number, everyMs = 15_000): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const id = window.setInterval(onChange, everyMs);
      return () => window.clearInterval(id);
    },
    [everyMs],
  );
  const getSnapshot = useCallback(() => Math.floor(Date.now() / everyMs) * everyMs, [everyMs]);
  const getServerSnapshot = useCallback(() => serverNow, [serverNow]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
