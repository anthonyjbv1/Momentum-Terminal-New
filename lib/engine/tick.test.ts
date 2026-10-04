import { describe, expect, it, vi } from "vitest";

import { makePerson } from "@/lib/__tests__/fixtures";
import { LLMError, type LLMResponse } from "@/lib/llm/types";
import { createMemoryUsageLogger } from "@/lib/llm/usage";

import { DEFAULT_ENGINE_CONFIG as CONFIG, withEngineConfig } from "./config";
import { deadlineAfter } from "./deadline";
import { LLMScorer } from "./sentiment/llm";
import { rulesBasedScorer } from "./sentiment/rules";
import { createMemoryEngineStore, type MemoryEngineSeed } from "./store";
import { runEngineTick } from "./tick";
import type { EngineSignal } from "./types";

const NOW = new Date("2026-09-07T12:00:00.000Z");

const drake = makePerson({ id: "p-drake", slug: "drake", display_name: "Drake", revert_target: 65, category: "musician" });
const kendrick = makePerson({ id: "p-kendrick", slug: "kendrick-lamar", display_name: "Kendrick Lamar", revert_target: 63, category: "musician" });
const mrbeast = makePerson({ id: "p-mrbeast", slug: "mrbeast", display_name: "MrBeast", revert_target: 68 });
const pair = { id: "pair-1", person_a_id: "p-drake", person_b_id: "p-kendrick", dampening: 0.4 };

function seed(extra: Partial<MemoryEngineSeed> = {}): MemoryEngineSeed {
  return { people: [drake, kendrick, mrbeast], inversePairs: [pair], ...extra };
}

