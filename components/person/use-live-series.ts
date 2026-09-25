"use client";

import { useCallback, useRef, useState } from "react";

import { useTickPolling } from "@/components/engine/use-tick-polling";
import { LIVE_TICK_MS, foldTicksIntoRanges, latestTickAt, type LiveTick } from "@/lib/person/live-series";
import type { ProfilePerson, SeriesByRange, TradingMode } from "@/lib/person/profile-model";

/**
 * Keeps a person's score, market price and series current on the Engine's
 * cadence.
 *
 * The polling schedule (a little after each 30-second boundary, one retry,
 * catch-up on return from the background) is useTickPolling's. Every answer
 * that carries new ticks bumps `version`, which is what the chart animates
 * on. With the Engine dormant every poll comes back empty and nothing here
 * changes: the page stays exactly as the server rendered it.
 *
 * THE MARKET STATE (Phase 29) rides along: the premium, the market price,
 * the dealer's inventory, the trading mode and any halt. The premium can
 * move between ticks (an order moved it) and at a tick (decay), so a poll
 * that brings no new tick but a new premium still updates the quotes.
 */

export { LIVE_POLL_DELAY_MS, LIVE_RETRY_DELAY_MS } from "@/components/engine/use-tick-polling";

export interface LiveState {
  series: SeriesByRange;
  score: number;
  lastTickAt: string | null;
  buyPrice: number | null;
  sellPrice: number | null;
  spread: number;
  /** The premium in cents per share, and the market price in points (score + premium). */
  premiumCents: number;
  marketPrice: number;
  inventoryUnits: number;
  tradingMode: TradingMode;
  haltedUntil: string | null;
  haltReason: string | null;
  /** Increments whenever new ticks arrive. */
  version: number;
  /** When the state last changed, for relative ages. */
  updatedAt: number | null;
}

interface LiveResponse {
  score: number;
  lastTickAt: string | null;
  buyPrice: number | null;
  sellPrice: number | null;
  spread: number;
  premiumCents: number;
  marketPrice: number;
  inventoryUnits: number;
  tradingMode: string;
  haltedUntil: string | null;
  haltReason: string | null;
  ticks: LiveTick[];
}

export interface LiveSeriesOptions {
  /** Defaults to /api/person/[slug]/live. */
  endpoint?: string;
  /** The Engine's cadence; defaults to the real 30 seconds. */
  cadenceMs?: number;
  /** Off switch (e.g. when the person has been deactivated). */
  enabled?: boolean;
}

function toTradingMode(value: unknown, fallback: TradingMode): TradingMode {
  return value === "display_only" || value === "paused" || value === "tradeable" ? value : fallback;
}

export function useLiveSeries(person: ProfilePerson, initial: SeriesByRange, options: LiveSeriesOptions = {}): LiveState {
  const endpoint = options.endpoint ?? `/api/person/${person.slug}/live`;
  const cadenceMs = options.cadenceMs ?? LIVE_TICK_MS;
  const enabled = options.enabled ?? true;

  const [state, setState] = useState<LiveState>(() => ({
    series: initial,
    score: person.score,
    lastTickAt: person.lastTickAt,
    buyPrice: person.buyPrice,
    sellPrice: person.sellPrice,
    spread: person.spread,
    premiumCents: person.premiumCents,
    marketPrice: person.marketPrice,
    inventoryUnits: person.inventoryUnits,
    tradingMode: person.tradingMode,
    haltedUntil: person.haltedUntil,
    haltReason: person.haltReason,
    version: 0,
    updatedAt: null,
  }));
  const cursor = useRef<string | null>(latestTickAt(initial));
  const inFlight = useRef(false);

  const poll = useCallback(async (): Promise<boolean> => {
    if (inFlight.current || typeof document === "undefined" || document.visibilityState === "hidden") return false;
    inFlight.current = true;
    try {
      const url = new URL(endpoint, window.location.origin);
      if (cursor.current) url.searchParams.set("after", cursor.current);
      const response = await fetch(url.toString(), { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return false;
      const body = (await response.json()) as Partial<LiveResponse>;
      const ticks = Array.isArray(body.ticks) ? body.ticks : [];
      const score = typeof body.score === "number" && Number.isFinite(body.score) ? body.score : null;
      const premium = typeof body.premiumCents === "number" && Number.isFinite(body.premiumCents) ? Math.trunc(body.premiumCents) : null;
      const haltedUntil = typeof body.haltedUntil === "string" ? body.haltedUntil : body.haltedUntil === null ? null : undefined;
      if (ticks.length > 0) cursor.current = ticks[ticks.length - 1].at;

      setState((previous) => {
        const scoreChanged = score !== null && score !== previous.score;
        const premiumChanged = premium !== null && premium !== previous.premiumCents;
        const modeChanged = (body.tradingMode !== undefined && toTradingMode(body.tradingMode, previous.tradingMode) !== previous.tradingMode) || (haltedUntil !== undefined && haltedUntil !== previous.haltedUntil);
        if (ticks.length === 0 && !scoreChanged && !premiumChanged && !modeChanged) return previous;
        const now = Date.now();
        return {
          series: ticks.length > 0 ? foldTicksIntoRanges(previous.series, ticks, now) : previous.series,
          score: score ?? previous.score,
          lastTickAt: body.lastTickAt ?? previous.lastTickAt,
          buyPrice: typeof body.buyPrice === "number" ? body.buyPrice : previous.buyPrice,
          sellPrice: typeof body.sellPrice === "number" ? body.sellPrice : previous.sellPrice,
          spread: typeof body.spread === "number" ? body.spread : previous.spread,
          premiumCents: premium ?? previous.premiumCents,
          marketPrice: typeof body.marketPrice === "number" && Number.isFinite(body.marketPrice) ? body.marketPrice : previous.marketPrice,
          inventoryUnits: typeof body.inventoryUnits === "number" && Number.isFinite(body.inventoryUnits) ? Math.trunc(body.inventoryUnits) : previous.inventoryUnits,
          tradingMode: toTradingMode(body.tradingMode, previous.tradingMode),
          haltedUntil: haltedUntil === undefined ? previous.haltedUntil : haltedUntil,
          haltReason: haltedUntil === undefined ? previous.haltReason : typeof body.haltReason === "string" ? body.haltReason : null,
          version: previous.version + (ticks.length > 0 ? 1 : 0),
          updatedAt: now,
        };
      });
      return ticks.length > 0;
    } catch {
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [endpoint]);

  useTickPolling(poll, { cadenceMs, enabled });

  return state;
}
