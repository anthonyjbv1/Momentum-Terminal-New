import { describe, expect, it } from "vitest";

import { makePerson } from "@/lib/__tests__/fixtures";

import { DEFAULT_ENGINE_CONFIG, describeEngineOverrides, engineConfigFromEnv, withEngineConfig } from "./config";
import { salienceWeight, scoreSignals, signalImpact } from "./forces/signals";
import { rulesBasedScorer } from "./sentiment/rules";
import type { SentimentResult } from "./sentiment/types";
import { createMemoryEngineStore, type MemoryEngineSeed } from "./store";
import { runEngineTick } from "./tick";
import type { EngineSignal } from "./types";

/**
 * PHASE 31 — THE ONE SWITCH, and what it does not do while off.
 *
 * Nothing that moves a score ships until the operator says so, so the first
 * thing to prove is that with SIGNAL_QUALITY_ENABLED unset a tick is what it
 * was: same impacts, same forces, same processed rows, whatever labels a
 * scorer's result happens to carry and however many copies of a story arrive.
 * Then that with it on, the two levers do exactly what the design says.
 */

const NOW = new Date("2026-09-25T19:11:00.000Z");
const ON = withEngineConfig({ signalQuality: { ...DEFAULT_ENGINE_CONFIG.signalQuality, enabled: true } });

function article(id: string, personId: string, headline: string, occurredAt = NOW): EngineSignal {
  return { id, personId, headline, rawPayload: { kind: "article" }, sourceName: "rss", sourceTier: 2, occurredAt, createdAt: occurredAt };
}

describe("the switch", () => {
  it("ships OFF, and only the exact string \"true\" in SIGNAL_QUALITY_ENABLED turns it on", () => {
    expect(DEFAULT_ENGINE_CONFIG.signalQuality.enabled).toBe(false);
    for (const raw of [undefined, "", "false", "1", "TRUE", " yes "]) expect(engineConfigFromEnv({ signalQualityEnabled: raw }).signalQuality.enabled, JSON.stringify(raw)).toBe(false);
    const on = engineConfigFromEnv({ signalQualityEnabled: "true" });
    expect(on.signalQuality.enabled).toBe(true);
    // Turning it on keeps every tunable of the section: the block is handed over whole.
    expect(on.signalQuality).toEqual({ ...DEFAULT_ENGINE_CONFIG.signalQuality, enabled: true });
    expect(describeEngineOverrides(on)).toEqual(["signalQuality.enabled = true (default false)"]);
    expect(describeEngineOverrides(DEFAULT_ENGINE_CONFIG)).toEqual([]);
  });

  it("names the proposed values: 1.0 / 0.3 / 0 salience, a 48-hour story window, confirmations at a fifth capped at 0.15", () => {
    expect(DEFAULT_ENGINE_CONFIG.signalQuality).toEqual({
      enabled: false,
      salienceMultipliers: { relevant: 1, incidental: 0.3, unrelated: 0 },
      storyWindowHours: 48,
      storyAnchorThreshold: 0.25,
      storyConfirmationShare: 0.2,
      storyConfirmationCap: 0.15,
    });
    // The story window is the ingestion lookback: the two agree on what "the same day's story" means.
    expect(DEFAULT_ENGINE_CONFIG.signalQuality.storyWindowHours).toBe(48);
  });
});

describe("salience", () => {
  const sentiment = (salience?: SentimentResult["salience"]): SentimentResult => ({ label: "negative", confidence: 0.8, direction: -1, ...(salience ? { salience } : {}) });

  it("multiplies the impact only while the switch is on; off, a label changes nothing", () => {
    const signal = article("s", "p", "Zuckerberg, Altman, other Big Tech moguls among attendees at Trump-Xi dinner");
    const off = DEFAULT_ENGINE_CONFIG.signalQuality;
    const on = ON.signalQuality;
    expect(salienceWeight(sentiment("incidental"), off)).toBe(1);
    expect(salienceWeight(sentiment("incidental"), undefined)).toBe(1);
    expect(salienceWeight(sentiment("incidental"), on)).toBe(0.3);
    expect(salienceWeight(sentiment("unrelated"), on)).toBe(0);
    expect(salienceWeight(sentiment("relevant"), on)).toBe(1);
    expect(salienceWeight(sentiment(), on)).toBe(1);

    const full = signalImpact(signal, sentiment("incidental"), DEFAULT_ENGINE_CONFIG.signals, NOW, 1, off);
    expect(full).toBeCloseTo(-1.5 * 1.0 * 0.8, 9);
    expect(signalImpact(signal, sentiment("incidental"), DEFAULT_ENGINE_CONFIG.signals, NOW, 1, on)).toBeCloseTo(full * 0.3, 9);
    expect(signalImpact(signal, sentiment("unrelated"), DEFAULT_ENGINE_CONFIG.signals, NOW, 1, on)).toBe(-0);
  });

  it("is carried on the scored signal only while on, so audit rows written before say nothing about it", () => {
    const signal = article("s", "p", "x");
    const off = scoreSignals([signal], new Map([["s", sentiment("incidental")]]), DEFAULT_ENGINE_CONFIG.signals, NOW, 1, DEFAULT_ENGINE_CONFIG.signalQuality);
    expect(off[0].salienceWeight).toBeUndefined();
    const on = scoreSignals([signal], new Map([["s", sentiment("incidental")]]), DEFAULT_ENGINE_CONFIG.signals, NOW, 1, ON.signalQuality);
    expect(on[0].salienceWeight).toBe(0.3);
  });
});

