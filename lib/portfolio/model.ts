import { RANGES, type SeriesByRange, type SeriesPoint } from "@/lib/person/profile-model";
import type { OrderSide, PositionDirection } from "@/lib/trading/direction";
import { EMPTY_POSITION, cents, type Cents, type PositionSummary } from "@/lib/trading/model";

/**
 * The portfolio's shape on both sides of the server boundary, and the pure
 * logic around it: parsing what the RPCs return, the trade history cursor,
 * the value chart's floor, and which of the page's states a summary is in.
 *
 * NOTHING HERE COMPUTES MONEY. Every cent on the portfolio page is a value
 * the database returned (portfolio_summary_for, trade_history_for,
 * portfolio_value_series_for; see migration 20260912153309_portfolio); this file
 * only reads them into typed shapes. The one arithmetic below is the chart's
 * vertical floor, a display rule.
 */

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export interface PortfolioPerson {
  id: string;
  slug: string;
  name: string;
  category: string;
  avatarUrl: string | null;
  /** False once the person has left the board: the position can be seen but not closed. */
  isActive: boolean;
}

export interface PortfolioPosition {
  person: PortfolioPerson;
  direction: PositionDirection;
  /** The backend's word; the interface says "shares". */
  openUnits: number;
  /** Σ open_units × entry_price_cents over the open lots. Exact. */
  costCents: Cents;
  /** round(cost ÷ units), half up. A display figure; nothing settles on it. */
  avgEntryCents: Cents;
  lots: number;
  oldestOpenedAt: string | null;
  newestOpenedAt: string | null;
  score: number;
  spread: number;
  buyCents: Cents;
  sellCents: Cents;
  /** Which quote the position is marked at: SELL for a HIGH position, BUY for a LOW one. */
  markSide: OrderSide;
  markPriceCents: Cents;
  /** open_units × mark: what closing now would return. */
  valueCents: Cents;
  unrealizedPnlCents: Cents;
  /** unrealized ÷ cost, as a percentage to two decimals; null with no cost. Display only. */
  unrealizedPct: number | null;
  /** Realized on this person so far, from the FIFO close records. */
  realizedPnlCents: Cents;
}

export interface PortfolioSummary {
  asOf: string | null;
  cashCents: Cents;
  positionsValueCents: Cents;
  /** cash + Σ position value. */
  totalValueCents: Cents;
  openCostCents: Cents;
  unrealizedPnlCents: Cents;
  /** Lifetime, from position_closes. */
  realizedPnlCents: Cents;
  /** Paper credit granted so far (deposits less withdrawals): the base every return is measured against. */
  paperCreditCents: Cents;
  totalReturnCents: Cents;
  totalReturnPct: number | null;
  positionCount: number;
  orders: number;
  closes: number;
  peopleTraded: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  /** Recorded value points so far. */
  historyPoints: number;
  positions: PortfolioPosition[];
}

function toInt(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toPerson(record: Record<string, unknown>, prefix = ""): PortfolioPerson | null {
  const id = toText(record[`${prefix}id`] ?? record.person_id);
  const slug = toText(record[`${prefix}slug`]);
  const name = toText(record[`${prefix}name`] ?? record.display_name);
  if (!id || !slug || !name) return null;
  return {
    id,
    slug,
    name,
    category: toText(record[`${prefix}category`]) ?? "",
    avatarUrl: toText(record[`${prefix}avatar`] ?? record.avatar_url),
    isActive: record.is_active === undefined ? true : record.is_active === true,
  };
}

export function toPortfolioPosition(value: unknown): PortfolioPosition | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const person = toPerson(record, "");
  const direction = record.direction === "HIGH" || record.direction === "LOW" ? record.direction : null;
  if (!person || !direction) return null;
  const openUnits = toInt(record.open_units);
  if (openUnits <= 0) return null;
  return {
    person,
    direction,
    openUnits,
    costCents: cents(toInt(record.cost_cents)),
    avgEntryCents: cents(toInt(record.avg_entry_cents)),
    lots: Math.max(1, toInt(record.lots, 1)),
    oldestOpenedAt: toText(record.oldest_opened_at),
    newestOpenedAt: toText(record.newest_opened_at),
    score: toNullableNumber(record.score) ?? 0,
    spread: toNullableNumber(record.spread) ?? 0,
    buyCents: cents(toInt(record.buy_cents)),
    sellCents: cents(toInt(record.sell_cents)),
    markSide: record.mark_side === "BUY" ? "BUY" : "SELL",
    markPriceCents: cents(toInt(record.mark_price_cents)),
    valueCents: cents(toInt(record.value_cents)),
    unrealizedPnlCents: cents(toInt(record.unrealized_pnl_cents)),
    unrealizedPct: toNullableNumber(record.unrealized_pct),
    realizedPnlCents: cents(toInt(record.realized_pnl_cents)),
  };
}