describe("Engine tick", () => {
  it("with no signals moves every score slightly toward its revert target via Gravity only", async () => {
    const store = createMemoryEngineStore(seed());
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });

    expect(summary.tickNumber).toBe(1);
    expect(summary.dryRun).toBe(false);
    expect(summary.mood).toBe(0);
    expect(summary.signalsProcessed).toBe(0);
    expect(summary.peopleUpdated).toBe(3);

    for (const p of summary.people) {
      const target = { drake: 65, "kendrick-lamar": 63, mrbeast: 68 }[p.slug]!;
      expect(p.newScore).toBeGreaterThan(50);
      expect(p.newScore).toBeLessThan(target);
      expect(p.change).toBeGreaterThan(0);
      expect(p.change).toBeLessThan(0.1);
      expect(Object.keys(p.forces)).toEqual(["gravity"]);
      expect(p.spread).toBe(0.5);
      expect(p.buyPrice).toBeCloseTo(p.newScore + 0.5, 2);
      expect(p.sellPrice).toBeCloseTo(p.newScore - 0.5, 2);
    }
    // Gravity for one 30s tick from 50 toward 68: 18 * (1 - e^(-0.35/120)) = 0.052423 -> 50.0524 at the score's four decimals
    expect(summary.people.find((p) => p.slug === "mrbeast")?.newScore).toBe(50.0524);

    expect(store.scoreHistory.map((h) => h.tickNumber)).toEqual([1, 1, 1]);
    expect(store.scoreEvents.every((e) => e.force === "gravity" && e.impact > 0)).toBe(true);
    expect(store.scoreEvents).toHaveLength(3);
    expect(store.people.find((p) => p.id === "p-mrbeast")?.current_score).toBe(50.0524);
  });

  it("FOUR DECIMALS: Gravity's sub-cent pull near the target is applied, not rounded away every tick", async () => {
    // At two decimals a person 1.37 below target was stuck: 1.37 × 0.0029 = 0.004 a tick, under half a cent, discarded 2,836 times a day.
    expect(CONFIG.score.decimals).toBe(4);
    const stuck = makePerson({ id: "p-stuck", slug: "stuck", current_score: 61.63, revert_target: 63 });
    const store = createMemoryEngineStore({ people: [stuck], lastTickNumber: 1000 });
    let now = NOW;
    for (let tick = 0; tick < 120; tick += 1) {
      now = new Date(now.getTime() + 30_000);
      await runEngineTick({ store, scorer: rulesBasedScorer, now });
    }
    // An hour of ticks closes the gap by 1 − e^(−0.35): from 1.37 to 0.97.
    const score = Number(store.people[0].current_score);
    expect(score).toBeGreaterThan(61.63);
    expect(63 - score).toBeCloseTo(1.37 * Math.exp(-0.35), 2);
  });

  it("increments tick_number and uses the time since the last tick", async () => {
    const store = createMemoryEngineStore(seed());
    await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });
    const later = new Date(NOW.getTime() + 60 * 60 * 1000); // one hour of silence
    const second = await runEngineTick({ store, scorer: rulesBasedScorer, now: later });

    expect(second.tickNumber).toBe(2);
    expect(store.scoreHistory.map((h) => h.tickNumber)).toEqual([1, 1, 1, 2, 2, 2]);
    const mr = second.people.find((p) => p.slug === "mrbeast")!;
    // One hour toward 68 from 50.05: 68 - 17.95 * e^-0.35 = 55.35
    expect(mr.newScore).toBeCloseTo(68 - (68 - 50.05) * Math.exp(-0.35), 1);
  });

  it("applies a seeded signal, marks it processed, and moves the inverse pair the other way", async () => {
    const store = createMemoryEngineStore(
      seed({
        signals: [
          {
            id: "sig-1",
            personId: "p-drake",
            headline: "Drake crosses 100M monthly listeners on Spotify",
            rawPayload: { kind: "milestone" },
            sourceName: "spotify",
            sourceTier: 2,
            occurredAt: NOW,
            createdAt: NOW,
          },
        ],
      }),
    );
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });

    const drakeSummary = summary.people.find((p) => p.slug === "drake")!;
    const kendrickSummary = summary.people.find((p) => p.slug === "kendrick-lamar")!;
    const mrbeastSummary = summary.people.find((p) => p.slug === "mrbeast")!;

    // "crosses" -> positive 0.8 -> impact 1.5 * 1.0 * 0.8 = 1.2
    expect(summary.signals).toEqual([
      expect.objectContaining({ id: "sig-1", personSlug: "drake", label: "positive", confidence: 0.8, direction: 1, impact: 1.2 }),
    ]);
    expect(drakeSummary.forces.signals).toBe(1.2);
    expect(drakeSummary.forces.market_mood).toBeUndefined(); // own news never feeds back through the mood
    expect(drakeSummary.newScore).toBeCloseTo(50 + 1.2 + 0.0437, 2); // + gravity toward 65

    // Kendrick: inverse -(1.2 * 0.4) = -0.48, plus the tide. The mood is read
    // over the window (one reading here, this tick) and applied per hour:
    // 1.41 * (30/3600) * mean(others) = 1.41 * 0.008333 * 0.6 = 0.00705.
    const TIDE = 1.41 * (30 / 3600) * 0.6; // 0.00705, written at the force's four decimals
    expect(kendrickSummary.forces.inverse_pair).toBeCloseTo(-0.48);
    expect(kendrickSummary.forces.market_mood).toBeCloseTo(TIDE, 3);
    expect(kendrickSummary.newScore).toBeLessThan(mrbeastSummary.newScore);

    // MrBeast only feels the tide.
    expect(mrbeastSummary.forces.market_mood).toBeCloseTo(TIDE, 3);
    expect(mrbeastSummary.forces.signals).toBeUndefined();
    expect(summary.mood).toBeCloseTo(1.2 / 3);

    // Persisted: signal processed with its sentiment + impact; events logged without zero entries.
    expect(store.processedSignals).toEqual([{ id: "sig-1", impactScore: 1.2, sentimentLabel: "positive", sentimentConfidence: 0.8 }]);
    expect(store.signals[0].processed).toBe(true);
    const forces = store.scoreEvents.map((e) => `${e.personId}:${e.force}`).sort();
    expect(forces).toEqual(
      [
        "p-drake:gravity",
        "p-drake:signals",
        "p-kendrick:gravity",
        "p-kendrick:inverse_pair",
        "p-kendrick:market_mood",
        "p-mrbeast:gravity",
        "p-mrbeast:market_mood",
      ].sort(),
    );
    expect(store.scoreEvents.some((e) => e.force === "conviction" || e.force === "trading_activity")).toBe(false);

    // A second tick has nothing left to process — but the tide is not gone
    // thirty seconds later (Phase 19+): the window still holds the reading,
    // so the mood reads the same and the force keeps applying it.
    const again = await runEngineTick({ store, scorer: rulesBasedScorer, now: new Date(NOW.getTime() + 30_000) });
    expect(again.signalsProcessed).toBe(0);
    expect(again.mood).toBeCloseTo(1.2 / 3);
    expect(again.people.find((p) => p.slug === "mrbeast")!.forces.market_mood).toBeCloseTo(TIDE, 3);
    // Past the window it is: the reading has aged out and the board is flat again.
    const later = await runEngineTick({ store, scorer: rulesBasedScorer, now: new Date(NOW.getTime() + 61 * 60_000) });
    expect(later.mood).toBe(0);
    expect(later.people.find((p) => p.slug === "mrbeast")!.forces.market_mood).toBeUndefined();
  });

  it("treats baseline signals as zero impact but still marks them processed", async () => {
    const store = createMemoryEngineStore(
      seed({
        signals: [
          {
            id: "sig-base",
            personId: "p-mrbeast",
            headline: "MrBeast stands at 516M subscribers, 90B total views and 900 videos on YouTube",
            rawPayload: { kind: "baseline" },
            sourceName: "youtube",
            sourceTier: 2,
            occurredAt: NOW,
            createdAt: NOW,
          },
        ],
      }),
    );
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });
    expect(summary.signals[0]).toMatchObject({ label: "neutral", confidence: 0, direction: 0, impact: 0 });
    expect(summary.people.find((p) => p.slug === "mrbeast")?.forces.signals).toBeUndefined();
    expect(store.processedSignals[0]).toMatchObject({ id: "sig-base", impactScore: 0, sentimentLabel: "neutral" });
  });

  it("scores a prescored live moment (Phase 16) from its declaration, free of the model, and persists it like any signal", async () => {
    const store = createMemoryEngineStore(
      seed({
        signals: [
          {
            id: "sig-live",
            personId: "p-mrbeast",
            headline: "MrBeast's live audience is up 30% in the last ten minutes, 40,000 to 52,000 viewers, 1h 20m into the stream.",
            rawPayload: { kind: "live_moment", moment: "audience_surge", direction: 1, confidence: 0.6, magnitude: 0.3, source: "twitch" },
            sourceName: "twitch",
            sourceTier: 2,
            occurredAt: NOW,
            createdAt: NOW,
          },
        ],
      }),
    );
    // A scorer that would blow up if the model were ever asked.
    const never = { name: "never", scoreSignal: async () => { throw new Error("the model must not see a live moment"); } };
    const summary = await runEngineTick({ store, scorer: never, now: NOW, config: withEngineConfig({ marketMood: { ratePerHour: 0 } }) });
    expect(summary.signals[0]).toMatchObject({ id: "sig-live", label: "positive", direction: 1, confidence: 0.6, scorer: "prescored", anomaly: "notable" });
    // 1.5 × tier 2 (1.0) × 0.6, fresh, unweighted.
    expect(summary.signals[0].impact).toBeCloseTo(0.9, 4);
    expect(summary.scoring).toMatchObject({ selected: 1, llmCalls: 0, attempted: 0, withoutModel: 1, deferred: 0 });
    expect(summary.people.find((p) => p.slug === "mrbeast")?.forces.signals).toBeCloseTo(0.9, 4);
    expect(store.processedSignals[0]).toMatchObject({ id: "sig-live", sentimentLabel: "positive" });
  });

  it("dry runs compute everything and persist nothing", async () => {
    const store = createMemoryEngineStore(seed());
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.people).toHaveLength(3);
    expect(summary.peopleUpdated).toBe(0);
    expect(store.ticks).toHaveLength(0);
    expect(store.scoreHistory).toHaveLength(0);
    expect(store.people.every((p) => p.current_score === 50)).toBe(true);
  });

  it("clamps to the floor and ceiling", async () => {
    const high = makePerson({ id: "p-high", slug: "high", current_score: 99.9, revert_target: 60 });
    const low = makePerson({ id: "p-low", slug: "low", current_score: 35.2, revert_target: 60 });
    const loud = (id: string, personId: string, headline: string) => ({
      id,
      personId,
      headline,
      rawPayload: null,
      sourceName: "forbes",
      sourceTier: 1,
      occurredAt: NOW,
      createdAt: NOW,
    });
    const store = createMemoryEngineStore({
      people: [high, low],
      signals: [
        ...Array.from({ length: 8 }, (_, i) => loud(`up${i}`, "p-high", "wins record award")),
        ...Array.from({ length: 8 }, (_, i) => loud(`dn${i}`, "p-low", "arrested in fraud scandal")),
      ],
    });
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config: withEngineConfig({ marketMood: { ratePerHour: 0 } }) });
    expect(summary.people.find((p) => p.slug === "high")?.newScore).toBe(CONFIG.score.ceiling);
    expect(summary.people.find((p) => p.slug === "low")?.newScore).toBe(CONFIG.score.floor);
  });

  it("refuses to persist a stale tick", async () => {
    const store = createMemoryEngineStore(seed({ lastTickNumber: 4 }));
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });
    expect(summary.tickNumber).toBe(5);
    await expect(store.applyTick({ ...store.ticks[0], expectedTickNumber: 5 })).rejects.toThrow(/stale tick/);
  });
});

// ---------------------------------------------------------------------------
// THE PERSON'S VOLUME WEIGHT (Phase 15)
// ---------------------------------------------------------------------------

