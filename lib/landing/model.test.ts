import { describe, expect, it } from "vitest";

import { LIVE_TICK_MS } from "@/lib/person/live-series";
import { FORCE_DEFINITIONS, FORCE_KEYS, SCORE_FORCE_KEYS } from "@/lib/person/profile-model";

import { FEATURED_PAYLOAD_KEYS, FEATURED_SIGNAL_LIMIT, FEATURED_SLUG, STALE_AFTER_MS, changeOver, isStale, parseFeaturedPayload, tickSlot } from "./model";
import { FEATURED } from "./copy";

/**
 * The landing page's model (Phase 28): the payload is an allowlist, the
 * featured person is a constant, and "Live" versus "Last known" is a rule.
 */

const NOW = Date.parse("2026-09-23T12:00:00Z");

function full() {
  return {
    score: 61.2345,
    tickNumber: 16_700,
    lastTickAt: "2026-09-23T11:59:30Z",
    change: { h1: 0.12, h24: -0.4, d7: 2.5 },
    history: [
      { at: "2026-09-22T12:00:00Z", score: 60.1 },
      { at: "2026-09-23T11:59:30Z", score: 61.2 },
    ],
    forces: [
      { key: "signals", impact: 0.5 },
      { key: "gravity", impact: -0.02 },
    ],
    windowMinutes: 60,
    signals: [{ source: "Google News", headline: "A headline.", occurredAt: "2026-09-23T11:00:00Z", impact: 0.5 }],
    generatedAt: "2026-09-23T12:00:00Z",
  };
}

describe("the featured person", () => {
  it("is one slug, written in code, and the copy names the same person", () => {
    expect(FEATURED_SLUG).toBe("anthony-baptiste");
    expect(FEATURED.slug).toBe(FEATURED_SLUG);
  });
});

