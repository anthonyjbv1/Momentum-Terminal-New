import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { isFreeSignal, orderPeople, selectTickSignals } from "./selection";
import type { EngineSignal } from "./types";

const T0 = Date.parse("2026-09-16T10:00:00.000Z");

function event(id: string, personId: string, ageMinutes: number): EngineSignal {
  const at = new Date(T0 - ageMinutes * 60_000);
  return { id, personId, headline: `headline ${id}`, rawPayload: { kind: "article" }, sourceName: "rss", sourceTier: 2, occurredAt: at, createdAt: at };
}

function metric(id: string, personId: string): EngineSignal {
  return { ...event(id, personId, 0), rawPayload: { kind: "metric", metric: "subscribers", polarity: 1, sigma: 2.1, scale: 1 } };
}

/** The store delivers newest first; the selection must not depend on it. */
function shuffled(signals: EngineSignal[]): EngineSignal[] {
  return [...signals].sort((a, b) => a.id.localeCompare(b.id));
}

const config = DEFAULT_ENGINE_CONFIG.tick;

describe("selectTickSignals — newest first", () => {
  it("takes at most one chunk of event signals per person per tick, the NEWEST ones", () => {
    // The production backlog shape: one subject with far more than a chunk. Higher index = newer.
    const mrbeast = Array.from({ length: 145 }, (_, i) => event(`mb-${String(i).padStart(3, "0")}`, "mrbeast", 2000 - i));
    const { selected, leftBehind, eventSignals } = selectTickSignals(shuffled(mrbeast), config);
    expect(eventSignals).toBe(config.maxEventSignalsPerPersonPerTick);
    expect(selected.map((s) => s.id)).toEqual(mrbeast.slice(133).reverse().map((s) => s.id)); // mb-144 … mb-133
    expect(leftBehind).toBe(133);
  });

  it("spreads the tick across people: four subjects with backlogs each get their freshest chunk, one wave in total", () => {
    const backlog = [
      ...Array.from({ length: 145 }, (_, i) => event(`mb-${i}`, "mrbeast", 3000 - i)),
      ...Array.from({ length: 53 }, (_, i) => event(`pm-${i}`, "mahomes", 2900 - i)),
      ...Array.from({ length: 52 }, (_, i) => event(`dr-${i}`, "drake", 2800 - i)),
      ...Array.from({ length: 29 }, (_, i) => event(`kc-${i}`, "kai", 2700 - i)),
    ];
    const { selected, leftBehind, eventSignals, personOrder } = selectTickSignals(shuffled(backlog), config);
    expect(eventSignals).toBe(48);
    const counts = new Map<string, number>();
    for (const s of selected) counts.set(s.personId, (counts.get(s.personId) ?? 0) + 1);
    expect([...counts.entries()].sort()).toEqual([
      ["drake", 12],
      ["kai", 12],
      ["mahomes", 12],
      ["mrbeast", 12],
    ]);
    expect(leftBehind).toBe(279 - 48);
    // Nobody has been served: the freshest waiting signal decides the order (mrbeast's newest is 2856 min old, kai's 2672).
    expect(personOrder).toEqual(["kai", "drake", "mahomes", "mrbeast"]);
    // And within each person, the newest twelve.
    expect(selected.filter((s) => s.personId === "kai").map((s) => s.id)).toEqual(Array.from({ length: 12 }, (_, i) => `kc-${28 - i}`));
  });

  it("caps the total at maxEventSignalsPerTick: the people at the front of the order fill it, the rest wait", () => {
    const backlog = Array.from({ length: 16 }, (_, p) => Array.from({ length: 5 }, (_, i) => event(`p${p}-${i}`, `person-${String(p).padStart(2, "0")}`, p * 5 + i))).flat();
    const { selected, eventSignals, personOrder } = selectTickSignals(shuffled(backlog), config);
    expect(eventSignals).toBe(48);
    expect(personOrder).toHaveLength(16);
    // Freshest waiting signal first: person-00 (0 min) … person-15 (75 min).
    expect(personOrder.slice(0, 3)).toEqual(["person-00", "person-01", "person-02"]);
    expect(selected.filter((s) => s.personId === "person-00")).toHaveLength(5);
    expect(selected.filter((s) => s.personId === "person-09")).toHaveLength(3); // 45 taken, three of room left
    expect(selected.filter((s) => s.personId === "person-10")).toHaveLength(0);
  });

  it("takes every free signal without counting it, whatever the order: metrics by default, and anything the caller names", () => {
    const backlog = [
      ...Array.from({ length: 60 }, (_, i) => metric(`m-${i}`, `person-${i % 16}`)),
      ...Array.from({ length: 60 }, (_, i) => event(`e-${i}`, "mrbeast", 100 - i)),
      { ...event("b-1", "drake", 1), rawPayload: { kind: "baseline" } },
      // A prescored live moment (Phase 16) is free too: it never reaches the model, so it never waits on the rotation.
      { ...event("live-1", "kai-cenat", 2), rawPayload: { kind: "live_moment", moment: "audience_surge", direction: 1, confidence: 0.5 }, sourceName: "twitch" },
    ];
    const { selected, eventSignals, freeSignals, leftBehind } = selectTickSignals(shuffled(backlog), config);
    expect(freeSignals).toBe(62);
    expect(eventSignals).toBe(12);
    expect(selected).toHaveLength(74);
    expect(leftBehind).toBe(48);

    // The tick names expired event signals free too: a large expired backlog is all taken, beyond any per-person chunk.
    const expired = Array.from({ length: 300 }, (_, i) => event(`x-${i}`, "mrbeast", 60 * 24 * 8 + i));
    const drained = selectTickSignals(shuffled(expired), config, { isFree: (s) => isFreeSignal(s) || s.occurredAt.getTime() < T0 - 7 * 24 * 3_600_000 });
    expect(drained.freeSignals).toBe(300);
    expect(drained.eventSignals).toBe(0);
    expect(drained.leftBehind).toBe(0);
  });
});