/** portfolio_summary_for() / my_portfolio() as JSON → PortfolioSummary. Null for anything that is not a summary. */
export function toPortfolioSummary(value: unknown): PortfolioSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!("total_value_cents" in record)) return null;
  const positions = Array.isArray(record.positions) ? record.positions.map(toPortfolioPosition).filter((position): position is PortfolioPosition => position !== null) : [];
  return {
    asOf: toText(record.as_of),
    cashCents: cents(toInt(record.cash_cents)),
    positionsValueCents: cents(toInt(record.positions_value_cents)),
    totalValueCents: cents(toInt(record.total_value_cents)),
    openCostCents: cents(toInt(record.open_cost_cents)),
    unrealizedPnlCents: cents(toInt(record.unrealized_pnl_cents)),
    realizedPnlCents: cents(toInt(record.realized_pnl_cents)),
    paperCreditCents: cents(toInt(record.paper_credit_cents)),
    totalReturnCents: cents(toInt(record.total_return_cents)),
    totalReturnPct: toNullableNumber(record.total_return_pct),
    positionCount: toInt(record.position_count, positions.length),
    orders: toInt(record.orders),
    closes: toInt(record.closes),
    peopleTraded: toInt(record.people_traded),
    firstOrderAt: toText(record.first_order_at),
    lastOrderAt: toText(record.last_order_at),
    historyPoints: toInt(record.history_points),
    positions,
  };
}

/** The 6e trade sheet reads a PositionSummary; a portfolio position carries the same figures. */
export function toPositionSummary(position: PortfolioPosition): PositionSummary {
  return {
    ...EMPTY_POSITION,
    personId: position.person.id,
    direction: position.direction,
    openUnits: position.openUnits,
    costCents: position.costCents,
    avgEntryCents: position.avgEntryCents,
    lots: position.lots,
    oldestOpenedAt: position.oldestOpenedAt,
    newestOpenedAt: position.newestOpenedAt,
    markPriceCents: position.markPriceCents,
    valueCents: position.valueCents,
    unrealizedPnlCents: position.unrealizedPnlCents,
    realizedPnlCents: position.realizedPnlCents,
  };
}

// ---------------------------------------------------------------------------
// The page's states
// ---------------------------------------------------------------------------

/**
 *   never_traded  no order yet: the invitation, the state most beta users see first
 *   holding       at least one open position
 *   closed_out    traded before, holding nothing now: history and realized P&L remain
 */
export type PortfolioState = "never_traded" | "holding" | "closed_out";

export function portfolioState(summary: Pick<PortfolioSummary, "orders" | "positionCount">): PortfolioState {
  if (summary.orders === 0) return "never_traded";
  return summary.positionCount > 0 ? "holding" : "closed_out";
}

// ---------------------------------------------------------------------------
// Trade history
// ---------------------------------------------------------------------------

export interface TradeHistoryEntry {
  id: string;
  createdAt: string;
  side: OrderSide;
  units: number;
  /** The fill price as recorded on the order: a snapshot, never recomputed. */
  fillPriceCents: Cents;
  grossCents: Cents;
  openedUnits: number;
  closedUnits: number;
  /** opened_units × fill price: what the order put to work. */
  costCents: Cents;
  /** What the closes returned, from the close records. */
  proceedsCents: Cents;
  /** Realized on the closes, FIFO. */
  realizedPnlCents: Cents;
  balanceAfterCents: Cents | null;
  surface: string | null;
  person: PortfolioPerson;
}

/** A row of trade_history_for() / my_trade_history() as the database returns it. */
export interface TradeHistoryRow {
  id: string;
  created_at: string;
  side: string;
  units: number | string;
  fill_price_cents: number | string;
  gross_cents: number | string;
  opened_units: number | string;
  closed_units: number | string;
  cost_cents: number | string;
  proceeds_cents: number | string;
  realized_pnl_cents: number | string;
  balance_after_cents: number | string | null;
  surface: string | null;
  person_id: string;
  person_slug: string;
  person_name: string;
  person_category: string;
  person_avatar: string | null;
}

