"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { useTickPolling } from "@/components/engine/use-tick-polling";
import { isStale, parseFeaturedPayload, type FeaturedPayload } from "@/lib/landing/model";

/**
 * The featured score, kept current on the Engine's cadence for every part of
 * the page that shows it (the hero, the forces, the history).
 *
 * The polling schedule is the app's own (useTickPolling: a little after each
 * 30-second boundary, one retry, catch-up on return from the background), so
 * a landing-page visitor and a signed-in member watching a profile see the
 * same tick land at the same moment.
 *
 * THE KILL SWITCH IS BUILT IN. An answer that fails — a 503, a network
 * error, a body that does not parse — changes nothing on screen except the
 * label: the last payload received stays, and `live` turns false so the hero
 * says "Last known" with the time of that payload's tick. Nothing is ever
 * invented to fill the gap; when the endpoint answers again, `live` returns.
 */

export interface FeaturedState {
  payload: FeaturedPayload | null;
  /** True when the last poll (or the initial render) succeeded AND the tick is recent. */
  live: boolean;
  /** Bumps when a newer tick arrives; what a flash animates on. */
  version: number;
  /** When the payload on screen was received, in browser time. */
  receivedAt: number | null;
  /** True when the feed has failed since the payload on screen arrived. */
  failed: boolean;
}

interface FeaturedContextValue extends FeaturedState {
  now: number;
}

const FeaturedContext = createContext<FeaturedContextValue | null>(null);

export interface FeaturedProviderProps {
  initial: FeaturedPayload | null;
  /** Server render time, so ages agree between server and client. */
  renderedAt: number;
  /** Defaults to the public endpoint; harnesses point it elsewhere. */
  endpoint?: string;
  /** The Engine's cadence; defaults to the real 30 seconds. */
  cadenceMs?: number;
  children: ReactNode;
}

export function FeaturedProvider({ initial, renderedAt, endpoint = "/api/public/featured", cadenceMs, children }: FeaturedProviderProps) {
  const [state, setState] = useState<FeaturedState>(() => ({
    payload: initial,
    live: initial !== null && !isStale(initial.lastTickAt, renderedAt),
    version: 0,
    receivedAt: initial ? renderedAt : null,
    failed: false,
  }));
  const inFlight = useRef(false);

  const poll = useCallback(async (): Promise<boolean> => {
    if (inFlight.current || typeof document === "undefined" || document.visibilityState === "hidden") return false;
    inFlight.current = true;
    try {
      const response = await fetch(endpoint, { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = parseFeaturedPayload(await response.json());
      if (!payload) throw new Error("unparseable payload");
      const now = Date.now();
      let landed = false;
      setState((previous) => {
        landed = previous.payload === null || payload.tickNumber !== previous.payload.tickNumber || payload.score !== previous.payload.score;
        return {
          payload,
          live: !isStale(payload.lastTickAt, now),
          version: landed ? previous.version + 1 : previous.version,
          receivedAt: now,
          failed: false,
        };
      });
      return landed;
    } catch {
      // Keep what is on screen; only the label changes.
      setState((previous) => ({ ...previous, live: false, failed: true }));
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [endpoint]);

  useTickPolling(poll, { cadenceMs });

  const value = useMemo<FeaturedContextValue>(() => ({ ...state, now: renderedAt }), [state, renderedAt]);
  return <FeaturedContext.Provider value={value}>{children}</FeaturedContext.Provider>;
}

export function useFeatured(): FeaturedContextValue {
  const value = useContext(FeaturedContext);
  if (!value) throw new Error("useFeatured must be used inside FeaturedProvider");
  return value;
}
