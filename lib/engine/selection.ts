import type { EngineConfig } from "@/lib/engine/config";
import { isMetricSignal } from "@/lib/engine/sentiment/metric";
import type { EngineSignal } from "@/lib/engine/types";
import type { Json } from "@/types/database";

/**
 * WHICH OF THE UNPROCESSED SIGNALS ONE TICK TAKES ON.
 *
 * The store reads the backlog oldest-first up to a ceiling; this decides how
 * much of it a tick is allowed to score, in the shape of the model calls it
 * will cost:
 *
 *   - metric and baseline signals are FREE (they never reach the model) and
 *     are all taken;
 *   - event signals are taken oldest-first, at most
 *     maxEventSignalsPerPersonPerTick per person (ONE CHUNK: the rule that
 *     stops one subject's backlog owning the tick) and at most
 *     maxEventSignalsPerTick in total (one wave of the pool).
 *
 * Whatever is not selected is not touched: it stays unprocessed and the next
 * tick, thirty seconds later, sees it again. A backlog drains across ticks
 * instead of being scored in one tick that never commits.
 */

export interface TickSelection {
  selected: EngineSignal[];
  /** Loaded but not selected this tick: still unprocessed after it. */
  leftBehind: number;
  eventSignals: number;
  freeSignals: number;
}

function kindOf(payload: Json | null): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const kind = payload.kind;
  return typeof kind === "string" ? kind : null;
}

/** A signal the model never sees, so it costs the tick nothing. */
export function isFreeSignal(signal: Pick<EngineSignal, "rawPayload">): boolean {
  return isMetricSignal(signal.rawPayload) || kindOf(signal.rawPayload) === "baseline";
}

/**
 * `isFree` names the signals that cost the tick nothing and are therefore
 * all taken: metric and baseline by default; the tick also passes expired
 * event signals (past the freshness limit), which are processed with zero
 * impact and no model call.
 */
export function selectTickSignals(loaded: EngineSignal[], config: EngineConfig["tick"], isFree: (signal: EngineSignal) => boolean = isFreeSignal): TickSelection {
  const selected: EngineSignal[] = [];
  const perPerson = new Map<string, number>();
  let eventSignals = 0;
  let freeSignals = 0;

  for (const signal of loaded) {
    if (isFree(signal)) {
      selected.push(signal);
      freeSignals += 1;
      continue;
    }
    const taken = perPerson.get(signal.personId) ?? 0;
    if (taken >= config.maxEventSignalsPerPersonPerTick) continue;
    if (eventSignals >= config.maxEventSignalsPerTick) continue;
    perPerson.set(signal.personId, taken + 1);
    selected.push(signal);
    eventSignals += 1;
  }

  return { selected, leftBehind: loaded.length - selected.length, eventSignals, freeSignals };
}