describe("Engine tick — the person's volume weight", () => {
  const praise = (id: string, personId: string): EngineSignal => ({ id, personId, headline: "crosses 100M monthly listeners on Spotify", rawPayload: { kind: "article" }, sourceName: "rss", sourceTier: 2, occurredAt: NOW, createdAt: NOW });
  const week = (perDay: number) => Array.from({ length: 7 }, () => perDay);

  it("weights each person's event signals by the reference over their own typical day, and leaves the unmeasured and the thin at 1", async () => {
    const store = createMemoryEngineStore(
      seed({
        signals: [praise("d1", "p-drake"), praise("k1", "p-kendrick"), praise("m1", "p-mrbeast")],
        signalVolume: {
          "p-drake": { trackedSince: NOW, current24h: 2, daily: week(2) }, // half the reference: double
          "p-mrbeast": { trackedSince: NOW, current24h: 16, daily: week(16) }, // four times: a quarter
          "p-kendrick": { trackedSince: NOW, current24h: 16, daily: [16, 16, 16] }, // three days: not yet
        },
      }),
    );
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config: withEngineConfig({ marketMood: { ratePerHour: 0 }, inversePairs: { defaultDampening: 0 } }) });
    const by = (slug: string) => summary.people.find((p) => p.slug === slug)!;
    expect(by("drake").forces.signals).toBeCloseTo(2.4);
    expect(by("mrbeast").forces.signals).toBeCloseTo(0.3);
    expect(by("kendrick-lamar").forces.signals).toBeCloseTo(1.2);
    expect(summary.signals.map((s) => [s.id, s.volumeWeight, s.impact])).toEqual([
      ["d1", 2, 2.4],
      ["k1", 1, 1.2],
      ["m1", 0.25, 0.3],
    ]);
    // The stored impact is the weighted one, so the Feed, memory and narratives see what moved the score.
    expect(store.processedSignals.map((s) => [s.id, s.impactScore])).toEqual([
      ["d1", 2.4],
      ["k1", 1.2],
      ["m1", 0.3],
    ]);
    const event = store.scoreEvents.find((e) => e.personId === "p-mrbeast" && e.force === "signals")!;
    expect(event.details).toMatchObject({ volumeWeight: 0.25, volume: { sufficient: true, samples: 7, meanPerDay: 16 } });
    const thin = store.scoreEvents.find((e) => e.personId === "p-kendrick" && e.force === "signals")!;
    expect(thin.details).toMatchObject({ volumeWeight: 1, volume: { sufficient: false, samples: 3 } });
  });
});

// ---------------------------------------------------------------------------
// THE DRIFTING TARGET (Phase 14)
// ---------------------------------------------------------------------------

describe("Engine tick — the drifting target", () => {
  const DAY = 24 * 3_600_000;
  /** A fresh positive article (rules: "crosses" → 0.8 → 1.2 points at tier 2) for a person at a given instant. */
  const praise = (id: string, personId: string, at: Date, sourceName = "rss"): EngineSignal => ({ id, personId, headline: "crosses 100M monthly listeners on Spotify", rawPayload: { kind: "article" }, sourceName, sourceTier: 2, occurredAt: at, createdAt: at });

  it("OFF by default: the target is the seed, a stale offset on the row is ignored and reset, and nothing accumulates", async () => {
    const stale = makePerson({ id: "p-stale", slug: "stale", current_score: 60, revert_target: 63, target_attention: 0.01, target_direction: -0.01, target_offset: -5 });
    const store = createMemoryEngineStore({ people: [stale] });
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });
    expect(summary.people[0].revertTarget).toBe(63);
    expect(summary.people[0].targetOffset).toBe(0);
    expect(store.scoreEvents[0].details).toMatchObject({ revertTarget: 63, seedTarget: 63, targetDrift: { enabled: false, offset: 0, attention: null, direction: null } });
    expect(store.people[0]).toMatchObject({ target_attention: null, target_direction: null, target_offset: 0 });
    expect(store.ticks[0].people[0]).toMatchObject({ targetAttention: null, targetDirection: null, targetOffset: 0 });
  });

  it("ON: the first tick moves no target (a never-measured person is presumed fully covered), and the state is persisted", async () => {
    const config = withEngineConfig({ targetDrift: { enabled: true, people: ["drake", "kendrick-lamar", "mrbeast"] } });
    const store = createMemoryEngineStore(seed());
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config });
    for (const p of summary.people) {
      expect(p.targetOffset).toBeCloseTo(0, 3);
      expect(p.revertTarget).toBeCloseTo({ drake: 65, "kendrick-lamar": 63, mrbeast: 68 }[p.slug]!, 3);
    }
    const mr = store.people.find((p) => p.id === "p-mrbeast")!;
    expect(mr.target_attention).toBeCloseTo(CONFIG.targetDrift.fullCoverageImpactPerHour, 4);
    expect(mr.target_direction).toBeCloseTo(0, 6);
    expect(mr.target_offset).toBeCloseTo(0, 3);
    expect(store.scoreEvents.find((e) => e.personId === "p-mrbeast")?.details).toMatchObject({ seedTarget: 68, targetDrift: { enabled: true, halfLifeHours: 336, bound: 8 } });
  });

  it("ON, weeks of silence: an inert person's target sinks toward their own floor and Gravity follows it; a covered person's rises", async () => {
    // Market Mood off, so the quiet person's score shows Gravity following the target and nothing else.
    const config = withEngineConfig({ targetDrift: { enabled: true, people: ["quiet", "covered"] }, marketMood: { ratePerHour: 0 } });
    const quiet = makePerson({ id: "p-quiet", slug: "quiet", display_name: "Quiet", current_score: 63, revert_target: 63 });
    const covered = makePerson({ id: "p-covered", slug: "covered", display_name: "Covered", current_score: 60, revert_target: 60 });
    const store = createMemoryEngineStore({ people: [quiet, covered] });
    // One tick a day for eight weeks (Δh capped at 24 h). Each day the covered person gets six fresh praises from six
    // sources: 6 × 1.2 / √6 = 2.94 points a day, 0.12 an hour, about 60 % of full coverage, entirely positive.
    let last: Awaited<ReturnType<typeof runEngineTick>> | null = null;
    for (let day = 1; day <= 56; day += 1) {
      const now = new Date(NOW.getTime() + day * DAY);
      for (let s = 0; s < 6; s += 1) store.signals.push(praise(`c-${day}-${s}`, "p-covered", now, `source-${s}`));
      last = await runEngineTick({ store, scorer: rulesBasedScorer, now, config });
      // The first tick of a never-ticked person spans 30 s, so day 15 is the fourteenth full day: one half-life, −4.
      if (day === 15) {
        expect(last.people.find((p) => p.slug === "quiet")!.targetOffset).toBeCloseTo(-4, 1);
      }
    }
    const q = last!.people.find((p) => p.slug === "quiet")!;
    const c = last!.people.find((p) => p.slug === "covered")!;
    // Quiet: eight weeks at a 14-day half-life leaves 1/16 of the presumed coverage: offset −7.5, target 55.5, score right behind it.
    expect(q.targetOffset).toBeCloseTo(-7.5, 1);
    expect(q.revertTarget).toBeCloseTo(55.5, 1);
    expect(q.newScore).toBeCloseTo(q.revertTarget, 0);
    expect(q.targetOffset).toBeGreaterThanOrEqual(-CONFIG.targetDrift.bound);
    // Covered: coverage 0.6, lean 0.6 → 8 × (0.6 × 1.6 − 1) = −0.3 at the limit; still above the quiet one by the coverage alone,
    // and on a coverage of 0.12/h the seed is not quite earned: that is what fullCoverageImpactPerHour = 0.2 says.
    expect(c.targetOffset).toBeGreaterThan(q.targetOffset + 5);
    expect(c.targetOffset).toBeLessThanOrEqual(CONFIG.targetDrift.bound);
    expect(c.revertTarget).toBeGreaterThan(q.revertTarget);
    // The persisted state is the summary's state.
    expect(store.people.find((p) => p.id === "p-quiet")!.target_offset).toBe(q.targetOffset);
  });

  it("ON, bounded: no amount of praise takes a target past seed + bound, and the score settles there", async () => {
    // Full coverage is 0.2 points an hour; make it tiny so a daily praise saturates the drift inside the test.
    const config = withEngineConfig({ targetDrift: { enabled: true, people: ["star"], fullCoverageImpactPerHour: 0.001 } });
    const person = makePerson({ id: "p-star", slug: "star", display_name: "Star", current_score: 60, revert_target: 60 });
    const store = createMemoryEngineStore({ people: [person] });
    let last: Awaited<ReturnType<typeof runEngineTick>> | null = null;
    for (let day = 1; day <= 70; day += 1) {
      const now = new Date(NOW.getTime() + day * DAY);
      store.signals.push(praise(`s-${day}`, "p-star", now));
      last = await runEngineTick({ store, scorer: rulesBasedScorer, now, config });
    }
    const star = last!.people[0];
    expect(star.targetOffset).toBeLessThanOrEqual(8);
    expect(star.targetOffset).toBeCloseTo(8, 0);
    expect(star.revertTarget).toBeCloseTo(68, 0);
    expect(star.newScore).toBeLessThanOrEqual(68 + 1.3); // the day's praise sits on top of a target that never passes 68
  });
});