describe("parseFeaturedPayload", () => {
  it("keeps exactly the allowlisted fields and drops everything else", () => {
    const parsed = parseFeaturedPayload({
      ...full(),
      id: "00000000-0000-4000-8000-000000000000",
      slug: "someone-else",
      userId: "u1",
      positions: [{ units: 5 }],
      balance_cents: 100,
      displayName: "Somebody",
    });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!).sort()).toEqual([...FEATURED_PAYLOAD_KEYS].sort());
    expect(JSON.stringify(parsed)).not.toMatch(/someone-else|u1|positions|balance|Somebody|0000-4000/);
  });

  it("is null without a score: a page with no number shows no number", () => {
    expect(parseFeaturedPayload(null)).toBeNull();
    expect(parseFeaturedPayload("61")).toBeNull();
    expect(parseFeaturedPayload({})).toBeNull();
    expect(parseFeaturedPayload({ score: "abc" })).toBeNull();
    expect(parseFeaturedPayload({ score: Number.NaN })).toBeNull();
    expect(parseFeaturedPayload({ score: "61.5" })?.score).toBe(61.5);
  });

  it("fills a minimal payload with honest nulls, never made-up numbers", () => {
    const parsed = parseFeaturedPayload({ score: 50 })!;
    expect(parsed.tickNumber).toBeNull();
    expect(parsed.lastTickAt).toBeNull();
    expect(parsed.change).toEqual({ h1: null, h24: null, d7: null });
    expect(parsed.history).toEqual([]);
    expect(parsed.signals).toEqual([]);
    expect(parsed.forces).toEqual(SCORE_FORCE_KEYS.map((key) => ({ key, impact: null })));
  });

  it("returns every force that moves the score in the canonical order, whatever order or subset arrived", () => {
    const parsed = parseFeaturedPayload(full())!;
    expect(parsed.forces.map((force) => force.key)).toEqual(["gravity", "signals", "market_mood"]);
    expect(parsed.forces.find((force) => force.key === "signals")?.impact).toBe(0.5);
    expect(parsed.forces.find((force) => force.key === "gravity")?.impact).toBe(-0.02);
    expect(parsed.forces.find((force) => force.key === "market_mood")?.impact).toBeNull();
    // An unknown force is not a force.
    const odd = parseFeaturedPayload({ score: 1, forces: [{ key: "luck", impact: 9 }] })!;
    expect(odd.forces.every((force) => force.impact === null)).toBe(true);
  });

  it("drops the market forces: Conviction and Trading Activity move the market price, not the score (Phase 29b)", () => {
    // The score forces are exactly the forces whose role is "score".
    expect([...SCORE_FORCE_KEYS]).toEqual(FORCE_KEYS.filter((key) => FORCE_DEFINITIONS[key].role === "score"));
    const parsed = parseFeaturedPayload({
      score: 1,
      forces: [
        { key: "conviction", impact: 3 },
        { key: "trading_activity", impact: -2 },
        { key: "signals", impact: 0.25 },
      ],
    })!;
    expect(parsed.forces).toEqual([
      { key: "gravity", impact: null },
      { key: "signals", impact: 0.25 },
      { key: "market_mood", impact: null },
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/conviction|trading_activity/);
  });

  it("drops malformed history points and signals, and caps the signals", () => {
    const parsed = parseFeaturedPayload({
      score: 1,
      history: [{ at: "not a date", score: 1 }, { at: "2026-09-23T00:00:00Z" }, { at: "2026-09-23T00:00:00Z", score: 2 }, "x"],
      signals: Array.from({ length: FEATURED_SIGNAL_LIMIT + 4 }, (_, index) => ({ source: "s", headline: `h${index}`, occurredAt: "2026-09-23T00:00:00Z", impact: null })),
    })!;
    expect(parsed.history).toEqual([{ at: "2026-09-23T00:00:00Z", score: 2 }]);
    expect(parsed.signals).toHaveLength(FEATURED_SIGNAL_LIMIT);
    const bad = parseFeaturedPayload({ score: 1, signals: [{ headline: "no time" }, { occurredAt: "2026-09-23T00:00:00Z" }, { headline: "ok", occurredAt: "2026-09-23T00:00:00Z" }] })!;
    expect(bad.signals).toEqual([{ source: "Unknown source", headline: "ok", occurredAt: "2026-09-23T00:00:00Z", impact: null }]);
  });

  it("round-trips its own output", () => {
    const once = parseFeaturedPayload(full())!;
    expect(parseFeaturedPayload(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe("Live versus Last known", () => {
  it("is Live within three cadences of the last tick and Last known after, or with no tick at all", () => {
    expect(STALE_AFTER_MS).toBe(3 * LIVE_TICK_MS);
    const at = new Date(NOW - 10_000).toISOString();
    expect(isStale(at, NOW)).toBe(false);
    expect(isStale(new Date(NOW - STALE_AFTER_MS).toISOString(), NOW)).toBe(false);
    expect(isStale(new Date(NOW - STALE_AFTER_MS - 1).toISOString(), NOW)).toBe(true);
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale("garbage", NOW)).toBe(true);
  });
});

describe("the server memo's key", () => {
  it("is the 30-second slot, so two requests in one slot share a read and the next slot reads fresh", () => {
    const boundary = Math.floor(NOW / LIVE_TICK_MS) * LIVE_TICK_MS;
    expect(tickSlot(boundary)).toBe(tickSlot(boundary + LIVE_TICK_MS - 1));
    expect(tickSlot(boundary + LIVE_TICK_MS)).toBe(tickSlot(boundary) + 1);
  });
});

describe("changeOver", () => {
  it("is last close minus first open over the series, and null with fewer than two ticks", () => {
    expect(changeOver([])).toBeNull();
    expect(changeOver([{ at: "2026-09-23T00:00:00Z", score: 50, open: 50, samples: 1 }])).toBeNull();
    expect(
      changeOver([
        { at: "2026-09-23T00:00:00Z", score: 50.2, open: 50, samples: 2 },
        { at: "2026-09-23T00:10:00Z", score: 51.5, open: 50.2, samples: 3 },
      ]),
    ).toBeCloseTo(1.5, 10);
  });
});
