import { describe, expect, it } from "vitest";

import {
  BEHAVIORAL_EVENT_DEFINITIONS,
  BEHAVIORAL_EVENT_TYPES,
  BEHAVIORAL_LIMITS,
  isBehavioralEventType,
  sanitizeMetadata,
  validateBehavioralEvent,
} from "./events";

const PERSON = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

describe("canonical event types", () => {
  it("lists the eighteen documented types, each with a definition", () => {
    expect([...BEHAVIORAL_EVENT_TYPES]).toEqual([
      "view_person",
      "time_spent",
      "expand_signal",
      "take_position",
      "close_position",
      "follow_person",
      "unfollow_person",
      "search",
      "view_feed",
      "swipe",
      "change_range",
      "view_entry",
      "scroll_depth",
      "filter_change",
      "open_trade_sheet",
      "abandon_trade_sheet",
      "reject_trade",
      "view_portfolio",
    ]);
    for (const type of BEHAVIORAL_EVENT_TYPES) {
      expect(BEHAVIORAL_EVENT_DEFINITIONS[type].description.length).toBeGreaterThan(0);
    }
    expect(isBehavioralEventType("view_person")).toBe(true);
    expect(isBehavioralEventType("follow")).toBe(false);
    expect(isBehavioralEventType(42)).toBe(false);
  });

  it("every type name satisfies the database format check", () => {
    for (const type of BEHAVIORAL_EVENT_TYPES) expect(type).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
  });
});