// ---------------------------------------------------------------------------
// THE DRIFT REDESIGN (2026-10-04): the allowlist, relative coverage, the
// measured start, the no-history fallback, the audit block.
// ---------------------------------------------------------------------------

describe("Engine tick — the drift redesign", () => {
  const DAY = 24 * 3_600_000;
  const praise = (id: string, personId: string, at: Date, sourceName = "rss"): EngineSignal => ({ id, personId, headline: "crosses 100M monthly listeners on Spotify", rawPayload: { kind: "article" }, sourceName, sourceTier: 2, occurredAt: at, createdAt: at });

  /** The same days of praise for Drake, under one config, as the rows and events the store ends with. */
  async function runDays(config: ReturnType<typeof withEngineConfig>, dayCount: number) {
    const store = createMemoryEngineStore(seed());
    const summaries = [];
    for (let day = 1; day <= dayCount; day += 1) {
      const now = new Date(NOW.getTime() + day * DAY);
      for (let s = 0; s < 3; s += 1) store.signals.push(praise(`d-${day}-${s}`, "p-drake", now, `source-${s}`));
      summaries.push(await runEngineTick({ store, scorer: rulesBasedScorer, now, config }));
    }
    return { store, summaries };
  }

  it("ALLOWLIST: with the switch on, only listed people drift; everyone else is tick for tick what they are with the switch off", async () => {
    const off = await runDays(withEngineConfig({ targetDrift: { enabled: false } }), 20);
    const on = await runDays(withEngineConfig({ targetDrift: { enabled: true, people: ["mrbeast"] } }), 20);
    for (let tick = 0; tick < 20; tick += 1) {
      for (const slug of ["drake", "kendrick-lamar"]) {
        const a = off.summaries[tick].people.find((p) => p.slug === slug)!;
        const b = on.summaries[tick].people.find((p) => p.slug === slug)!;
        expect([b.newScore, b.revertTarget, b.targetOffset, b.forces], `${slug} tick ${tick + 1}`).toEqual([a.newScore, a.revertTarget, a.targetOffset, a.forces]);
      }
    }
    for (const id of ["p-drake", "p-kendrick"]) {
      expect(on.store.people.find((p) => p.id === id)).toMatchObject({ target_attention: null, target_direction: null, target_offset: 0 });
      const gravity = on.store.scoreEvents.filter((e) => e.personId === id && e.force === "gravity").at(-1)!;
      expect(gravity.details).toMatchObject({ targetDrift: { enabled: true, listed: false, started: "dormant", offset: 0, attention: null, direction: null, fallback: false } });
    }
    // MrBeast, listed and silent, has sunk toward his floor; the audit block says he is listed.
    const mr = on.summaries[19].people.find((p) => p.slug === "mrbeast")!;
    expect(mr.targetOffset).toBeLessThan(-4);
    expect(on.store.scoreEvents.filter((e) => e.personId === "p-mrbeast" && e.force === "gravity").at(-1)!.details).toMatchObject({ targetDrift: { enabled: true, listed: true, mode: "fixed", normal: null, fallback: false } });
    // An empty list moves nobody.
    const nobody = await runDays(withEngineConfig({ targetDrift: { enabled: true, people: [] } }), 3);
    for (const p of nobody.store.people) expect(p).toMatchObject({ target_attention: null, target_direction: null, target_offset: 0 });
  });

  it("NO HISTORY (Anthony Baptiste): a listed person with no normal takes the presumed path in relative mode, about −1 at 2.7 days and −2 at 5.8, never an instant −8", async () => {
    // Below his seed, so every tick records a gravity row (an impact of exactly zero is not written).
    const anthony = makePerson({ id: "p-anthony", slug: "anthony-baptiste", display_name: "Anthony Baptiste", current_score: 59, revert_target: 60 });
    const config = withEngineConfig({ targetDrift: { enabled: true, people: ["anthony-baptiste"], coverageMode: "relative", normalSince: "2026-09-01T00:00:00.000Z" }, marketMood: { ratePerHour: 0 } });
    const store = createMemoryEngineStore({ people: [anthony] });
    const SIX_HOURS = 6 * 3_600_000;
    const offsets: number[] = [];
    for (let tick = 1; tick <= 24; tick += 1) {
      const now = new Date(NOW.getTime() + tick * SIX_HOURS);
      const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now, config });
      offsets.push(summary.people[0].targetOffset);
    }
    // The first tick spans 30 s and moves nothing; then 2^(−t/336h) decay from the presumed full coverage.
    expect(offsets[0]).toBeCloseTo(0, 2);
    expect(offsets[11]).toBeCloseTo(-1, 1); // 66 h = 2.75 days: −8 × (1 − 2^(−66/336)) = −1.02
    expect(offsets[23]).toBeCloseTo(-2, 1); // 138 h = 5.75 days: −1.98
    expect(Math.min(...offsets)).toBeGreaterThan(-2.5);
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]).toBeLessThanOrEqual(offsets[i - 1]);
    const first = store.scoreEvents.find((e) => e.personId === "p-anthony" && e.force === "gravity")!;
    expect(first.details).toMatchObject({ targetDrift: { listed: true, mode: "relative", normal: null, scale: CONFIG.targetDrift.fullCoverageImpactPerHour, fallback: true, started: "presumed" } });
    const last = store.scoreEvents.filter((e) => e.personId === "p-anthony" && e.force === "gravity").at(-1)!;
    expect(last.details).toMatchObject({ targetDrift: { fallback: true, started: "carried" } });
  });

  it("RELATIVE + MEASURED START on fixture data: the flip reads the person's own normal and starts the state from their measured averages", async () => {
    // Kai's normal from the 10-03 preflight window: 0.17 gross, 0.0216 signed points an hour.
    const kai = makePerson({ id: "p-kai", slug: "kai-cenat", display_name: "Kai Cenat", current_score: 60, revert_target: 60 });
    const normal = { grossPerHour: 0.1701, signedPerHour: 0.0216, hours: 672, events: 241 };
    const config = withEngineConfig({ targetDrift: { enabled: true, people: ["kai-cenat"], coverageMode: "relative" }, marketMood: { ratePerHour: 0 } });
    const store = createMemoryEngineStore({ people: [kai], driftNormals: { "p-kai": normal } });
    const first = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config });
    // Coverage 1 by construction, lean = 0.0216 / 0.1701: offset = 8 × lean.
    const lean = normal.signedPerHour / normal.grossPerHour;
    expect(first.people[0].targetOffset).toBeCloseTo(8 * lean, 2);
    expect(store.people[0].target_attention).toBeCloseTo(normal.grossPerHour, 4);
    expect(store.people[0].target_direction).toBeCloseTo(normal.signedPerHour, 4);
    expect(store.scoreEvents[0].details).toMatchObject({
      targetDrift: { enabled: true, listed: true, mode: "relative", normal: normal.grossPerHour, scale: normal.grossPerHour, fallback: false, started: "measured" },
    });
    // The next tick carries the row's state; a week of silence sinks coverage below the normal, so the offset falls from where it started.
    let last = first;
    for (let day = 1; day <= 7; day += 1) last = await runEngineTick({ store, scorer: rulesBasedScorer, now: new Date(NOW.getTime() + day * DAY), config });
    expect(store.scoreEvents.filter((e) => e.personId === "p-kai" && e.force === "gravity")[1].details).toMatchObject({ targetDrift: { started: "carried" } });
    expect(last.people[0].targetOffset).toBeLessThan(8 * lean);
    expect(last.people[0].targetOffset).toBeGreaterThan(-3);

    // The same person under the presumption instead: the flip starts at the seed (offset 0) and knows nothing of the normal.
    const presumed = createMemoryEngineStore({ people: [{ ...kai, current_score: 58 }], driftNormals: { "p-kai": normal } });
    const summary = await runEngineTick({ store: presumed, scorer: rulesBasedScorer, now: NOW, config: withEngineConfig({ targetDrift: { ...config.targetDrift, measuredStart: false } }) });
    expect(summary.people[0].targetOffset).toBeCloseTo(0, 3);
    expect(presumed.scoreEvents[0].details).toMatchObject({ targetDrift: { started: "presumed", normal: normal.grossPerHour, fallback: false } });
  });

  it("RELATIVE without fixture data: the memory store measures the normal from its own Signals rows, as the Supabase store reads score_events", async () => {
    const config = withEngineConfig({ targetDrift: { enabled: true, people: ["drake"], coverageMode: "relative" }, marketMood: { ratePerHour: 0 } });
    const store = createMemoryEngineStore(seed());
    // Nothing has been scored yet, so the flip is presumed and the fallback stands...
    const first = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config });
    expect(first.people.find((p) => p.slug === "drake")!.targetOffset).toBeCloseTo(0, 3);
    expect(store.scoreEvents.find((e) => e.personId === "p-drake" && e.force === "gravity")!.details).toMatchObject({ targetDrift: { fallback: true, started: "presumed" } });
    // ...and after days of praise the store's own rows give Drake a normal: the gravity row names it and the fallback lifts.
    for (let day = 1; day <= 5; day += 1) {
      const now = new Date(NOW.getTime() + day * DAY);
      for (let s = 0; s < 3; s += 1) store.signals.push(praise(`r-${day}-${s}`, "p-drake", now, `source-${s}`));
      await runEngineTick({ store, scorer: rulesBasedScorer, now, config });
    }
    const last = store.scoreEvents.filter((e) => e.personId === "p-drake" && e.force === "gravity").at(-1)!;
    const block = (last.details as { targetDrift: { normal: number | null; fallback: boolean; mode: string } }).targetDrift;
    expect(block.mode).toBe("relative");
    expect(block.fallback).toBe(false);
    expect(block.normal).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE TICK THAT ALWAYS COMMITS (Phase 11)
