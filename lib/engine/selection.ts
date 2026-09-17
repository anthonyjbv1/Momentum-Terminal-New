import type { EngineConfig } from "@/lib/engine/config";
import { isMetricSignal } from "@/lib/engine/sentiment/metric";
import { isPrescoredSignal } from "@/lib/engine/sentiment/prescored";
import type { EngineSignal } from "@/lib/engine/types";
import type { Json } from "@/types/database";

/**
 * WHICH OF THE UNPROCESSED SIGNALS ONE TICK TAKES ON, AND IN WHAT ORDER.
 *
 * The store reads the backlog up to a ceiling; this decides how much of it a
 * tick is allowed to score, in the shape of the model calls it will cost:
 *
 *   - FREE signals (metric, baseline, prescored live moments, and — passed
 *     in by the tick — event signals past the freshness limit) are all
 *     taken. They cost no call.
 *   - LIVE event signals are taken NEWEST FIRST within a person, at most
 *     maxEventSignalsPerPersonPerTick (12, ONE CHUNK: the rule that stops
 *     one subject's backlog owning the tick) per person and at most
 *     maxEventSignalsPerTick (48, one wave of the pool) in total.
 *
 * NEWEST FIRST (Phase 12+). Selection used to be oldest-first, which was
 * right before freshness existed and wrong after it: the first ticks spent
 * their whole call budget on week-old signals weighted near zero while
 * yesterday's news waited. Within a person the freshest signals now go
 * first, so a call is spent where it moves a score.
 *
 * THE ROTATION. Which PEOPLE get a call this tick is a separate decision,
 * because "newest first" across people would let a subject with a steady
 * stream of fresh signals crowd out one whose newest signal is a few hours
 * old, forever. So people are ordered by when their event signals were LAST
 * PROCESSED: never (or not within the store's window) first, then least
 * recently served. A person served this tick goes to the back; a person
 * deferred keeps their place. With P people waiting, everyone is served
 * within ceil(P / callBudgetPerTick) ticks, whatever anyone's stream looks
 * like. Ties (the first tick, or people never served) go to the person with
 * the freshest waiting signal, then by id, so the order is deterministic.
 *
 * Whatever is not selected is not touched: it stays unprocessed and the next
 * tick sees it again. A backlog drains across ticks instead of being scored
 * in one tick that never commits.
 */

export interface TickSelection {
  selected: EngineSignal[];
  /** Loaded but not selected this tick: still unprocessed after it. */
  leftBehind: number;
  eventSignals: number;
  freeSignals: number;
  /** People with live event signals, in the order the tick will serve them. */
  personOrder: string[];
}

export interface SelectionOptions {
  /** Signals that cost the tick nothing and are all taken. Defaults to metric and baseline. */
  isFree?: (signal: EngineSignal) => boolean;
  /** When each person's event signals were last processed. A person absent here has never been served and goes first. */
  lastServedAt?: Map<string, Date>;
}

function kindOf(payload: Json | null): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const kind = payload.kind;
  return typeof kind === "string" ? kind : null;
}

/** A signal the model never sees, so it costs the tick nothing: a metric, a baseline, or a prescored live moment (Phase 16). */
export function isFreeSignal(signal: Pick<EngineSignal, "rawPayload">): boolean {
  return isMetricSignal(signal.rawPayload) || kindOf(signal.rawPayload) === "baseline" || isPrescoredSignal(signal.rawPayload);
}

/** Newest first, then id, so a batch stamped with one timestamp is cut the same way every time. */
function newestFirst(a: EngineSignal, b: EngineSignal): number {
  return b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id);
}

/** The people with live signals, least recently served first. */
export function orderPeople(byPerson: Map<string, EngineSignal[]>, lastServedAt: Map<string, Date> | undefined): string[] {
  const servedAt = (personId: string) => lastServedAt?.get(personId)?.getTime() ?? Number.NEGATIVE_INFINITY;
  return [...byPerson.keys()].sort((a, b) => {
    const sa = servedAt(a);
    const sb = servedAt(b);
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    // Never served, or served at the same instant: the freshest waiting signal first.
    const newest = newestFirst(byPerson.get(a)![0], byPerson.get(b)![0]);
    return newest !== 0 ? newest : a.localeCompare(b);
  });
}

export function selectTickSignals(loaded: EngineSignal[], config: EngineConfig["tick"], options: SelectionOptions = {}): TickSelection {
  const isFree = options.isFree ?? isFreeSignal;
  const selected: EngineSignal[] = [];
  const byPerson = new Map<string, EngineSignal[]>();
  let freeSignals = 0;

  for (const signal of loaded) {
    if (isFree(signal)) {
      selected.push(signal);
      freeSignals += 1;
      continue;
    }
    const list = byPerson.get(signal.personId) ?? [];
    list.push(signal);
    byPerson.set(signal.personId, list);
  }
  for (const list of byPerson.values()) list.sort(newestFirst);

  const personOrder = orderPeople(byPerson, options.lastServedAt);
  let eventSignals = 0;
  for (const personId of personOrder) {
    const room = config.maxEventSignalsPerTick - eventSignals;
    if (room <= 0) break;
    const take = byPerson.get(personId)!.slice(0, Math.min(config.maxEventSignalsPerPersonPerTick, room));
    selected.push(...take);
    eventSignals += take.length;
  }

  return { selected, leftBehind: loaded.length - selected.length, eventSignals, freeSignals, personOrder };
}
