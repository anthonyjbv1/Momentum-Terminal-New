/**
 * THE REGISTER: how big a reading is, in bands rather than in decimals.
 *
 * This started life inside metric-language.ts as a display concern — which
 * words a sentence uses. Phase 24 made it more than that. A band is now also
 * the unit of NEWS: a metric emits when its band changes and stays quiet
 * while it holds, so the register decides both what a reading is called and
 * whether it is said at all. It lives in its own module because two callers
 * with different jobs depend on it, and metric-language.ts must stay what it
 * says it is — a chooser of words that decides nothing about scoring.
 *
 * WHY THE BAND AND NOT THE NUMBER (Phase 24). Emit-on-change (Phase 21)
 * compared observed quantities, and on a quiet day that is right: a news
 * count that does not move is not news twice. On a BUSY day it fails exactly
 * when it matters. The first live NFL game produced 39 metric emissions for
 * one person in fourteen hours — "Coverage of Patrick Mahomes is running hot"
 * roughly every fifteen minutes — because a trailing-24h count genuinely
 * ticks 56, 57, 58 all afternoon. Every one of those was a new number and not
 * one was new information, and each fed the Signals force, so it was the
 * Phase 20 re-reporting problem returning in a new shape on the days the
 * platform is most read.
 *
 * A reader cannot tell 2.6σ from 2.7σ and should not be asked to. What they
 * can tell is that coverage went from "running hot" to "56 stories today —
 * 2x their usual pace", and back. That transition is the event.
 */

export type MetricRegister = "spiking" | "concrete" | "elevated" | "quiet";

/**
 * THE REGISTER BANDS, in standard deviations. TUNABLE.
 *
 * Kept at the proposed boundaries because the board's own readings divide
 * evenly across them. Over the seven days to 2026-09-19, of the 458 readings
 * that clear the 2.0σ deadband: 34.5% sit below the person's own pace, 27.5%
 * land in 2.0–2.5, 21.6% in 2.5–3.5 and 16.4% above 3.5. No band is starved
 * and none swallows the others, which is what a register scheme needs — a
 * boundary that fired twice a week would teach a reader nothing.
 */
export const REGISTER_BANDS = {
  /** At or above this, something is genuinely happening and the voice is momentum-native. */
  spiking: 3.5,
  /** At or above this the number carries itself, so the voice is concrete. */
  concrete: 2.5,
} as const;

/**
 * HOW FAR PAST A BOUNDARY A READING MUST FALL BEFORE IT COUNTS AS HAVING LEFT
 * A BAND. TUNABLE.
 *
 * Without this the rule chatters: on the Mahomes window news_volume_24h
 * crossed 2.5σ in both directions six times in four hours (2.70, 2.31, 2.47,
 * 2.63, ... 2.31, 2.65), so banding alone would have cut 21 emissions to 7
 * and every one of the six would have been a boundary wobble rather than a
 * change anyone could read.
 *
 * 0.25σ, from the board's own step sizes: across 1,035 consecutive
 * observations in the 1.5–4.0σ range over the seven days to 2026-09-21, the
 * median step between polls is 0.034σ, the 75th percentile 0.104σ and the
 * 90th 0.379σ. A margin of 0.25 absorbs roughly five steps in six and lets
 * the sixth through, which is the shape wanted: ordinary jitter holds, a real
 * move reports.
 *
 * The margin is ASYMMETRIC, and deliberately. Entering a higher band is
 * reported at the boundary itself, with no margin, because the escalation is
 * the news and because the sentence a reader sees is chosen from the reading
 * alone — a signal that emitted late would be worded for a band it had
 * already left. Leaving a band downward needs the margin: the platform has
 * already said this was hot, and "it has cooled a little" is not a second
 * story.
 */
export const REGISTER_HYSTERESIS_SIGMA = 0.25;

/** Ordering, so a move between bands has a direction. */
const RANK: Record<MetricRegister, number> = { quiet: 0, elevated: 1, concrete: 2, spiking: 3 };

/**
 * The register of a reading. A function of the reading alone: same sigma, same
 * register, every time.
 *
 * Sign decides first. A reading BELOW the person's own pace is always the
 * terminal register, however far below, because a concrete count reads as an
 * accusation when it is low — "four stories today against a usual twelve" says
 * something about the person that "quiet week" does not.
 *
 * Note this bands on the SIGN OF THE READING, not on the direction of its
 * score impact. They coincide for every metric the board runs today (all
 * declare polarity +1), and they should not be conflated if one ever declares
 * −1: a low reading is described as low whatever it does to the score.
 */
export function registerFor(sigma: number): MetricRegister {
  if (!Number.isFinite(sigma)) return "elevated";
  if (sigma < 0) return "quiet";
  if (sigma >= REGISTER_BANDS.spiking) return "spiking";
  if (sigma >= REGISTER_BANDS.concrete) return "concrete";
  return "elevated";
}

/** The sigma at which a band begins. "quiet" has no floor: everything below zero is quiet. */
export function registerFloor(register: MetricRegister): number {
  if (register === "spiking") return REGISTER_BANDS.spiking;
  if (register === "concrete") return REGISTER_BANDS.concrete;
  if (register === "elevated") return 0;
  return Number.NEGATIVE_INFINITY;
}

/**
 * The register a reading LEAVES ON THE RECORD, given the one already there.
 *
 * With nothing on the record this is simply the reading's own register. With
 * a band already held, a move up is taken at the boundary and a move down
 * only once the reading has fallen a margin below the held band's floor —
 * see REGISTER_HYSTERESIS_SIGMA for why the two differ.
 *
 * Pure, and total: every sigma maps to a register whatever is held.
 */
export function heldRegister(sigma: number, held: MetricRegister | null): MetricRegister {
  const plain = registerFor(sigma);
  if (held === null || plain === held) return plain;
  if (RANK[plain] > RANK[held]) return plain;
  return sigma < registerFloor(held) - REGISTER_HYSTERESIS_SIGMA ? plain : held;
}

/** The registers, in order, for anything that needs to enumerate them. */
export const METRIC_REGISTERS: readonly MetricRegister[] = ["quiet", "elevated", "concrete", "spiking"];