describe("a tick with the switch off equals a tick before Phase 31", () => {
  const zuck = makePerson({ id: "p-zuck", slug: "mark-zuckerberg", display_name: "Mark Zuckerberg", full_name: "Mark Elliot Zuckerberg", category: "executive", revert_target: 70 });
  // The production pair, as stored: below the ingestion threshold (Dice 0.353), one story by its shared number.
  const first = "Mark Zuckerberg Loses $9 Billion In A Day Amid AI Overspending Fears";
  const second = "Mark Zuckerberg Loses $9 Billion In A Day As Goldman Sachs Pours Cold Water On Meta Stock Rally";
  const seed = (): MemoryEngineSeed => ({ people: [zuck], signals: [article("s1", "p-zuck", first, NOW), article("s2", "p-zuck", second, NOW)] });

  it("off: both copies score at full impact, and no story or salience field appears anywhere in the summary", async () => {
    const summary = await runEngineTick({ store: createMemoryEngineStore(seed()), scorer: rulesBasedScorer, now: NOW });
    const impacts = summary.signals.map((s) => s.impact);
    expect(impacts).toHaveLength(2);
    expect(impacts[0]).toBe(impacts[1]);
    expect(impacts[0]).toBeLessThan(0);
    for (const s of summary.signals) {
      expect(s.story).toBeUndefined();
      expect(s.salience).toBeUndefined();
      expect(s.salienceWeight).toBeUndefined();
    }
    const force = summary.people[0].forces.signals ?? 0;
    // Two copies, one strength, summed in quadrature: √2 of one copy.
    expect(force).toBeCloseTo((impacts[0] * 2) / Math.sqrt(2), 3);
  });

  it("on: the second copy confirms the first at a fifth of its impact, capped, and the force says so", async () => {
    const summary = await runEngineTick({ store: createMemoryEngineStore(seed()), scorer: rulesBasedScorer, now: NOW, config: ON });
    const bySignal = new Map(summary.signals.map((s) => [s.id, s]));
    const leader = [...bySignal.values()].find((s) => !s.story);
    const copy = [...bySignal.values()].find((s) => s.story);
    expect(leader).toBeDefined();
    expect(copy).toBeDefined();
    expect(copy?.story).toMatchObject({ leaderId: leader?.id, leader: "tick", anchor: "9 billion" });
    expect(Math.abs(copy?.impact ?? 0)).toBeCloseTo(Math.min(Math.abs(copy?.story?.fullImpact ?? 0) * 0.2, 0.15), 4);
    // The rules scorer gives no salience label, so the weight is 1 and nothing is zeroed by its absence.
    expect(copy?.salienceWeight).toBe(1);
    expect(leader?.salienceWeight).toBe(1);
  });

  it("on, the store hands the tick the stories it already scored, and a copy arriving a tick later is bounded against them", async () => {
    const store = createMemoryEngineStore({ people: [zuck], signals: [article("s1", "p-zuck", first, NOW)] });
    const one = await runEngineTick({ store, scorer: rulesBasedScorer, now: NOW, config: ON });
    expect(one.signals[0].story).toBeUndefined();
    store.signals.push({ ...article("s2", "p-zuck", second, new Date(NOW.getTime() + 60_000)), processed: false });
    const two = await runEngineTick({ store, scorer: rulesBasedScorer, now: new Date(NOW.getTime() + 60_000), config: ON });
    expect(two.signals).toHaveLength(1);
    expect(two.signals[0].story).toMatchObject({ leaderId: "s1", leader: "recent", anchor: "9 billion" });
    expect(Math.abs(two.signals[0].impact)).toBeLessThan(Math.abs(one.signals[0].impact));
  });
});