describe("selectTickSignals — the rotation", () => {
  const streams = (people: string[], ageMinutes = 0) => people.map((p, i) => event(`${p}-fresh`, p, ageMinutes + i));

  it("serves the least recently served first; never served comes before anyone served", () => {
    const backlog = [...streams(["a", "b", "c", "d", "e"]), event("stale-only", "stale", 180)];
    const lastServedAt = new Map<string, Date>([
      ["a", new Date(T0 - 30_000)], // served last tick
      ["b", new Date(T0 - 60_000)],
      ["c", new Date(T0 - 90_000)],
      // d, e and stale: never served
    ]);
    const byPerson = new Map<string, EngineSignal[]>();
    for (const s of backlog) byPerson.set(s.personId, [...(byPerson.get(s.personId) ?? []), s]);
    expect(orderPeople(byPerson, lastServedAt)).toEqual(["d", "e", "stale", "c", "b", "a"]);
    // The never-served group is ordered freshest-first (d at 3 min, e at 4, stale at 180); the served group oldest service first.
    expect(selectTickSignals(shuffled(backlog), config, { lastServedAt }).personOrder).toEqual(["d", "e", "stale", "c", "b", "a"]);
  });

  it("a person with a steady stream of fresh signals cannot crowd out a person whose newest signal is hours old", () => {
    // Eight streamers with brand-new signals, one person with a single three-hour-old one; four calls per tick.
    const streamers = Array.from({ length: 8 }, (_, i) => `streamer-${i}`);
    const lastServedAt = new Map<string, Date>();
    const sequence: string[] = [];
    for (let tick = 1; tick <= 3; tick += 1) {
      const now = T0 + (tick - 1) * 30_000;
      const backlog = [...streams(streamers).map((s) => ({ ...s, id: `${s.id}-${tick}`, occurredAt: new Date(now), createdAt: new Date(now) })), event("stale-only", "stale", 180)];
      const { personOrder } = selectTickSignals(shuffled(backlog), config, { lastServedAt });
      for (const p of personOrder.slice(0, DEFAULT_ENGINE_CONFIG.llm.callBudgetPerTick)) {
        lastServedAt.set(p, new Date(now));
        sequence.push(p);
      }
    }
    // Nine people, four slots per tick: the first nine servings are nine different people — the stale one at slot nine,
    // first in tick 3 — and only then does anyone get a second turn, starting with the earliest served.
    expect(new Set(sequence.slice(0, 9)).size).toBe(9);
    expect(sequence[8]).toBe("stale");
    expect(sequence.slice(9)).toEqual(["streamer-0", "streamer-1", "streamer-2"]);
  });
});
