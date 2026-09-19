import "server-only";

import { cache } from "react";

import { DEFAULT_ENGINE_CONFIG } from "@/lib/engine/config";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

/**
 * THE BOARD'S PULSE, as the banner shows it (Phase 19+): Market Mood at the
 * latest tick, and whether the Engine is still ticking.
 *
 * The banner carried a Mood indicator from Phase 6a but was never wired to a
 * reading — it passed null, so it always said "—". Windowing the mood is what
 * makes wiring it worth doing: a per-tick reading was 0.00 on 96.5% of ticks,
 * and an indicator that is flat whatever happens is decoration. The windowed
 * value is present on 99.8% of ticks and changes about three times an hour.
 *
 * One indexed row per request, deduplicated within it by cache(). The value
 * is rendered by the server, so it is as fresh as the page: it follows
 * navigation rather than polling, which at three changes an hour is honest
 * enough and costs the board nothing.
 */

export interface BoardPulse {
  /** Market Mood over the Engine's trailing window, in score points. Null before the first tick, or if the read fails. */
  mood: number | null;
  /** When the tick that produced it started. */
  at: string | null;
  status: "live" | "standby";
  /** The window the mood was read over, for the indicator's description. */
  windowMinutes: number;
}

/**
 * How stale the newest tick may be before the Engine reads as on standby.
 * Six tick intervals: a cron minute can be missed without the banner
 * flickering, but a stopped Engine shows within three minutes.
 */
export const STANDBY_AFTER_TICK_INTERVALS = 6;

const OFFLINE: BoardPulse = { mood: null, at: null, status: "standby", windowMinutes: DEFAULT_ENGINE_CONFIG.marketMood.windowMinutes };

export function readBoardPulse(row: { mood: number | string | null; started_at: string } | null, now: number, config = DEFAULT_ENGINE_CONFIG): BoardPulse {
  if (!row) return OFFLINE;
  const startedAt = Date.parse(row.started_at);
  if (!Number.isFinite(startedAt)) return OFFLINE;
  const mood = row.mood === null ? null : Number(row.mood);
  const staleAfterMs = STANDBY_AFTER_TICK_INTERVALS * config.tick.intervalSeconds * 1000;
  return {
    mood: mood !== null && Number.isFinite(mood) ? mood : null,
    at: new Date(startedAt).toISOString(),
    status: now - startedAt <= staleAfterMs ? "live" : "standby",
    windowMinutes: config.marketMood.windowMinutes,
  };
}

/** The latest tick's mood and the Engine's liveness. Never throws: the banner degrades to "—" on standby. */
export const getBoardPulse = cache(async (): Promise<BoardPulse> => {
  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.from("engine_ticks").select("mood, started_at").order("tick_number", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    return readBoardPulse(data, Date.now());
  } catch (error) {
    console.warn("[shell] board pulse unavailable:", error instanceof Error ? error.message : error);
    return OFFLINE;
  }
});
