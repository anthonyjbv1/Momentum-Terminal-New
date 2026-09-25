"use client";

import { useSyncExternalStore } from "react";

/**
 * An absolute time in the reader's own timezone, hydration-safe: the server
 * renders it in UTC (and says so), and the browser swaps in the local
 * rendering the moment it takes over, through useSyncExternalStore's
 * server snapshot. No mismatch warning, no flash of the wrong zone.
 */
const local = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const utc = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const localClock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const utcClock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

const subscribe = () => () => {};

export function formatLocalTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "—" : local.format(time);
}

export function formatUtcTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "—" : `${utc.format(time)} UTC`;
}

/**
 * A clock time only ("2:51 PM"), for "halted until …" (Phase 29b). Same rule
 * as LocalTime: the server renders UTC and says so, the browser swaps in the
 * reader's zone, and hydration never sees two different strings.
 */
export function LocalClock({ iso, className }: { iso: string; className?: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => {
      const time = Date.parse(iso);
      return Number.isNaN(time) ? "—" : localClock.format(time);
    },
    () => {
      const time = Date.parse(iso);
      return Number.isNaN(time) ? "—" : `${utcClock.format(time)} UTC`;
    },
  );
  return (
    <time dateTime={iso} className={className}>
      {text}
    </time>
  );
}

export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => formatLocalTime(iso),
    () => formatUtcTime(iso),
  );
  return (
    <time dateTime={iso} className={className}>
      {text}
    </time>
  );
}
