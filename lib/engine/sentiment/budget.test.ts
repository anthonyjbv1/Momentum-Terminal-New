import { describe, expect, it } from "vitest";

import { CALLS_PER_PERSON_PER_TICK, TickCallBudget } from "./budget";

describe("TickCallBudget", () => {
  it("is a plain per-tick count: the limit is the number of calls, whatever the clock does", () => {
    const budget = new TickCallBudget(2);
    expect(budget.take("a")).toBeNull();
    expect(budget.take("b")).toBeNull();
    expect(budget.take("c")).toBe("call_budget");
    expect(budget.used).toBe(2);
    expect(budget.remaining).toBe(0);
  });

  it("ONE CALL PER PERSON PER TICK, pinned: a second chunk for the same person is refused even with budget left", () => {
    // The rule that stops one subject monopolising the Engine. If this test
    // ever needs changing, the failure analysis of the first cron run should
    // be re-read first: thirteen contiguous chunks for one person owned all
    // four pool slots for the entire life of every invocation.
    expect(CALLS_PER_PERSON_PER_TICK).toBe(1);
    const budget = new TickCallBudget(20);
    expect(budget.take("mrbeast")).toBeNull();
    expect(budget.take("mrbeast")).toBe("person_cap");
    expect(budget.take("mrbeast")).toBe("person_cap");
    expect(budget.used).toBe(1);
    expect(budget.usedBy("mrbeast")).toBe(1);
    // Everyone else is untouched by his cap.
    expect(budget.take("drake")).toBeNull();
    expect(budget.used).toBe(2);
  });

  it("reports the person rule before the budget, so the reason is the specific one", () => {
    const budget = new TickCallBudget(1);
    expect(budget.take("a")).toBeNull();
    expect(budget.take("a")).toBe("person_cap");
    expect(budget.take("b")).toBe("call_budget");
  });

  it("a zero budget refuses everything", () => {
    const budget = new TickCallBudget(0);
    expect(budget.take("a")).toBe("call_budget");
    expect(budget.remaining).toBe(0);
  });
});