describe("validateBehavioralEvent", () => {
  it("accepts a minimal view_person and normalises ids", () => {
    const result = validateBehavioralEvent({ eventType: "view_person", personId: PERSON.toUpperCase(), sessionId: SESSION });
    expect(result).toEqual({
      ok: true,
      event: { eventType: "view_person", personId: PERSON, metadata: null, sessionId: SESSION },
    });
  });

  it("accepts snake_case keys (what the API body may carry)", () => {
    const result = validateBehavioralEvent({ event_type: "view_feed", session_id: SESSION, metadata: { feed: "home" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event).toMatchObject({ eventType: "view_feed", personId: null, sessionId: SESSION, metadata: { feed: "home" } });
  });

  it("rejects unknown and malformed types", () => {
    expect(validateBehavioralEvent({ eventType: "follow", personId: PERSON })).toEqual({ ok: false, reason: 'unknown eventType "follow"' });
    expect(validateBehavioralEvent({ personId: PERSON })).toEqual({ ok: false, reason: "eventType is required" });
    expect(validateBehavioralEvent("view_person")).toEqual({ ok: false, reason: "event must be an object" });
    expect(validateBehavioralEvent(null)).toEqual({ ok: false, reason: "event must be an object" });
  });

  it("requires personId where the definition says so, and a valid UUID when present", () => {
    expect(validateBehavioralEvent({ eventType: "view_person" })).toEqual({ ok: false, reason: "view_person requires personId" });
    expect(validateBehavioralEvent({ eventType: "view_person", personId: "drake" })).toEqual({ ok: false, reason: "personId must be a UUID" });
    expect(validateBehavioralEvent({ eventType: "search", metadata: { query: "drake" } }).ok).toBe(true);
  });

  it("uses the default session id when the event has none, and nulls an invalid one instead of failing", () => {
    const withDefault = validateBehavioralEvent({ eventType: "view_feed" }, { sessionId: SESSION });
    expect(withDefault.ok && withDefault.event.sessionId).toBe(SESSION);
    const invalid = validateBehavioralEvent({ eventType: "view_feed", sessionId: "nope" }, { sessionId: SESSION });
    expect(invalid.ok && invalid.event.sessionId).toBeNull();
  });

  it("ignores a client-supplied user id", () => {
    const result = validateBehavioralEvent({ eventType: "view_feed", userId: "someone-else", user_id: "someone-else" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.event)).not.toContain("someone-else");
  });

  describe("per-type metadata contracts", () => {
    it("time_spent needs duration_ms, rounds and clamps it", () => {
      expect(validateBehavioralEvent({ eventType: "time_spent", personId: PERSON })).toMatchObject({ ok: false, reason: expect.stringContaining("duration_ms") });
      expect(validateBehavioralEvent({ eventType: "time_spent", personId: PERSON, metadata: { duration_ms: -1 } }).ok).toBe(false);
      const ok = validateBehavioralEvent({ eventType: "time_spent", personId: PERSON, metadata: { duration_ms: 1234.6 } });
      expect(ok.ok && ok.event.metadata).toEqual({ duration_ms: 1235 });
      const clamped = validateBehavioralEvent({ eventType: "time_spent", personId: PERSON, metadata: { duration_ms: 1e12 } });
      expect(clamped.ok && clamped.event.metadata?.duration_ms).toBe(BEHAVIORAL_LIMITS.maxDurationMs);
    });

    it("time_spent without a person needs a surface (the portfolio is about no single person)", () => {
      expect(validateBehavioralEvent({ eventType: "time_spent", metadata: { duration_ms: 4000 } })).toEqual({
        ok: false,
        reason: "time_spent requires personId or a non-empty metadata.surface",
      });
      expect(validateBehavioralEvent({ eventType: "time_spent", metadata: { duration_ms: 4000, surface: "  " } }).ok).toBe(false);
      const portfolio = validateBehavioralEvent({ eventType: "time_spent", metadata: { duration_ms: 4000, surface: "portfolio" } });
      expect(portfolio.ok && portfolio.event).toEqual({ eventType: "time_spent", personId: null, metadata: { duration_ms: 4000, surface: "portfolio" }, sessionId: null });
    });

    it("view_portfolio takes optional counts and nothing else is required", () => {
      expect(validateBehavioralEvent({ eventType: "view_portfolio" }).ok).toBe(true);
      expect(validateBehavioralEvent({ eventType: "view_portfolio", metadata: { positions: 2, orders: 7 } }).ok).toBe(true);
      expect(validateBehavioralEvent({ eventType: "view_portfolio", metadata: { positions: -1 } })).toMatchObject({ ok: false, reason: expect.stringContaining("positions") });
      expect(validateBehavioralEvent({ eventType: "view_portfolio", metadata: { orders: 1.5 } }).ok).toBe(false);
    });

    it("take_position needs direction and integer amount_cents", () => {
      expect(validateBehavioralEvent({ eventType: "take_position", personId: PERSON, metadata: { amount_cents: 500 } }).ok).toBe(false);
      expect(validateBehavioralEvent({ eventType: "take_position", personId: PERSON, metadata: { direction: "HIGH", amount_cents: 5.5 } }).ok).toBe(false);
      expect(validateBehavioralEvent({ eventType: "take_position", personId: PERSON, metadata: { direction: "sideways", amount_cents: 500 } }).ok).toBe(false);
      const ok = validateBehavioralEvent({ eventType: "take_position", personId: PERSON, metadata: { direction: "low", amount_cents: 2500 } });
      expect(ok.ok && ok.event.metadata).toEqual({ direction: "LOW", amount_cents: 2500 });
    });

    it("close_position validates optional fields only", () => {
      expect(validateBehavioralEvent({ eventType: "close_position", personId: PERSON }).ok).toBe(true);
      expect(validateBehavioralEvent({ eventType: "close_position", personId: PERSON, metadata: { pnl_cents: 1.5 } }).ok).toBe(false);
      const ok = validateBehavioralEvent({ eventType: "close_position", personId: PERSON, metadata: { direction: "high", pnl_cents: -300 } });
      expect(ok.ok && ok.event.metadata).toEqual({ direction: "HIGH", pnl_cents: -300 });
    });

    it("search needs a non-empty query", () => {
      expect(validateBehavioralEvent({ eventType: "search", metadata: { query: "   " } }).ok).toBe(false);
      const ok = validateBehavioralEvent({ eventType: "search", metadata: { query: "  drake ", result_count: 3 } });
      expect(ok.ok && ok.event.metadata).toEqual({ query: "drake", result_count: 3 });
    });

    it("swipe needs a known action and accepts direction as an alias", () => {
      expect(validateBehavioralEvent({ eventType: "swipe", personId: PERSON, metadata: { action: "diagonal" } }).ok).toBe(false);
      const ok = validateBehavioralEvent({ eventType: "swipe", personId: PERSON, metadata: { direction: "Right" } });
      expect(ok.ok && ok.event.metadata).toEqual({ action: "right" });
    });

    it("expand_signal checks signal_id when present", () => {
      expect(validateBehavioralEvent({ eventType: "expand_signal", personId: PERSON, metadata: { signal_id: "abc" } }).ok).toBe(false);
      expect(validateBehavioralEvent({ eventType: "expand_signal", personId: PERSON, metadata: { headline: "Drake drops album" } }).ok).toBe(true);
    });

    it("view_entry needs a person, an entry id and a known kind", () => {
      expect(validateBehavioralEvent({ eventType: "view_entry", metadata: { entry_id: "e1", kind: "narrative" } }).ok).toBe(false);
      expect(validateBehavioralEvent({ eventType: "view_entry", personId: PERSON, metadata: { kind: "narrative" } }).ok).toBe(false);
      expect(validateBehavioralEvent({ eventType: "view_entry", personId: PERSON, metadata: { entry_id: "e1", kind: "headline" } }).ok).toBe(false);
      expect(validateBehavioralEvent({ eventType: "view_entry", personId: PERSON, metadata: { entry_id: "e1", kind: "signal", position: -1 } }).ok).toBe(false);
      const ok = validateBehavioralEvent({ eventType: "view_entry", personId: PERSON, metadata: { entry_id: " e1 ", kind: "Narrative", feed: "feed", position: 3, pinned: true } });
      expect(ok.ok && ok.event.metadata).toEqual({ entry_id: "e1", kind: "narrative", feed: "feed", position: 3, pinned: true });
    });

    it("scroll_depth needs a feed and a whole percentage", () => {
      expect(validateBehavioralEvent({ eventType: "scroll_depth", metadata: { depth_pct: 50 } }).ok).toBe(false);
      expect(validateBehavioralEvent({ eventType: "scroll_depth", metadata: { feed: "feed", depth_pct: 101 } }).ok).toBe(false);
      expect(validateBehavioralEvent({ eventType: "scroll_depth", metadata: { feed: "feed", depth_pct: 12.5 } }).ok).toBe(false);
      const ok = validateBehavioralEvent({ eventType: "scroll_depth", metadata: { feed: "feed", depth_pct: 75, entries_seen: 18 } });
      expect(ok.ok && ok.event).toMatchObject({ personId: null, metadata: { feed: "feed", depth_pct: 75, entries_seen: 18 } });
    });

    it("filter_change needs a surface, a filter and a value", () => {
      expect(validateBehavioralEvent({ eventType: "filter_change", metadata: { surface: "feed", filter: "category" } }).ok).toBe(false);
      const ok = validateBehavioralEvent({ eventType: "filter_change", metadata: { surface: "feed", filter: "category", value: " creator " } });
      expect(ok.ok && ok.event.metadata).toEqual({ surface: "feed", filter: "category", value: "creator" });
    });

    it("change_range needs a person and a range, and normalises the range", () => {
      expect(validateBehavioralEvent({ eventType: "change_range", metadata: { range: "24h" } })).toEqual({ ok: false, reason: "change_range requires personId" });
      expect(validateBehavioralEvent({ eventType: "change_range", personId: PERSON }).ok).toBe(false);
      const ok = validateBehavioralEvent({ eventType: "change_range", personId: PERSON, metadata: { range: " 24H ", surface: "profile" } });
      expect(ok.ok && ok.event.metadata).toEqual({ range: "24h", surface: "profile" });
    });
  });
});

describe("sanitizeMetadata", () => {
  it("drops non-JSON values, truncates strings and caps depth", () => {
    const result = sanitizeMetadata({
      keep: "x",
      fn: () => 1,
      nan: Number.NaN,
      when: new Date("2026-09-07T00:00:00Z"),
      nested: { a: { b: { c: { d: "too deep" } } } },
      long: "y".repeat(BEHAVIORAL_LIMITS.maxStringLength + 10),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Depth counts from the root object: root (0) > nested (1) > a (2); `b` at depth 3 is dropped.
    expect(result.metadata).toEqual({
      keep: "x",
      when: "2026-09-07T00:00:00.000Z",
      nested: { a: {} },
      long: "y".repeat(BEHAVIORAL_LIMITS.maxStringLength),
    });
  });

  it("rejects arrays and oversized objects, and turns empty objects into null", () => {
    expect(sanitizeMetadata([1, 2])).toEqual({ ok: false, reason: "metadata must be an object" });
    expect(sanitizeMetadata({})).toEqual({ ok: true, metadata: null });
    expect(sanitizeMetadata(undefined)).toEqual({ ok: true, metadata: null });
    const big: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) big[`k${index}`] = "z".repeat(400);
    expect(sanitizeMetadata(big)).toMatchObject({ ok: false, reason: expect.stringContaining("bytes") });
  });

  it("caps the number of keys", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 100; index += 1) wide[`k${index}`] = index;
    const result = sanitizeMetadata(wide);
    expect(result.ok && Object.keys(result.metadata ?? {}).length).toBe(BEHAVIORAL_LIMITS.maxMetadataKeys);
  });
});
