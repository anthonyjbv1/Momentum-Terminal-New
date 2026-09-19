import type { EngineConfig } from "@/lib/engine/config";
import { clamp } from "@/lib/engine/math";
import type { ForceEntry } from "@/lib/engine/types";

/**
 * FORCE 3 — Market Mood (the board's tide).
 *
 * The mood is the platform-wide Signals movement over a TRAILING WINDOW
 * (Phase 19+), not this tick's alone. Signals arrive in fifteen-minute bursts
 * against two ticks a minute, so a per-tick reading was zero on 96.5% of
 * ticks: a tide that exists for one tick and is gone thirty seconds later is
 * a splash. The window reads "how has the board moved recently", which is
 * what the name promises.
 *
 *   mood = Σ Signals impact over the window / (people × readings)
 *
 * READINGS, not ticks, is the divisor: the ticks in the window that moved
 * anyone. Dividing by every tick in the window would bury each burst under
 * the 119 quiet ticks around it; dividing by the readings keeps the burst's
 * own magnitude and holds it for the window, decaying as old readings leave.
 * So the value stays on the scale the clamps were set for, and only its
 * FREQUENCY changes.
 *
 * Each person then receives, per tick,
 *
 *   impact = ratePerHour × sensitivity × deltaHours × clamp(mood_excluding_self, ±maxAbsMood)
 *
 * TIME-NORMALISED like Gravity: the rate is per hour and is multiplied by the
 * person's own elapsed hours, so the force is independent of the tick
 * cadence. A sustained value applied per tick would otherwise scale with the
 * tick interval, and changing the cadence would silently re-level the board.
 *
 * Brakes against cascade amplification, all kept from the per-tick version:
 *   - the mood is built from the Signals force only (never from scores that
 *     already contain mood, so it cannot feed back on itself)
 *   - a person's own signals are excluded from their own mood — which matters
 *     MORE with a window, since a burst now persists for the whole window
 *   - the mood and the impact are both clamped
 *
 * With no readings in the window the mood is 0 and the force is 0.
 */

/**
 * The board's Signals movement over the trailing window, with the current
 * tick folded in. Built by the tick from what the store loaded plus what this
 * tick just scored.
 */
export interface MoodWindow {
  /** Σ Signals-force impact across the board over the window. */
  totalImpact: number;
  /** Σ Signals-force impact over the window, per person id. */
  totalByPerson: Map<string, number>;
  /** Ticks in the window that moved anyone: the readings the mean is taken over. */
  readings: number;
  /** Active people the board mean is spread across. */
  people: number;
}

export const EMPTY_MOOD_WINDOW: MoodWindow = { totalImpact: 0, totalByPerson: new Map(), readings: 0, people: 0 };

/**
 * The part of the window the STORE loads: the ticks before this one, read
 * back from the Signals force's own audit trail. The tick folds its own
 * scoring in before anything reads the mood.
 */
export interface MoodWindowHistory {
  totalImpact: number;
  totalByPerson: Map<string, number>;
  /** Distinct earlier ticks in the window that moved anyone. */
  readings: number;
}

export const EMPTY_MOOD_WINDOW_HISTORY: MoodWindowHistory = { totalImpact: 0, totalByPerson: new Map(), readings: 0 };

/**
 * The window this tick sees: what the store loaded plus what this tick just
 * scored. A tick that moved nobody adds no reading — it is not a zero
 * reading of the tide, it is the absence of one.
 */
export function foldTickIntoWindow(history: MoodWindowHistory, tickImpactByPerson: Map<string, number>, people: number): MoodWindow {
  const totalByPerson = new Map(history.totalByPerson);
  let tickTotal = 0;
  let moved = false;
  for (const [personId, impact] of tickImpactByPerson) {
    if (impact === 0) continue;
    moved = true;
    tickTotal += impact;
    totalByPerson.set(personId, (totalByPerson.get(personId) ?? 0) + impact);
  }
  return {
    totalImpact: history.totalImpact + tickTotal,
    totalByPerson,
    readings: history.readings + (moved ? 1 : 0),
    people,
  };
}

/** The tide itself: the mean per-person Signals movement across the window's readings. */
export function windowedMood(window: MoodWindow): number {
  if (window.readings <= 0 || window.people <= 0) return 0;
  return window.totalImpact / (window.people * window.readings);
}

/**
 * The same tide with one person's own movement taken out, so a headline
 * cannot amplify itself through the board. Zero when the person is the only
 * one on the board: there is no "everyone else" to read.
 */
export function moodExcludingPerson(window: MoodWindow, personId: string): number {
  if (window.readings <= 0 || window.people <= 1) return 0;
  const own = window.totalByPerson.get(personId) ?? 0;
  return (window.totalImpact - own) / ((window.people - 1) * window.readings);
}

export interface MarketMoodInput {
  personId: string;
  personSlug: string;
  window: MoodWindow;
  /** The person's own elapsed hours since their last tick, as Gravity uses. */
  deltaHours: number;
  config: EngineConfig["marketMood"];
}

export function marketMoodForce({ personId, personSlug, window, deltaHours, config }: MarketMoodInput): ForceEntry {
  const moodExcludingSelf = clamp(moodExcludingPerson(window, personId), -config.maxAbsMood, config.maxAbsMood);
  const sensitivity = config.sensitivityBySlug[personSlug] ?? config.defaultSensitivity;
  const impact = clamp(config.ratePerHour * sensitivity * deltaHours * moodExcludingSelf, -config.maxAbsImpact, config.maxAbsImpact);
  return {
    force: "market_mood",
    impact,
    details: {
      mood: windowedMood(window),
      moodExcludingSelf,
      sensitivity,
      ratePerHour: config.ratePerHour,
      deltaHours,
      windowMinutes: config.windowMinutes,
      readings: window.readings,
    },
  };
}
