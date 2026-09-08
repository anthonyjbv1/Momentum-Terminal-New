"use client";

import { useSyncExternalStore } from "react";

/**
 * The Engine clock: how long until the next 30-second tick.
 *
 * Ticks are aligned to wall-clock multiples of 30 s (…:00 and …:30 of every
 * minute), which is exactly the cadence the cron heartbeat runs on: one
 * invocation per minute, second tick 30 s in. So the countdown is
 * deterministic, identical on every client, and needs no server round trip.
 * When the heartbeat is live, `people.last_tick_at` can be used to nudge the
 * anchor; the API here will not change.
 *
 * A single module-level store feeds every timer on the page through
 * useSyncExternalStore, so all of them update on the same frame.
 */

export const TICK_SECONDS = 30;
/** Seconds left at which the timer switches to its urgent treatment. */
export const URGENT_SECONDS = 5;

/** Whole seconds until the next tick boundary: TICK_SECONDS … 1. */
export function secondsUntilNextTick(nowMs: number, tickSeconds: number = TICK_SECONDS): number {
  const elapsed = Math.floor(nowMs / 1000) % tickSeconds;
  return tickSeconds - elapsed;
}

/** Milliseconds until the next tick boundary, for smooth progress. */
export function msUntilNextTick(nowMs: number, tickSeconds: number = TICK_SECONDS): number {
  const period = tickSeconds * 1000;
  return period - (nowMs % period);
}

const listeners = new Set<() => void>();
let snapshot: number | null = null;
let interval: ReturnType<typeof setInterval> | null = null;

function refresh() {
  const next = secondsUntilNextTick(Date.now());
  if (next !== snapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (interval === null) {
    refresh();
    interval = setInterval(refresh, 200);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

function getSnapshot(): number {
  if (snapshot === null) snapshot = secondsUntilNextTick(Date.now());
  return snapshot;
}

function getServerSnapshot(): number {
  return TICK_SECONDS;
}

export interface EngineClock {
  /** Whole seconds until the next tick, TICK_SECONDS … 1. */
  secondsLeft: number;
  tickSeconds: number;
  /** 0 at the start of a cycle, approaching 1 just before the tick. */
  progress: number;
  /** True in the last few seconds of a cycle. */
  urgent: boolean;
  /** True on the first second of a fresh cycle (a tick just happened). */
  justTicked: boolean;
}

export function useEngineClock(): EngineClock {
  const secondsLeft = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    secondsLeft,
    tickSeconds: TICK_SECONDS,
    progress: (TICK_SECONDS - secondsLeft) / TICK_SECONDS,
    urgent: secondsLeft <= URGENT_SECONDS,
    justTicked: secondsLeft === TICK_SECONDS,
  };
}

/** "0:27" — the terminal's clock face. */
export function formatCountdown(secondsLeft: number): string {
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
