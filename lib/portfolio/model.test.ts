import { describe, expect, it } from "vitest";

import {
  HISTORY_PAGE_SIZE,
  VALUE_RANGE_FLOOR_MIN_CENTS,
  VALUE_RANGE_FLOOR_RATIO,
  historyCursorAfter,
  mergeHistory,
  portfolioState,
  toPortfolioSummary,
  toPositionSummary,
  toTradeHistoryEntry,
  toValuePoint,
  toValueSeries,
  valueRangeFloorCents,
  type TradeHistoryEntry,
  type TradeHistoryRow,
} from "./model";

/**
 * The portfolio's pure logic: reading the RPC results into typed shapes
 * without touching a figure, the page's three states, the history cursor,
 * and the chart floor.
 */

const PERSON = "11111111-1111-4111-8111-111111111101";

const summaryJson = {
  user_id: "u",
  as_of: "2026-09-12T10:00:00Z",
  cash_cents: "919250",
  positions_value_cents: 80250,
  total_value_cents: 999500,
  open_cost_cents: 80750,
  unrealized_pnl_cents: -500,
  realized_pnl_cents: 0,
  paper_credit_cents: 1000000,
  total_return_cents: -500,
  total_return_pct: -0.05,
  position_count: 2,
  orders: 2,
  closes: 0,
  people_traded: 2,
  first_order_at: "2026-09-12T09:00:00Z",
  last_order_at: "2026-09-12T09:01:00Z",
  history_points: 2,
  positions: [
    {
      person_id: PERSON,
      slug: "drake",
      display_name: "Drake",
      category: "musician",
      avatar_url: null,
      is_active: true,
      direction: "HIGH",
      open_units: 10,
      cost_cents: 50500,
      avg_entry_cents: 5050,
      lots: 1,
      oldest_opened_at: "2026-09-12T09:00:00Z",
      newest_opened_at: "2026-09-12T09:00:00Z",
      score: 52,
      spread: 0.5,
      buy_cents: 5250,
      sell_cents: 5150,
      mark_side: "SELL",
      mark_price_cents: 5150,
      value_cents: 51500,
      unrealized_pnl_cents: 1000,
      unrealized_pct: 1.98,
      realized_pnl_cents: 0,
    },
    { person_id: "22222222-2222-4222-8222-222222222202", slug: "mrbeast", display_name: "MrBeast", category: "creator", direction: "HIGH", open_units: 0 },
  ],
};

describe("toPortfolioSummary", () => {
  it("reads every figure as the server sent it, strings or numbers, and drops positions with nothing open", () => {
    const summary = toPortfolioSummary(summaryJson)!;
    expect(summary).toMatchObject({
      cashCents: 919250,
      positionsValueCents: 80250,
      totalValueCents: 999500,
      unrealizedPnlCents: -500,
      realizedPnlCents: 0,
      paperCreditCents: 1000000,
      totalReturnCents: -500,
      totalReturnPct: -0.05,
      positionCount: 2,
      orders: 2,
      historyPoints: 2,
    });
    expect(summary.positions).toHaveLength(1);
    expect(summary.positions[0]).toMatchObject({
      person: { id: PERSON, slug: "drake", name: "Drake", category: "musician", avatarUrl: null, isActive: true },
      direction: "HIGH",
      openUnits: 10,
      costCents: 50500,
      avgEntryCents: 5050,
      markSide: "SELL",
      markPriceCents: 5150,
      valueCents: 51500,
      unrealizedPnlCents: 1000,
      unrealizedPct: 1.98,
    });
  });

  it("is null for anything that is not a summary", () => {
    expect(toPortfolioSummary(null)).toBeNull();
    expect(toPortfolioSummary("nope")).toBeNull();
    expect(toPortfolioSummary({ positions: [] })).toBeNull();
  });

  it("hands the 6e trade sheet the position it expects", () => {
    const position = toPortfolioSummary(summaryJson)!.positions[0];
    expect(toPositionSummary(position)).toMatchObject({ personId: PERSON, direction: "HIGH", openUnits: 10, costCents: 50500, avgEntryCents: 5050, markPriceCents: 5150, valueCents: 51500, unrealizedPnlCents: 1000 });
  });
});

