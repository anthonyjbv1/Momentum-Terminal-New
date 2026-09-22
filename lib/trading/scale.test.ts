import { describe, expect, it } from "vitest";

import { toPortfolioSummary, toTradeHistoryEntry, type TradeHistoryRow } from "@/lib/portfolio/model";
import { payloadUnitsPerShare, toOrderResult, toPositionSummary } from "@/lib/trading/model";

/**
 * THE READ PATH IS SCALE-AWARE, AND THAT IS WHAT MAKES PHASE 27 SHIPPABLE IN
 * PIECES.
 *
 * The migration that turns a unit into a thousandth of a share cannot be
 * applied at the same instant a deploy goes live, so one of the two happens
 * first and there is a window in which a client meets data it was not written
 * for. This build is meant to be correct on BOTH sides of that window: it
 * divides every quantity by the scale the payload itself declares, and reads
 * an absent declaration as 1, which is exactly what every payload written
 * before the migration means.
 *
 * The cases below are the two sides of the window, payload by payload. The
 * numbers are deliberately the same holding — three shares — described twice.
 */

const PERSON = "8f1b1c2d-3e4f-4a5b-8c7d-9e0f1a2b3c4d";

/** A position on three shares as each side of the migration describes it. */
function positionPayload(scale: 1 | 1000) {
  return {
    person_id: PERSON,
    direction: "HIGH",
    open_units: 3 * scale,
    cost_cents: 15_150,
    avg_entry_cents: 5050,
    lots: 1,
    mark_price_cents: 4950,
    value_cents: 14_850,
    unrealized_pnl_cents: -300,
    realized_pnl_cents: 0,
    ...(scale === 1 ? {} : { units_per_share: scale }),
  };
}

describe("the scale a payload declares", () => {
  it("reads an absent declaration as whole shares", () => {
    expect(payloadUnitsPerShare({ open_units: 3 })).toBe(1);
    expect(payloadUnitsPerShare(null)).toBe(1);
    expect(payloadUnitsPerShare(undefined)).toBe(1);
  });

  it("reads a declared scale, as a number or as the string a bigint may arrive as", () => {
    expect(payloadUnitsPerShare({ units_per_share: 1000 })).toBe(1000);
    expect(payloadUnitsPerShare({ units_per_share: "1000" })).toBe(1000);
  });

  it("refuses a declaration that cannot be a scale, rather than dividing by it", () => {
    // Nothing below 1 can be a scale: a zero would divide to Infinity and a
    // fraction would multiply the holding. Whole shares is the safe reading.
    for (const junk of [0, -1000, 0.5, "abc", null, NaN, Infinity]) {
      expect(payloadUnitsPerShare({ units_per_share: junk })).toBe(1);
    }
  });
});

describe("a holding reads the same on both sides of the migration", () => {
  it("position_summary_for: three shares before, three shares after", () => {
    const before = toPositionSummary(positionPayload(1), PERSON);
    const after = toPositionSummary(positionPayload(1000), PERSON);
    expect(before.openUnits).toBe(3);
    expect(after.openUnits).toBe(3);
    // Money is cents on both sides and is never scaled.
    expect(after.costCents).toBe(before.costCents);
    expect(after.avgEntryCents).toBe(before.avgEntryCents);
    expect(after.valueCents).toBe(before.valueCents);
  });

  it("portfolio_summary_for: the scale is declared once and covers every position in it", () => {
    const summary = (scale: 1 | 1000) =>
      toPortfolioSummary({
        total_value_cents: 1_000_000,
        cash_cents: 985_150,
        positions_value_cents: 14_850,
        position_count: 1,
        ...(scale === 1 ? {} : { units_per_share: scale }),
        positions: [
          {
            ...positionPayload(scale),
            // The nested position does NOT repeat the scale: the summary's
            // own declaration is what covers it.
            units_per_share: undefined,
            slug: "drake",
            display_name: "Drake",
            category: "music",
            avatar_url: null,
            is_active: true,
            mark_side: "SELL",
            buy_cents: 5050,
            sell_cents: 4950,
          },
        ],
      });
    expect(summary(1)?.positions[0]?.openUnits).toBe(3);
    expect(summary(1000)?.positions[0]?.openUnits).toBe(3);
    expect(summary(1000)?.positions[0]?.costCents).toBe(15_150);
  });

  it("trade_history_for: each row is divided by the scale that row declares", () => {
    const row = (scale: 1 | 1000): TradeHistoryRow => ({
      id: "b2c3d4e5-0000-4000-8000-000000000001",
      created_at: "2026-09-22T12:00:00Z",
      side: "BUY",
      units: 3 * scale,
      fill_price_cents: 5050,
      gross_cents: 15_150,
      opened_units: 3 * scale,
      closed_units: 0,
      cost_cents: 15_150,
      proceeds_cents: 0,
      realized_pnl_cents: 0,
      balance_after_cents: 984_850,
      surface: "profile",
      person_id: PERSON,
      person_slug: "drake",
      person_name: "Drake",
      person_category: "music",
      person_avatar: null,
      ...(scale === 1 ? {} : { units_per_share: scale }),
    });
    expect(toTradeHistoryEntry(row(1))?.units).toBe(3);
    expect(toTradeHistoryEntry(row(1000))?.units).toBe(3);
    expect(toTradeHistoryEntry(row(1000))?.openedUnits).toBe(3);
    expect(toTradeHistoryEntry(row(1000))?.grossCents).toBe(15_150);
  });

  it("place_order: the order, its fills and the position it returns all follow the order's scale", () => {
    const result = (scale: 1 | 1000) =>
      toOrderResult(
        {
          ok: true,
          order: {
            id: "c3d4e5f6-0000-4000-8000-000000000002",
            person_id: PERSON,
            side: "SELL",
            units: 2 * scale,
            fill_price_cents: 4950,
            gross_cents: 9900,
            opened_units: 0,
            closed_units: 2 * scale,
            cost_cents: 0,
            proceeds_cents: 9900,
            realized_pnl_cents: -200,
            fills: [{ position_id: "d4e5f6a7-0000-4000-8000-000000000003", units: 2 * scale, entry_price_cents: 5050, pnl_cents: -200, proceeds_cents: 9900 }],
            created_at: "2026-09-22T12:01:00Z",
            ...(scale === 1 ? {} : { units_per_share: scale }),
          },
          balance_cents: 995_050,
          position: positionPayload(scale),
        },
        PERSON,
      );
    for (const scale of [1, 1000] as const) {
      const parsed = result(scale);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.order.units).toBe(2);
      expect(parsed.order.closedUnits).toBe(2);
      expect(parsed.order.fills[0].units).toBe(2);
      expect(parsed.order.proceedsCents).toBe(9900);
      expect(parsed.balanceCents).toBe(995_050);
      expect(parsed.position.openUnits).toBe(3);
    }
  });
});
