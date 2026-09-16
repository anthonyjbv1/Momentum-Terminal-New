import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { selectTickSignals } from "./selection";
import type { EngineSignal } from "./types";

const T0 = Date.parse("2026-09-16T10:00:00.000Z");

function event(id: string, personId: string, ageMinutes: number): EngineSignal {
  const at = new Date(T0 - ageMinutes * 60_000);
  return { id, personId, headline: `headline ${id}`, rawPayload: { kind: "article" }, sourceName: "rss", sourceTier: 2, occurredAt: at, createdAt: at };
}

function metric(id: string, personId: string): EngineSignal {
  return { ...event(id, personId, 0), rawPayload: { kind: "metric", metric: "subscribers", polarity: 1, sigma: 2.1, scale: 1 } };
}

/** Oldest first, the order the store delivers. */
function oldestFirst(signals: EngineSignal[]): EngineSignal[] {
  return [...signals].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

describe("selectTickSignals", () => {
  const config = DEFAULT_ENGINE_CONFIG.tick;

  it("takes at most one chunk of event signals per person per tick, oldest first", () => {
    // The production backlog shape: one subject with far more than a chunk.
    const mrbeast = Array.from({ length: 145 }, (_, i) => event(`mb-${String(i).padStart(3, "0")}`, "mrbeast", 2000 - i));
    const { selected, leftBehind, eventSignals } = selectTickSignals(oldestFirst(mrbeast), config);
    expect(eventSignals).toBe(config.maxEventSignalsPerPersonPerTick);
    expect(selected.map((s) => s.id)).toEqual(mrbeast.slice(0, 12).map((s) => s.id)); // the twelve oldest
    expect(leftBehind).toBe(133);
  });

  it("spreads the tick across people: four subjects with backlogs each get their chunk, and the total is one wave", () => {
    const backlog = [
      ...Array.from({ length: 145 }, (_, i) => event(`mb-${i}`, "mrbeast", 3000 - i)),
      ...Array.from({ length: 53 }, (_, i) => event(`pm-${i}`, "mahomes", 2900 - i)),
      ...Array.from({ length: 52 }, (_, i) => event(`dr-${i}`, "drake", 2800 - i)),
      ...Array.from({ length: 29 }, (_, i) => event(`kc-${i}`, "kai", 2700 - i)),
    ];
    const { selected, leftBehind, eventSignals } = selectTickSignals(oldestFirst(backlog), config);
    expect(eventSignals).toBe(48);
    expect(selected).toHaveLength(48);
    const counts = new Map<string, number>();
    for (const s of selected) counts.set(s.personId, (counts.get(s.personId) ?? 0) + 1);
    expect([...counts.entries()].sort()).toEqual([
      ["drake", 12],
      ["kai", 12],
      ["mahomes", 12],
      ["mrbeast", 12],
    ]);
    expect(leftBehind).toBe(279 - 48);
  });

  it("caps the total at maxEventSignalsPerTick even when many people each have a little", () => {
    const backlog = Array.from({ length: 16 }, (_, p) => Array.from({ length: 5 }, (_, i) => event(`p${p}-${i}`, `person-${p}`, 500 - p * 5 - i))).flat();
    const { selected, eventSignals } = selectTickSignals(oldestFirst(backlog), config);
    expect(eventSignals).toBe(48);
    // Oldest first across people: the first nine people (45) and three of the tenth.
    expect(selected.filter((s) => s.personId === "person-0")).toHaveLength(5);
    expect(selected.filter((s) => s.personId === "person-9")).toHaveLength(3);
    expect(selected.filter((s) => s.personId === "person-10")).toHaveLength(0);
  });

  it("takes every metric and baseline signal without counting them: they cost nothing", () => {
    const backlog = [
      ...Array.from({ length: 60 }, (_, i) => metric(`m-${i}`, `person-${i % 16}`)),
      ...Array.from({ length: 60 }, (_, i) => event(`e-${i}`, "mrbeast", 100 - i)),
      { ...event("b-1", "drake", 1), rawPayload: { kind: "baseline" } },
    ];
    const { selected, eventSignals, freeSignals, leftBehind } = selectTickSignals(oldestFirst(backlog), config);
    expect(freeSignals).toBe(61);
    expect(eventSignals).toBe(12);
    expect(selected).toHaveLength(73);
    expect(leftBehind).toBe(48);
  });

  it("keeps the store's order in what it selects", () => {
    const backlog = oldestFirst([event("a", "x", 30), event("b", "y", 20), event("c", "x", 10)]);
    expect(selectTickSignals(backlog, config).selected.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