export function toTradeHistoryEntry(row: TradeHistoryRow): TradeHistoryEntry | null {
  const person = toPerson(row as unknown as Record<string, unknown>, "person_");
  if (!person || !row.id || !row.created_at) return null;
  const balanceAfter = row.balance_after_cents === null || row.balance_after_cents === undefined ? null : toInt(row.balance_after_cents, -1);
  return {
    id: row.id,
    createdAt: row.created_at,
    side: row.side === "SELL" ? "SELL" : "BUY",
    units: toInt(row.units),
    fillPriceCents: cents(toInt(row.fill_price_cents)),
    grossCents: cents(toInt(row.gross_cents)),
    openedUnits: toInt(row.opened_units),
    closedUnits: toInt(row.closed_units),
    costCents: cents(toInt(row.cost_cents)),
    proceedsCents: cents(toInt(row.proceeds_cents)),
    realizedPnlCents: cents(toInt(row.realized_pnl_cents)),
    balanceAfterCents: balanceAfter === null || balanceAfter < 0 ? null : cents(balanceAfter),
    surface: row.surface ?? null,
    person,
  };
}

/** Orders per page from the database. */
export const HISTORY_PAGE_SIZE = 20;

/** The most history rows the browser keeps loaded. */
export const HISTORY_MAX_ENTRIES = 400;

export interface TradeHistoryCursor {
  before: string;
  beforeId: string;
}

export interface TradeHistoryPage {
  entries: TradeHistoryEntry[];
  /** Where the next page starts, or null when this was the last one. */
  nextCursor: TradeHistoryCursor | null;
}

export function historyCursorAfter(entries: TradeHistoryEntry[], pageSize: number): TradeHistoryCursor | null {
  if (entries.length < pageSize) return null;
  const last = entries[entries.length - 1];
  return { before: last.createdAt, beforeId: last.id };
}

/** Appends a page, dropping anything already loaded and never growing past the cap. */
export function mergeHistory(existing: TradeHistoryEntry[], incoming: TradeHistoryEntry[], cap = HISTORY_MAX_ENTRIES): TradeHistoryEntry[] {
  const seen = new Set(existing.map((entry) => entry.id));
  const merged = existing.slice();
  for (const entry of incoming) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged.length > cap ? merged.slice(0, cap) : merged;
}

/** "Bought 5 shares of Drake at $50.50" is built in the interface; this is the verb. */
export function historyVerb(side: OrderSide): string {
  return side === "BUY" ? "Bought" : "Sold";
}

// ---------------------------------------------------------------------------
// The value series
// ---------------------------------------------------------------------------

/**
 * The value chart reuses the score chart's series shape, so one component
 * draws both: `score` carries the plotted value, here integer cents. The
 * page never adds two of them; it only draws them.
 */
export interface ValueSeriesRow {
  bucket_at: string;
  value_cents: number | string;
  open_cents: number | string | null;
  samples: number | string;
}

export function toValueSeries(rows: ValueSeriesRow[]): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const row of rows) {
    const value = toNullableNumber(row.value_cents);
    if (value === null || !row.bucket_at) continue;
    points.push({
      at: row.bucket_at,
      score: value,
      open: toNullableNumber(row.open_cents) ?? value,
      samples: Math.max(1, Math.round(toNullableNumber(row.samples) ?? 1)),
    });
  }
  return points.sort((a, b) => a.at.localeCompare(b.at));
}

export function emptyValueSeries(): SeriesByRange {
  return { "1h": [], "24h": [], "7d": [], all: [] };
}

/** A recorded value point as the live endpoint reports it. */
export interface ValuePoint {
  at: string;
  valueCents: Cents;
}

export function toValuePoint(value: unknown): ValuePoint | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const at = toText(record.at ?? record.recorded_at);
  const valueCents = toInt(record.value_cents ?? record.total_value_cents, -1);
  return at && valueCents >= 0 ? { at, valueCents: cents(valueCents) } : null;
}

/**
 * THE VALUE FLOOR. The chart's vertical axis clamps to the data but never
 * spans less than this fraction of the latest value (or an absolute minimum
 * of a dollar). The score chart's floor is 2 points, a quarter to a whole
 * of a typical hour's move; the same intent here: on a $10,000 paper
 * account the floor is $50, so a ten-dollar hour reads as a fifth of the
 * height and a fifty-cent drift stays a flicker, not a cliff. TUNABLE.
 */
export const VALUE_RANGE_FLOOR_RATIO = 0.005;
export const VALUE_RANGE_FLOOR_MIN_CENTS = 100;

export function valueRangeFloorCents(latestCents: number): number {
  const scaled = Math.round(Math.abs(latestCents) * VALUE_RANGE_FLOOR_RATIO);
  return Math.max(scaled, VALUE_RANGE_FLOOR_MIN_CENTS);
}

/** The range definitions the value chart offers: the same four as the score chart. */
export { RANGES };
