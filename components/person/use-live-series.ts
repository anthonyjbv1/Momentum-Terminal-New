"use client";

import { useCallback, useRef, useState } from "react";

import { useTickPolling } from "@/components/engine/use-tick-polling";
import { LIVE_TICK_MS, latestTickAt } from "@/lib/person/live-series";
import { applyTradeQuote, mergeLiveResponse, type LiveResponse, type LiveState } from "@/lib/person/live-state";
import type { ProfilePerson, SeriesByRange } from "@/lib/person/profile-model";
import type { TradeQuote } from "@/lib/trading/model";

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
 * that brings no new tick but a new book still updates the quotes.
 *
 * AN ORDER'S OWN QUOTE (Phase 29e). `applyQuote` puts the book place_order()
 * returned — with a fill or a refusal — straight into the state, and
 * `refresh` asks for the live book now rather than at the next tick (the
 * trade sheet does both). lib/person/live-state.ts has the rule for which of
 * a poll and a quote is newer.
 */

export { LIVE_POLL_DELAY_MS, LIVE_RETRY_DELAY_MS } from "@/components/engine/use-tick-polling";
export type { LiveState } from "@/lib/person/live-state";

export interface LiveSeriesOptions {
  /** Defaults to /api/person/[slug]/live. */
  endpoint?: string;
  /** The Engine's cadence; defaults to the real 30 seconds. */
  cadenceMs?: number;
  /** Off switch (e.g. when the person has been deactivated). */
  enabled?: boolean;
}

export interface LiveSeries {
  state: LiveState;
  /** An order's quote, from a fill or a refusal: the book as the server read it. */
  applyQuote: (quote: TradeQuote) => void;
  /** Read the live book now. A poll already in flight is followed by one more. */
  refresh: () => void;
}

export function useLiveSeries(person: ProfilePerson, initial: SeriesByRange, options: LiveSeriesOptions = {}): LiveSeries {
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
  const again = useRef(false);
  // One sequence for polls sent and quotes applied: a poll numbered below
  // the latest applied quote may have read the market before that order.
  const sequence = useRef(0);
  const quoteSequence = useRef(0);

  const poll = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      if (inFlight.current || typeof document === "undefined" || document.visibilityState === "hidden") return false;
      inFlight.current = true;
      sequence.current += 1;
      const sent = sequence.current;
      try {
        const url = new URL(endpoint, window.location.origin);
        if (cursor.current) url.searchParams.set("after", cursor.current);
        const response = await fetch(url.toString(), { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return false;
        const body = (await response.json()) as Partial<LiveResponse>;
        const ticks = Array.isArray(body.ticks) ? body.ticks : [];
        if (ticks.length > 0) cursor.current = ticks[ticks.length - 1].at;
        const bookIsCurrent = sent > quoteSequence.current;
        setState((previous) => mergeLiveResponse(previous, body, { now: Date.now(), bookIsCurrent }));
        return ticks.length > 0;
      } catch {
        return false;
      } finally {
        inFlight.current = false;
        if (again.current) {
          again.current = false;
          void run();
        }
      }
    };
    return run();
  }, [endpoint]);

  useTickPolling(poll, { cadenceMs, enabled });

  const applyQuote = useCallback((quote: TradeQuote) => {
    sequence.current += 1;
    quoteSequence.current = sequence.current;
    setState((previous) => applyTradeQuote(previous, quote, Date.now()));
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    void poll();
  }, [enabled, poll]);

  return { state, applyQuote, refresh };
}
