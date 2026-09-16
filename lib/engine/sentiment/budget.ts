/**
 * THE PER-TICK CALL BUDGET.
 *
 * A plain count, created by the tick and thrown away with it. The scorer asks
 * for a call and is told yes or no; there is no window, no clock, no
 * process-wide state. That is the whole point: the previous cap
 * (`maxCallsPerTick`) was a rolling 30-second window on a process-wide scorer
 * singleton, so a tick that ran longer than 30 seconds saw the window roll and
 * the cap never engaged — twenty-six chunks were attempted under a "cap" of
 * twenty. A budget that is an object owned by one tick cannot do that.
 *
 * It also holds the ONE-CHUNK-PER-PERSON rule. In the failed run, one subject
 * held half the backlog; his thirteen contiguous chunks owned all four pool
 * slots for the entire life of every invocation, and nobody else was ever
 * reached. So within one tick a person gets at most one call, whatever the
 * budget has left. This is a requirement of the Engine, not a tuning: do not
 * optimise it away. `budget.test.ts` pins it.
 */

/** Why a chunk was not attempted this tick. It stays unprocessed and is scored by a later tick. */
export type DeferralReason = "deadline" | "call_budget" | "person_cap" | "rate_limit";

/** Calls one person may receive in one tick. A rule, not a knob. */
export const CALLS_PER_PERSON_PER_TICK = 1;

export class TickCallBudget {
  private usedCount = 0;
  private readonly byPerson = new Map<string, number>();

  constructor(readonly limit: number) {}

  /** Calls taken so far this tick. */
  get used(): number {
    return this.usedCount;
  }

  /** Calls still available this tick. */
  get remaining(): number {
    return Math.max(0, this.limit - this.usedCount);
  }

  /** Calls the person has taken this tick. */
  usedBy(personId: string): number {
    return this.byPerson.get(personId) ?? 0;
  }

  /** Reserves one call for the person, or says why it cannot. Checks the person rule before the budget so the reason is the specific one. */
  take(personId: string): DeferralReason | null {
    if (this.usedBy(personId) >= CALLS_PER_PERSON_PER_TICK) return "person_cap";
    if (this.usedCount >= this.limit) return "call_budget";
    this.usedCount += 1;
    this.byPerson.set(personId, this.usedBy(personId) + 1);
    return null;
  }
}
