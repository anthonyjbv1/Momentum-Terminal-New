import { describe, expect, it } from "vitest";

import {
  buildBoard,
  categoryLabel,
  categoryOptions,
  latestTickAt,
  pickMovers,
  rankPeople,
  type MomentumRow,
  type PersonRow,
} from "./board-model";

function person(overrides: Partial<PersonRow> & Pick<PersonRow, "id" | "slug" | "display_name">): PersonRow {
  return {
    category: "creator",
    avatar_url: null,
    current_score: 50,
    revert_target: 55,
    spread: 0.5,
    buy_price: 50.5,
    sell_price: 49.5,
    last_tick_at: null,
    ...overrides,
  };
}

const DRAKE = person({ id: "p1", slug: "drake", display_name: "Drake", category: "musician", current_score: 62.5 });
const MRBEAST = person({ id: "p2", slug: "mrbeast", display_name: "MrBeast", current_score: 71.2 });
const KAI = person({ id: "p3", slug: "kai-cenat", display_name: "Kai Cenat", current_score: 44.8 });
const ELON = person({ id: "p4", slug: "elon-musk", display_name: "Elon Musk", category: "executive", current_score: 62.5 });

describe("rankPeople", () => {
  it("ranks by score descending and folds in momentum", () => {
    const momentum: MomentumRow[] = [
      { person_id: "p1", change: 3.2, points: 40, sparkline: [59, 60, 62.5] },
      { person_id: "p3", change: -1.4, points: 40, sparkline: [46, 45, 44.8] },
    ];
    const ranked = rankPeople([DRAKE, MRBEAST, KAI, ELON], momentum);

    expect(ranked.map((p) => [p.rank, p.slug])).toEqual([
      [1, "mrbeast"],
      [2, "drake"],
      [3, "elon-musk"],
      [4, "kai-cenat"],
    ]);
    expect(ranked[1]).toMatchObject({ change: 3.2, points: 40, direction: "heating", sparkline: [59, 60, 62.5] });
    expect(ranked[3]).toMatchObject({ change: -1.4, direction: "cooling" });
  });

  it("breaks score ties by name, so a dormant board has a stable order", () => {
    const flat = [KAI, DRAKE, MRBEAST, ELON].map((p) => ({ ...p, current_score: 50 }));
    const ranked = rankPeople(flat, []);
    expect(ranked.map((p) => p.slug)).toEqual(["drake", "elon-musk", "kai-cenat", "mrbeast"]);
  });

  it("breaks a full tie on score and name by id, so the order is total and identical on every load", () => {
    const twins = [
      person({ id: "p9", slug: "twin-b", display_name: "Twin" }),
      person({ id: "p2", slug: "twin-a", display_name: "Twin" }),
      person({ id: "p5", slug: "twin-c", display_name: "Twin" }),
    ];
    const once = rankPeople(twins, []).map((p) => p.slug);
    const again = rankPeople([...twins].reverse(), []).map((p) => p.slug);
    expect(once).toEqual(["twin-a", "twin-c", "twin-b"]);
    expect(again).toEqual(once);
  });

  it("treats a person with no momentum row as flat, not as a zero change", () => {
    const [only] = rankPeople([DRAKE], []);
    expect(only).toMatchObject({ change: null, points: 0, sparkline: [], direction: "neutral" });
  });

  it("coerces numeric strings and ignores unusable values", () => {
    const row = { ...DRAKE, current_score: "62.5" as unknown as number, spread: null as unknown as number };
    const momentum = [{ person_id: "p1", change: "1.25" as unknown as number, points: null, sparkline: null }];
    const [ranked] = rankPeople([row], momentum);
    expect(ranked.score).toBe(62.5);
    expect(ranked.spread).toBe(0);
    expect(ranked.change).toBe(1.25);
    expect(ranked.points).toBe(0);
    expect(ranked.sparkline).toEqual([]);
  });
});

describe("pickMovers", () => {
  const ranked = rankPeople(
    [DRAKE, MRBEAST, KAI, ELON],
    [
      { person_id: "p1", change: 3.2, points: 10, sparkline: [] },
      { person_id: "p2", change: -0.01, points: 10, sparkline: [] },
      { person_id: "p3", change: -5.6, points: 10, sparkline: [] },
      { person_id: "p4", change: 1.1, points: 10, sparkline: [] },
    ],
  );

  it("takes the biggest absolute movers, ignoring anything that reads flat", () => {
    expect(pickMovers(ranked, 3).map((p) => p.slug)).toEqual(["kai-cenat", "drake", "elon-musk"]);
  });

  it("falls back to the top of the ranking when nothing has moved", () => {
    const flat = rankPeople([DRAKE, MRBEAST, KAI, ELON], []);
    expect(pickMovers(flat, 2).map((p) => p.slug)).toEqual(["mrbeast", "drake"]);
  });
});

describe("categoryOptions", () => {
  it("puts All first, then categories by population", () => {
    const ranked = rankPeople([DRAKE, MRBEAST, KAI, ELON], []);
    expect(categoryOptions(ranked)).toEqual([
      { value: "all", label: "All", count: 4 },
      { value: "creator", label: "Creator", count: 2 },
      { value: "executive", label: "Executive", count: 1 },
      { value: "musician", label: "Musician", count: 1 },
    ]);
  });

  it("labels categories for display", () => {
    expect(categoryLabel("founder")).toBe("Founder");
  });
});

describe("latestTickAt", () => {
  it("returns the newest tick, or null when the Engine has never run", () => {
    expect(latestTickAt([DRAKE, MRBEAST])).toBeNull();
    expect(
      latestTickAt([
        { ...DRAKE, last_tick_at: "2026-09-08T10:00:00Z" },
        { ...MRBEAST, last_tick_at: "2026-09-08T12:00:00Z" },
        KAI,
      ]),
    ).toBe("2026-09-08T12:00:00Z");
  });
});

describe("buildBoard", () => {
  it("assembles people, categories, movers and the movement flag", () => {
    const board = buildBoard([DRAKE, MRBEAST, KAI, ELON], [{ person_id: "p3", change: -5.6, points: 12, sparkline: [50, 45] }]);
    expect(board.people).toHaveLength(4);
    expect(board.hasMovement).toBe(true);
    expect(board.movers[0].slug).toBe("kai-cenat");
    expect(board.categories[0].value).toBe("all");
  });

  it("reports a dormant board when nothing has history", () => {
    const board = buildBoard([DRAKE, MRBEAST], []);
    expect(board.hasMovement).toBe(false);
    expect(board.movers).toHaveLength(2);
    expect(board.lastTickAt).toBeNull();
  });
});