// ---------------------------------------------------------------------------

/** The production backlog shape at the time of the failure, on the three test people. */
function backlog(): EngineSignal[] {
  const make = (id: string, personId: string, minutesAgo: number): EngineSignal => {
    const at = new Date(NOW.getTime() - minutesAgo * 60_000);
    return { id, personId, headline: `${id} wins record award`, rawPayload: { kind: "article" }, sourceName: "rss", sourceTier: 2, occurredAt: at, createdAt: at };
  };
  return [
    ...Array.from({ length: 145 }, (_, i) => make(`mb-${String(i).padStart(3, "0")}`, "p-mrbeast", 3000 - i)),
    ...Array.from({ length: 82 }, (_, i) => make(`dr-${String(i).padStart(3, "0")}`, "p-drake", 2900 - i)),
    ...Array.from({ length: 55 }, (_, i) => make(`kl-${String(i).padStart(3, "0")}`, "p-kendrick", 2800 - i)),
  ];
}

/** An LLM scorer over a fake provider that answers every id in the prompt. */
function llmScorer(options: { failFor?: (personId: string) => boolean; callBudget?: number } = {}) {
  const usageLogger = createMemoryUsageLogger();
  const complete = vi.fn(async (request: { userPrompt: string }): Promise<LLMResponse> => {
    if (options.failFor && [...request.userPrompt.matchAll(/id=([\w-]+)/g)].some((m) => options.failFor!(m[1].slice(0, 2)))) {
      throw new LLMError("timed out", { kind: "timeout", provider: "fake", retryable: true });
    }
    const ids = [...request.userPrompt.matchAll(/id=([\w-]+)/g)].map((m) => m[1]);
    const signals = ids.map((id) => ({ id, label: "positive", confidence: 0.6, anomaly: "notable", rationale: "fake" }));
    return { text: "", structuredData: { signals, narrative: "Up on news." }, usage: { inputTokens: 2000, outputTokens: 700, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, provider: "fake", model: "fake-model", stopReason: "end_turn", latencyMs: 5 };
  });
  const scorer = new LLMScorer({ complete, usageLogger, batchDelayMs: 0, log: vi.fn(), config: { ...CONFIG.llm, callBudgetPerTick: options.callBudget ?? CONFIG.llm.callBudgetPerTick } });
  return { scorer, complete, usageLogger };
}

describe("Engine tick — the tick that always commits", () => {
  it("a 282-signal backlog: the tick COMMITS one chunk per person and leaves the rest unprocessed for the next tick", async () => {
    const signals = backlog();
    const store = createMemoryEngineStore(seed({ signals }));
    const { scorer, complete } = llmScorer();

    const summary = await runEngineTick({ store, scorer, now: NOW, config: withEngineConfig({ llm: { callBudgetPerTick: 4 } }) });

    // Committed: one tick, 36 signals (12 × 3 people), every one via the model, in exactly three calls.
    expect(store.ticks).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(summary.signalsProcessed).toBe(36);
    expect(summary.signals.every((s) => s.scorer === "llm")).toBe(true);
    expect(store.processedSignals).toHaveLength(36);
    expect(store.signals.filter((s) => s.processed)).toHaveLength(36);
    expect(store.signals.filter((s) => !s.processed)).toHaveLength(282 - 36);
    // The twelve NEWEST of each person (higher index = newer), so a call is spent where it moves a score.
    expect(store.signals.filter((s) => s.processed && s.personId === "p-mrbeast").map((s) => s.id).sort()).toEqual(signals.slice(133, 145).map((s) => s.id).sort());

    // The summary says exactly what happened and what is left.
    expect(summary.scoring).toEqual({
      backlogBefore: 282,
      loaded: 282,
      selected: 36,
      personOrder: ["kendrick-lamar", "drake", "mrbeast"], // nobody served yet: freshest waiting signal first
      attempted: 36,
      llmScored: 36,
      fallbacks: 0,
      withoutModel: 0,
      expired: 0,
      deferred: 0,
      deferredByReason: {},
      llmCalls: 3,
      llmCallBudget: 4,
      processed: 36,
      backlogAfter: 246,
      partial: true,
      budgetMs: expect.any(Number),
      remainingMs: expect.any(Number),
    });
    expect(summary.deferred).toEqual([]);

    // Gravity moved everyone, and the Signals force is braked at ±10 per person.
    for (const p of summary.people) {
      expect(p.forces.gravity).toBeGreaterThan(0);
      expect(Math.abs(p.forces.signals ?? 0)).toBeLessThanOrEqual(CONFIG.signals.maxAbsImpactPerTick);
    }

    // The next tick takes the next-newest chunk of each person: the backlog drains across ticks.
    const second = await runEngineTick({ store, scorer, now: new Date(NOW.getTime() + 30_000) });
    expect(second.tickNumber).toBe(2);
    expect(second.scoring).toMatchObject({ backlogBefore: 246, selected: 36, processed: 36, backlogAfter: 210, partial: true });
    expect(store.signals.filter((s) => s.processed && s.personId === "p-mrbeast").map((s) => s.id).sort()).toEqual(signals.slice(121, 145).map((s) => s.id).sort());
  });

  it("THE ROTATION: a person with a steady stream of fresh signals cannot crowd out a person whose newest signal is hours old", async () => {
    // Nine people: eight get a brand-new signal every tick, one has a single three-hour-old signal. Four calls per tick.
    const streamers = Array.from({ length: 8 }, (_, i) => makePerson({ id: `p-stream-${i}`, slug: `streamer-${i}`, display_name: `Streamer ${i}` }));
    const quiet = makePerson({ id: "p-quiet", slug: "quiet", display_name: "Quiet" });
    const fresh = (personId: string, tick: number, at: Date): EngineSignal => ({ id: `${personId}-t${tick}`, personId, headline: `${personId} wins record award`, rawPayload: { kind: "article" }, sourceName: "rss", sourceTier: 2, occurredAt: at, createdAt: at });
    const store = createMemoryEngineStore({
      people: [...streamers, quiet],
      signals: [...streamers.map((p) => fresh(p.id, 1, NOW)), { ...fresh("p-quiet", 1, new Date(NOW.getTime() - 3 * 3_600_000)), id: "quiet-only" }],
    });
    const { scorer } = llmScorer();
    const sequence: string[] = [];
    for (let tick = 1; tick <= 3; tick += 1) {
      const now = new Date(NOW.getTime() + (tick - 1) * 30_000);
      if (tick > 1) for (const p of streamers) store.signals.push(fresh(p.id, tick, now));
      const summary = await runEngineTick({ store, scorer, now });
      sequence.push(...summary.scoring.personOrder.slice(0, CONFIG.llm.callBudgetPerTick));
      // Four calls a tick; everything past the budget was deferred, never rules-scored, never dropped.
      expect(summary.scoring.llmCalls).toBe(CONFIG.llm.callBudgetPerTick);
      expect(summary.scoring.fallbacks).toBe(0);
      expect(summary.scoring.attempted + summary.scoring.deferred).toBe(summary.scoring.selected);
      expect(summary.deferred.every((d) => d.reason === "call_budget")).toBe(true);
    }
    // Nine people, four slots per tick: the first nine servings are nine different people, the quiet one at slot nine
    // (first in tick 3), and only then does anyone get a second turn, starting with the earliest served.
    expect(new Set(sequence.slice(0, 9)).size).toBe(9);
    expect(sequence[8]).toBe("quiet");
    expect(sequence.slice(9)).toEqual(["streamer-0", "streamer-1", "streamer-2"]);
    expect(store.signals.find((s) => s.id === "quiet-only")?.processed).toBe(true);
    // One chunk per person per tick held throughout: never more people served in a tick than the budget allows,
    // and never more than one chunk of a person's signals.
    const personOf = (id: string) => (id === "quiet-only" ? "p-quiet" : id.replace(/-t\d+$/, ""));
    for (const t of store.ticks) {
      const perPerson = new Map<string, number>();
      for (const s of t.signals) perPerson.set(personOf(s.id), (perPerson.get(personOf(s.id)) ?? 0) + 1);
      expect(perPerson.size).toBeLessThanOrEqual(CONFIG.llm.callBudgetPerTick);
      expect(Math.max(...perPerson.values())).toBeLessThanOrEqual(CONFIG.llm.maxSignalsPerCall);
    }
  });

  it("DEFERRED stays processed = false; FAILED is processed with a rules score; the two paths are distinct", async () => {
    const store = createMemoryEngineStore(seed({ signals: backlog() }));
    // Nobody has been served, so the freshest waiting signal orders the people: Kendrick, Drake, MrBeast.
    // Kendrick's call fails; the budget of 2 lets Drake through and defers MrBeast.
    const { scorer, complete, usageLogger } = llmScorer({ failFor: (prefix) => prefix === "kl", callBudget: 2 });

    const summary = await runEngineTick({ store, scorer, now: NOW, config: withEngineConfig({ llm: { callBudgetPerTick: 2 } }) });

    expect(store.ticks).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(summary.scoring.personOrder).toEqual(["kendrick-lamar", "drake", "mrbeast"]);

    // FAILED → rules-fallback, processed.
    const kendrick = summary.signals.filter((s) => s.personSlug === "kendrick-lamar");
    expect(kendrick).toHaveLength(12);
    expect(kendrick.every((s) => s.scorer === "rules-fallback")).toBe(true);
    expect(kendrick[0].rationale).toContain("fallback: LLM call failed (timeout: timed out)");
    expect(store.signals.filter((s) => s.personId === "p-kendrick" && s.processed)).toHaveLength(12);

    // Scored → llm, processed.
    expect(summary.signals.filter((s) => s.personSlug === "drake" && s.scorer === "llm")).toHaveLength(12);

    // DEFERRED → not in the summary's signals, not in the commit, still unprocessed.
    expect(summary.signals.some((s) => s.personSlug === "mrbeast")).toBe(false);
    expect(summary.deferred).toHaveLength(12);
    expect(summary.deferred.every((d) => d.personSlug === "mrbeast" && d.reason === "call_budget")).toBe(true);
    expect(store.signals.filter((s) => s.personId === "p-mrbeast" && s.processed)).toHaveLength(0);
    expect(store.ticks[0].signals.some((s) => s.id.startsWith("mb-"))).toBe(false);

    expect(summary.scoring).toMatchObject({ selected: 36, attempted: 24, llmScored: 12, fallbacks: 12, deferred: 12, deferredByReason: { call_budget: 12 }, llmCalls: 2, processed: 24, backlogAfter: 258, partial: true });
    expect(summary.signalsProcessed).toBe(24);
    // Both attempts are on the ledger; the deferred chunk is not.
    expect(usageLogger.rows.map((r) => r.status).sort()).toEqual(["completed", "failed"]);
  });

  it("with the deadline already reached, no model call starts, and the tick STILL COMMITS: Gravity for everyone, the free signals scored", async () => {
    const metric: EngineSignal = {
      id: "metric-1",
      personId: "p-drake",
      headline: "Drake monthly listeners +2.1σ",
      rawPayload: { kind: "metric", metric: "monthly_listeners", polarity: 1, sigma: 2.1, scale: 1 },
      sourceName: "spotify",
      sourceTier: 2,
      occurredAt: NOW,
      createdAt: NOW,
    };
    const store = createMemoryEngineStore(seed({ signals: [...backlog(), metric] }));
    const { scorer, complete } = llmScorer();

    const summary = await runEngineTick({ store, scorer, now: NOW, deadline: deadlineAfter(0) });

    expect(complete).not.toHaveBeenCalled();
    expect(store.ticks).toHaveLength(1);
    expect(store.scoreHistory.map((h) => h.tickNumber)).toEqual([1, 1, 1]);
    expect(store.scoreEvents.filter((e) => e.force === "gravity")).toHaveLength(3);
    expect(summary.people.every((p) => p.forces.gravity !== undefined && p.forces.gravity > 0)).toBe(true);
    // The metric signal never needs the model, so it is scored and processed even now.
    expect(summary.signals).toEqual([expect.objectContaining({ id: "metric-1", scorer: "metric", label: "positive" })]);
    expect(summary.scoring).toMatchObject({ selected: 37, attempted: 0, withoutModel: 1, deferred: 36, deferredByReason: { deadline: 36 }, llmCalls: 0, processed: 1, backlogAfter: 282, partial: true, remainingMs: 0 });
    expect(store.signals.filter((s) => s.processed).map((s) => s.id)).toEqual(["metric-1"]);
  });

  it("a tick with nothing to defer reports itself as complete", async () => {
    const store = createMemoryEngineStore(seed({ signals: backlog().slice(0, 5) }));
    const { scorer } = llmScorer();
    const summary = await runEngineTick({ store, scorer, now: NOW });
    expect(summary.scoring).toMatchObject({ backlogBefore: 5, selected: 5, processed: 5, deferred: 0, backlogAfter: 0, partial: false, llmCalls: 1 });
  });
});

// ---------------------------------------------------------------------------
// FRESHNESS (Phase 12)
// ---------------------------------------------------------------------------

function article(id: string, personId: string, ageHours: number, headline = "crosses 100M monthly listeners on Spotify"): EngineSignal {
  return {
    id,
    personId,
    headline,
    rawPayload: { kind: "article" },
    sourceName: "rss",
    sourceTier: 2,
    occurredAt: new Date(NOW.getTime() - ageHours * 3_600_000),
    createdAt: NOW,
  };
}

describe("Engine tick — freshness", () => {
  it("weights an event signal by the gap between occurred_at and the tick: a three-day-old headline lands at an eighth", async () => {
    const store = createMemoryEngineStore(seed({ signals: [article("fresh", "p-drake", 0), article("stale", "p-mrbeast", 72)] }));
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });

    // "crosses" → positive 0.8, tier 2: 1.2 fresh; × 2^(−72/24) = 0.15 three days on.
    expect(summary.signals.find((s) => s.id === "fresh")).toMatchObject({ impact: 1.2, ageHours: 0, freshness: 1, scorer: undefined });
    expect(summary.signals.find((s) => s.id === "stale")).toMatchObject({ impact: 0.15, ageHours: 72, freshness: 0.125 });
    expect(summary.people.find((p) => p.slug === "drake")?.forces.signals).toBe(1.2);
    expect(summary.people.find((p) => p.slug === "mrbeast")?.forces.signals).toBe(0.15);
    // Both are processed exactly once; Gravity, not this, handles the score afterwards.
    expect(store.signals.every((s) => s.processed)).toBe(true);
    expect(store.processedSignals.map((s) => [s.id, s.impactScore])).toEqual([
      ["fresh", 1.2],
      ["stale", 0.15],
    ]);
  });

  it("an EXPIRED signal (past 7 days) is processed with zero impact and never sent to the model", async () => {
    const store = createMemoryEngineStore(seed({ signals: [article("old", "p-drake", 24 * 8), article("new", "p-drake", 1)] }));
    const { scorer, complete } = llmScorer();

    const summary = await runEngineTick({ store, scorer, now: NOW });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].userPrompt).toContain("id=new");
    expect(complete.mock.calls[0][0].userPrompt).not.toContain("id=old");
    const old = summary.signals.find((s) => s.id === "old")!;
    expect(old).toMatchObject({ scorer: "expired", label: "neutral", impact: 0, freshness: 0, ageHours: 192 });
    expect(old.rationale).toContain("past the 7-day freshness limit");
    expect(summary.signals.find((s) => s.id === "new")).toMatchObject({ scorer: "llm", freshness: 0.972 });
    // Processed, both of them: the expired one does not linger in the backlog.
    expect(store.signals.every((s) => s.processed)).toBe(true);
    expect(store.processedSignals.find((s) => s.id === "old")).toMatchObject({ impactScore: 0, sentimentLabel: "neutral", sentimentConfidence: 0 });
    expect(summary.scoring).toMatchObject({ selected: 2, attempted: 1, llmScored: 1, withoutModel: 1, expired: 1, processed: 2, backlogAfter: 0, partial: false });
  });

  it("a stale backlog drains in ONE tick at no cost: expired signals are free like metrics, beyond the per-person chunk", async () => {
    const stale = Array.from({ length: 300 }, (_, i) => article(`s-${String(i).padStart(3, "0")}`, "p-mrbeast", 24 * 8 + i));
    const store = createMemoryEngineStore(seed({ signals: stale }));
    const { scorer, complete } = llmScorer();

    const summary = await runEngineTick({ store, scorer, now: NOW });

    expect(complete).not.toHaveBeenCalled();
    expect(summary.scoring).toMatchObject({ backlogBefore: 300, selected: 300, attempted: 0, expired: 300, llmCalls: 0, processed: 300, backlogAfter: 0, partial: false });
    expect(store.signals.filter((s) => !s.processed)).toHaveLength(0);
    expect(summary.people.find((p) => p.slug === "mrbeast")?.forces.signals).toBeUndefined(); // nothing moved
  });

  it("metric signals are never aged and never expire", async () => {
    const metric: EngineSignal = {
      id: "metric-old",
      personId: "p-drake",
      headline: "Drake monthly listeners +2.1σ",
      rawPayload: { kind: "metric", metric: "monthly_listeners", polarity: 1, sigma: 2.1, scale: 1 },
      sourceName: "spotify",
      sourceTier: 2,
      occurredAt: new Date(NOW.getTime() - 10 * 24 * 3_600_000),
      createdAt: NOW,
    };
    const store = createMemoryEngineStore(seed({ signals: [metric] }));
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW });
    // sigma 2.1 / fullConfidenceSigma 3 = confidence 0.7; tier 2: 1.5 × 1.0 × 0.7 = 1.05, no age factor.
    expect(summary.signals[0]).toMatchObject({ id: "metric-old", scorer: "metric", freshness: 1, ageHours: 240, impact: 1.05 });
    expect(summary.scoring.expired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE NEWS-VOLUME TUNE (variant C, 2026-10-02)
// ---------------------------------------------------------------------------

describe("Engine tick — the news-volume tune", () => {
  const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
  const article = (id: string, headline: string, minutesAgo: number): EngineSignal => ({ id, personId: "p-drake", headline, rawPayload: { kind: "article" }, sourceName: "rss", sourceTier: 2, occurredAt: minutesBefore(minutesAgo), createdAt: NOW });
  const firing = (id: string, sigma: number, at: Date): EngineSignal => ({
    id,
    personId: "p-drake",
    headline: "Drake is getting more coverage than usual",
    rawPayload: { kind: "metric", metric: "news_volume_24h", label: "news volume", sigma, polarity: 1, scale: 0.7, window_hours: 336, source: "rss" },
    sourceName: "rss",
    sourceTier: 2,
    occurredAt: at,
    createdAt: at,
  });
  const allegations = [article("a1", "Drake sued over lawsuit claims", 30), article("a2", "Drake scandal deepens as fraud alleged", 20), article("a3", "Drake arrested, charged with fraud", 10)];
  const quiet = withEngineConfig({ marketMood: { ratePerHour: 0 }, inversePairs: { defaultDampening: 0 } });
  const tuned = withEngineConfig({ newsVolume: { enabled: true } }, quiet);

  it("off, the metric scorer's reading stands: a surge is a positive move whatever the stories say", async () => {
    const store = createMemoryEngineStore(seed({ signals: [...allegations, firing("nv", 3, NOW)] }));
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config: quiet });
    const nv = summary.signals.find((s) => s.id === "nv")!;
    expect(nv.impact).toBeCloseTo(1.5 * 1 * 0.7, 6);
    expect(nv.newsVolume).toBeUndefined();
  });

  it("on, the firing takes the rule's reading: signed by its stories, sized by the surge, capped; the stories themselves are untouched", async () => {
    const store = createMemoryEngineStore(seed({ signals: [...allegations, firing("nv", 3, NOW)] }));
    const summary = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config: tuned });
    const stories = summary.signals.filter((s) => s.id.startsWith("a"));
    expect(stories).toHaveLength(3);
    expect(stories.every((s) => s.impact < 0)).toBe(true);
    const signed = stories.reduce((sum, s) => sum + s.impact, 0);
    const nv = summary.signals.find((s) => s.id === "nv")!;
    expect(nv.newsVolume).toMatchObject({ sigma: 3, signedStories: 3, balance: -1, multiplier: 1.5, zeroBecause: null, dayBefore: { peakSigma: null, applied: 0 } });
    expect(nv.impact).toBeCloseTo(-Math.min(0.75, 0.5 * Math.abs(signed)), 6);
    // The stored impact is the rule's, so the day's state can be read back from it.
    expect(store.processedSignals.find((s) => s.id === "nv")?.impactScore).toBeCloseTo(nv.impact, 6);
    const event = store.scoreEvents.find((e) => e.personId === "p-drake" && e.force === "signals")!;
    expect((event.details as { signals: Array<{ id: string; newsVolume?: unknown }> }).signals.find((s) => s.id === "nv")?.newsVolume).toBeDefined();
  });

  it("across ticks, the day keeps a running peak: a smaller firing adds nothing, a larger one adds the difference, and a lull nothing", async () => {
    const store = createMemoryEngineStore(seed({ signals: [...allegations, firing("nv1", 3, NOW)] }));
    const first = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config: tuned });
    const applied = first.signals.find((s) => s.id === "nv1")!.impact;
    expect(applied).toBeLessThan(0);

    const t2 = new Date(NOW.getTime() + 30_000);
    store.signals.push({ ...firing("nv2", 2.5, t2) });
    const second = await runEngineTick({ store, scorer: rulesBasedScorer, now: t2, config: tuned });
    expect(second.signals.find((s) => s.id === "nv2")).toMatchObject({ impact: 0, newsVolume: { zeroBecause: "not_the_peak", dayBefore: { peakSigma: 3, applied: expect.closeTo(applied, 6) } } });

    const t3 = new Date(NOW.getTime() + 60_000);
    store.signals.push({ ...firing("nv3", 4, t3) });
    const third = await runEngineTick({ store, scorer: rulesBasedScorer, now: t3, config: tuned });
    const nv3 = third.signals.find((s) => s.id === "nv3")!;
    expect(nv3.newsVolume?.multiplier).toBe(2);
    expect(nv3.newsVolume?.reading).toBeCloseTo(Math.max(-0.75, 2 * applied), 6);
    expect(nv3.impact).toBeCloseTo(nv3.newsVolume!.reading - applied, 6);

    const t4 = new Date(NOW.getTime() + 90_000);
    store.signals.push({ ...firing("nv4", -2.2, t4) });
    const fourth = await runEngineTick({ store, scorer: rulesBasedScorer, now: t4, config: tuned });
    expect(fourth.signals.find((s) => s.id === "nv4")).toMatchObject({ impact: 0, newsVolume: { zeroBecause: "lull" } });
  });
});