describe("portfolioState", () => {
  it("tells the invitation from holding from closed out", () => {
    expect(portfolioState({ orders: 0, positionCount: 0 })).toBe("never_traded");
    expect(portfolioState({ orders: 3, positionCount: 2 })).toBe("holding");
    expect(portfolioState({ orders: 3, positionCount: 0 })).toBe("closed_out");
  });
});

describe("trade history", () => {
  const row: TradeHistoryRow = {
    id: "o1",
    created_at: "2026-09-12T09:00:00.123456+00:00",
    side: "SELL",
    units: "4",
    fill_price_cents: "5150",
    gross_cents: "20600",
    opened_units: "0",
    closed_units: "4",
    cost_cents: "0",
    proceeds_cents: "20600",
    realized_pnl_cents: "400",
    balance_after_cents: "939850",
    surface: "portfolio",
    person_id: PERSON,
    person_slug: "drake",
    person_name: "Drake",
    person_category: "musician",
    person_avatar: null,
  };

  it("reads a row with the executed price as recorded", () => {
    expect(toTradeHistoryEntry(row)).toMatchObject({
      id: "o1",
      side: "SELL",
      units: 4,
      fillPriceCents: 5150,
      proceedsCents: 20600,
      realizedPnlCents: 400,
      balanceAfterCents: 939850,
      surface: "portfolio",
      person: { id: PERSON, slug: "drake", name: "Drake", isActive: true },
    });
    expect(toTradeHistoryEntry({ ...row, id: "" })).toBeNull();
  });

  it("cuts a cursor only from a full page, at the last row, keeping the timestamp whole", () => {
    const entry = toTradeHistoryEntry(row)!;
    const full = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) => ({ ...entry, id: `o${index}` }));
    expect(historyCursorAfter(full, HISTORY_PAGE_SIZE)).toEqual({ before: row.created_at, beforeId: `o${HISTORY_PAGE_SIZE - 1}` });
    expect(historyCursorAfter(full.slice(0, 5), HISTORY_PAGE_SIZE)).toBeNull();
  });

  it("merges pages without duplicates and never past the cap", () => {
    const entry = toTradeHistoryEntry(row)!;
    const make = (id: string): TradeHistoryEntry => ({ ...entry, id });
    const merged = mergeHistory([make("a"), make("b")], [make("b"), make("c")]);
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(mergeHistory([make("a"), make("b")], [make("c")], 2).map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("the value series", () => {
  it("reads and sorts the downsampled rows, cents into the plotted value", () => {
    const series = toValueSeries([
      { bucket_at: "2026-09-12T09:01:00Z", value_cents: "999500", open_cents: "1000000", samples: 2 },
      { bucket_at: "2026-09-12T09:00:00Z", value_cents: 1000000, open_cents: null, samples: "1" },
    ]);
    expect(series).toEqual([
      { at: "2026-09-12T09:00:00Z", score: 1000000, open: 1000000, samples: 1 },
      { at: "2026-09-12T09:01:00Z", score: 999500, open: 1000000, samples: 2 },
    ]);
  });

  it("reads a live point in either spelling and refuses a broken one", () => {
    expect(toValuePoint({ at: "2026-09-12T09:00:00Z", value_cents: 5 })).toEqual({ at: "2026-09-12T09:00:00Z", valueCents: 5 });
    expect(toValuePoint({ recorded_at: "2026-09-12T09:00:00Z", total_value_cents: "7" })).toEqual({ at: "2026-09-12T09:00:00Z", valueCents: 7 });
    expect(toValuePoint({ at: "2026-09-12T09:00:00Z" })).toBeNull();
    expect(toValuePoint(null)).toBeNull();
  });

  it("floors the vertical span at a fraction of the latest value, never under a dollar", () => {
    expect(VALUE_RANGE_FLOOR_RATIO).toBe(0.005);
    expect(VALUE_RANGE_FLOOR_MIN_CENTS).toBe(100);
    expect(valueRangeFloorCents(1_000_000)).toBe(5_000);
    expect(valueRangeFloorCents(999_500)).toBe(4_998);
    expect(valueRangeFloorCents(1_000)).toBe(100);
    expect(valueRangeFloorCents(0)).toBe(100);
  });
});
