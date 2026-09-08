import { directionOf, type Direction } from "@/components/ui/direction-indicator";

/**
 * The Home board's shape and the pure logic that produces it: ranking,
 * top-mover selection and category options. No I/O here, so it is testable on
 * its own and safe to import from either side of the server boundary.
 */

/** A person as Home renders them. All numbers are plain, already coerced. */
export interface BoardPerson {
  id: string;
  slug: string;
  displayName: string;
  category: string;
  avatarUrl: string | null;
  score: number;
  revertTarget: number;
  spread: number;
  buyPrice: number | null;
  sellPrice: number | null;
  /** Score change over the momentum window; null when the Engine has no history yet. */
  change: number | null;
  /** How many history points `change` is based on. 0 means no history. */
  points: number;
  /** Downsampled score series for the sparkline, oldest first. */
  sparkline: number[];
  direction: Direction;
  /** 1-based position in the ranking. */
  rank: number;
}

export interface CategoryOption {
  value: string;
  label: string;
  count: number;
}

export interface HomeBoard {
  people: BoardPerson[];
  categories: CategoryOption[];
  /** The people to feature at the top. */
  movers: BoardPerson[];
  /** True once at least one person has actually moved. */
  hasMovement: boolean;
  /** Newest tick timestamp across the board, or null before the first tick. */
  lastTickAt: string | null;
}

/** The rows the board is built from, as they come back from the database. */
export interface PersonRow {
  id: string;
  slug: string;
  display_name: string;
  category: string;
  avatar_url: string | null;
  current_score: number;
  revert_target: number;
  spread: number;
  buy_price: number | null;
  sell_price: number | null;
  last_tick_at: string | null;
}

export interface MomentumRow {
  person_id: string;
  change: number | null;
  points: number | null;
  sparkline: number[] | null;
}

export const MOVER_COUNT = 4;

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "creator" -> "Creator". Category values are single lowercase words. */
export function categoryLabel(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * Ranks people by momentum: score descending, then name, so the order is
 * stable when scores tie — which they all do until the Engine first ticks.
 */
export function rankPeople(rows: PersonRow[], momentum: MomentumRow[]): BoardPerson[] {
  const byPerson = new Map(momentum.map((row) => [row.person_id, row]));

  return rows
    .map((row) => {
      const move = byPerson.get(row.id);
      const change = move ? toNullableNumber(move.change) : null;
      return {
        id: row.id,
        slug: row.slug,
        displayName: row.display_name,
        category: row.category,
        avatarUrl: row.avatar_url,
        score: toNumber(row.current_score),
        revertTarget: toNumber(row.revert_target),
        spread: toNumber(row.spread),
        buyPrice: toNullableNumber(row.buy_price),
        sellPrice: toNullableNumber(row.sell_price),
        change,
        points: move ? toNumber(move.points) : 0,
        sparkline: (move?.sparkline ?? []).map((point) => toNumber(point)),
        direction: directionOf(change),
        rank: 0,
      } satisfies BoardPerson;
    })
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
    .map((person, index) => ({ ...person, rank: index + 1 }));
}

/**
 * The people to feature. Biggest absolute movers first once anything has
 * moved; before that, simply the top of the ranking — the slot still wants
 * filling, and the caller marks the board as dormant.
 */
export function pickMovers(people: BoardPerson[], count = MOVER_COUNT): BoardPerson[] {
  const moved = people.filter((person) => person.direction !== "neutral" && person.change !== null);
  if (moved.length === 0) return people.slice(0, count);

  return [...moved]
    .sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0) || a.rank - b.rank)
    .slice(0, count);
}

/** Category filter options, most populated first, with an "All" entry in front. */
export function categoryOptions(people: BoardPerson[]): CategoryOption[] {
  const counts = new Map<string, number>();
  for (const person of people) counts.set(person.category, (counts.get(person.category) ?? 0) + 1);

  const options = [...counts.entries()]
    .map(([value, count]) => ({ value, label: categoryLabel(value), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return [{ value: "all", label: "All", count: people.length }, ...options];
}

/** The newest tick across the board, or null before the Engine has run. */
export function latestTickAt(rows: PersonRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (row.last_tick_at && (latest === null || row.last_tick_at > latest)) latest = row.last_tick_at;
  }
  return latest;
}

/** Assembles the board from raw rows. */
export function buildBoard(rows: PersonRow[], momentum: MomentumRow[]): HomeBoard {
  const people = rankPeople(rows, momentum);
  return {
    people,
    categories: categoryOptions(people),
    movers: pickMovers(people),
    hasMovement: people.some((person) => person.direction !== "neutral"),
    lastTickAt: latestTickAt(rows),
  };
}
