/**
 * THE TICK DEADLINE.
 *
 * One wall-clock instant by which a tick must have finished scoring, so that
 * it reaches its commit before the function that runs it is killed. The
 * failure this exists for: a tick loaded the entire backlog, scored it with
 * no deadline, and was killed at the route's maxDuration every minute, having
 * paid for every model call and committed nothing.
 *
 * The deadline gates STARTS, never aborts. Cancelling a non-streaming model
 * request mid-flight does not recover its cost, so the only useful rule is:
 * do not start work that cannot finish in time. A caller asks canStart(cost)
 * with the worst case it can take (a model call: its timeout), and gets a
 * plain yes or no. Work that is refused is deferred to the next tick, not
 * lost — the tick still commits with whatever it did finish.
 */
export interface TickDeadline {
  /** Epoch milliseconds. Infinity when there is no deadline. */
  readonly at: number;
  /** Milliseconds left, never negative. */
  remainingMs(): number;
  /** Whether work that may take up to costMs can still start and finish in time. */
  canStart(costMs: number): boolean;
  /** Whether the instant has passed. */
  expired(): boolean;
}

export function deadlineAfter(budgetMs: number, now: () => number = Date.now): TickDeadline {
  const at = now() + Math.max(0, budgetMs);
  return {
    at,
    remainingMs: () => Math.max(0, at - now()),
    canStart: (costMs) => now() + Math.max(0, costMs) <= at,
    expired: () => now() >= at,
  };
}

/** For callers that genuinely have no time limit (tests, a dry run from a shell). */
export const NO_DEADLINE: TickDeadline = {
  at: Number.POSITIVE_INFINITY,
  remainingMs: () => Number.POSITIVE_INFINITY,
  canStart: () => true,
  expired: () => false,
};
