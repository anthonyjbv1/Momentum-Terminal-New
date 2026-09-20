import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

import { readSearchResults, SEARCH_LIMIT, type SearchRow } from "./search-model";

/**
 * PHASE 23 on real Postgres: the consent flag, and the query it gates.
 *
 * The point of most of these is not that search works — it is that a person
 * who has not been switched on cannot be reached through it by any route:
 * not a different spelling, not a bigger limit, not the service role.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

const search = (query: string, limit?: number) =>
  database.rows<SearchRow>(
    limit === undefined
      ? "select * from public.search_people($1)"
      : "select * from public.search_people($1, $2)",
    limit === undefined ? [query] : [query, limit],
  );

const names = async (query: string, limit?: number) => (await search(query, limit)).map((row) => row.display_name);

describe("the flag", () => {
  it("defaults to false: a person added without anyone deciding otherwise is not findable", async () => {
    const [column] = await database.rows<{ column_default: string; is_nullable: string }>(
      "select column_default, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'people' and column_name = 'is_discoverable'",
    );
    expect(column).toBeDefined();
    expect(column.column_default).toBe("false");
    expect(column.is_nullable).toBe("NO");

    await database.exec(
      "insert into public.people (slug, display_name, full_name, category) values ('nobody-asked', 'Nobody Asked', 'Nobody Was Asked', 'creator')",
    );
    const [row] = await database.rows<{ is_discoverable: boolean }>("select is_discoverable from public.people where slug = 'nobody-asked'");
    expect(row.is_discoverable).toBe(false);
    expect(await names("nobody")).toEqual([]);
    expect(await names("Nobody Asked")).toEqual([]);
    await database.exec("delete from public.people where slug = 'nobody-asked'");
  });

  it("is on for the sixteen, and for exactly the sixteen", async () => {
    const rows = await database.rows<{ slug: string }>("select slug from public.people where is_discoverable order by slug");
    expect(rows.map((r) => r.slug)).toEqual([
      "adin-ross",
      "anthony-baptiste",
      "drake",
      "elon-musk",
      "jeff-bezos",
      "jensen-huang",
      "kai-cenat",
      "kendrick-lamar",
      "larry-ellison",
      "larry-page",
      "mark-zuckerberg",
      "michael-dell",
      "mrbeast",
      "patrick-mahomes",
      "sergey-brin",
      "warren-buffett",
    ]);
    const [{ n }] = await database.rows<{ n: number }>("select count(*)::int as n from public.people where is_active and not is_discoverable");
    expect(n).toBe(0);
  });

  it("is the precedent it was asked to follow: the same shape as forecast_paused, opposite polarity", async () => {
    const rows = await database.rows<{ column_name: string; data_type: string; is_nullable: string; column_default: string }>(
      "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'people' and column_name in ('forecast_paused', 'is_discoverable') order by column_name",
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.data_type, row.column_name).toBe("boolean");
      expect(row.is_nullable, row.column_name).toBe("NO");
      expect(row.column_default, row.column_name).toBe("false");
    }
  });
});

describe("the gate", () => {
  // Turning Kai Cenat off is the sharpest version of the test: his name, his
  // handle and his full name are all distinct strings, and every one of them
  // must come back empty.
  const restore = () => database.exec("update public.people set is_discoverable = true where slug = 'kai-cenat'");

  beforeAll(async () => {
    await database.exec("update public.people set is_discoverable = false where slug = 'kai-cenat'");
  });

  afterAll(restore);

  it("makes a non-discoverable person unreachable by name, handle, full name or fragment", async () => {
    for (const query of ["Kai Cenat", "kai-cenat", "kai", "cenat", "KAICENAT", "Kai Carlo Cenat III", "carlo"]) {
      expect(await names(query), query).toEqual([]);
    }
  });

  it("cannot be widened by asking for more rows", async () => {
    expect(await names("kai", 25)).toEqual([]);
    expect(await names("a", 25)).not.toContain("Kai Cenat");
  });

  it("holds for a caller that bypasses RLS entirely", async () => {
    // The PGlite session is the database owner — the most privileged caller
    // there is, RLS not applied. The filter is in the function body, so the
    // answer is the same one an anonymous caller would get.
    const [{ rls }] = await database.rows<{ rls: boolean }>("select row_security_active('public.people') as rls");
    expect(rls).toBe(false);
    expect(await names("cenat")).toEqual([]);
  });

  it("returns the person again the moment the flag goes back on, with nothing else changed", async () => {
    await restore();
    expect(await names("cenat")).toEqual(["Kai Cenat"]);
    await database.exec("update public.people set is_discoverable = false where slug = 'kai-cenat'");
  });
});

describe("finding a person", () => {
  it("is forgiving of case and punctuation: the same person by name, by handle and by neither", async () => {
    for (const query of ["Kai Cenat", "kai cenat", "KAI CENAT", "kai-cenat", "  kai   cenat  ", "kaicenat", "Kai.Cenat", "@kaicenat"]) {
      expect(await names(query), query).toEqual(["Kai Cenat"]);
    }
  });

  it("matches a partial from the start of a name, a word inside it, or anywhere at all", async () => {
    expect(await names("kend")).toEqual(["Kendrick Lamar"]);
    expect(await names("lamar")).toEqual(["Kendrick Lamar"]);
    expect(await names("beast")).toEqual(["MrBeast"]);
  });

  it("finds a person by a full name they are not displayed under", async () => {
    // Drake is displayed as "Drake" and is Aubrey Drake Graham underneath.
    expect(await names("aubrey")).toEqual(["Drake"]);
    expect(await names("graham")).toEqual(["Drake"]);
    // MrBeast likewise.
    expect(await names("donaldson")).toEqual(["MrBeast"]);
  });

  it("ranks the better match first: the exact name, then a prefix, then a word, then anywhere", async () => {
    const rows = await search("la");
    expect(rows.map((r) => [r.display_name, r.match_rank])).toEqual([
      ["Larry Ellison", 1],
      ["Larry Page", 1],
      ["Kendrick Lamar", 2],
      ["Patrick Mahomes", 3],
    ]);
    const [drake] = await search("drake");
    expect(drake.match_rank).toBe(0);
  });

  it("breaks ties by score, then name, then id — the board's own order, so two calls agree", async () => {
    await database.exec("update public.people set current_score = 50.0 where slug in ('larry-ellison', 'larry-page')");
    const first = await names("larry");
    const second = await names("larry");
    expect(first).toEqual(["Larry Ellison", "Larry Page"]);
    expect(second).toEqual(first);
  });

  it("answers nothing for nothing: empty, blank and punctuation-only queries return no rows rather than everyone", async () => {
    for (const query of ["", "   ", "-", "@", "!!!", "  ·  "]) {
      expect(await names(query), JSON.stringify(query)).toEqual([]);
    }
    expect(await names("zzzznobody")).toEqual([]);
  });

  it("treats the LIKE metacharacters as text, because normalisation has already removed them", async () => {
    // A needle of "%" normalises to "", which the gate rejects; "d%" to "d".
    expect(await names("%")).toEqual([]);
    expect(await names("_")).toEqual([]);
    expect(await names("d%rake")).toEqual(["Drake"]);
  });

  it("caps the result set at the asked-for limit, and at 25 however much is asked for", async () => {
    expect((await names("a", 3)).length).toBeLessThanOrEqual(3);
    expect((await names("a", 9999)).length).toBeLessThanOrEqual(25);
    expect((await names("a", -5)).length).toBeGreaterThan(0);
    expect((await names("a")).length).toBeLessThanOrEqual(SEARCH_LIMIT);
  });
});

describe("normalisation", () => {
  it("folds case, punctuation and Latin diacritics, and keeps word boundaries only in the terms form", async () => {
    const [row] = await database.rows<{ terms: string; key: string; folded: string }>(
      "select public.search_terms('  Jen-Hsun “Jensen” Huang!  ') as terms, public.search_key('Kai-Cenat') as key, public.search_terms('Beyoncé Æon Straße Ørsted') as folded",
    );
    expect(row.terms).toBe("jen hsun jensen huang");
    expect(row.key).toBe("kaicenat");
    expect(row.folded).toBe("beyonce aeon strasse orsted");
  });

  it("is immutable, which is what lets it be indexed", async () => {
    const rows = await database.rows<{ proname: string; provolatile: string }>(
      "select proname, provolatile from pg_proc where pronamespace = 'public'::regnamespace and proname in ('search_terms', 'search_key') order by proname",
    );
    expect(rows).toEqual([
      { proname: "search_key", provolatile: "i" },
      { proname: "search_terms", provolatile: "i" },
    ]);
  });
});

describe("the movement reading", () => {
  it("agrees with home_momentum over the same window, so a result row and the board cannot disagree", async () => {
    const [drake] = await database.rows<{ id: string }>("select id from public.people where slug = 'drake'");
    await database.exec("delete from public.score_history");
    await database.rows(
      "insert into public.score_history (person_id, score, recorded_at, tick_number) values ($1, 60.0, now() - interval '30 minutes', 1), ($1, 63.5, now() - interval '5 minutes', 2)",
      [drake.id],
    );

    const [row] = await search("drake");
    const [board] = await database.rows<{ change: string }>("select change from public.home_momentum() where person_id = $1", [drake.id]);
    expect(Number(row.change)).toBeCloseTo(3.5, 4);
    expect(Number(row.change)).toBeCloseTo(Number(board.change), 4);
    expect(readSearchResults([row])[0].direction).toBe("heating");
  });

  it("reads as no movement rather than as flat when there is only one point, or none", async () => {
    await database.exec("delete from public.score_history");
    const [row] = await search("drake");
    expect(row.change).toBeNull();
    expect(readSearchResults([row])[0].direction).toBe("neutral");
  });
});

describe("the indexes", () => {
  it("are partial on the gate, so the index is the discoverable set", async () => {
    const rows = await database.rows<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'people' and indexname like 'people_search%' order by indexname",
    );
    expect(rows.map((r) => r.indexname)).toEqual(["people_search_full_idx", "people_search_name_idx", "people_search_slug_idx"]);
    for (const row of rows) {
      expect(row.indexdef, row.indexname).toContain("search_key");
      expect(row.indexdef, row.indexname).toContain("WHERE (is_active AND is_discoverable)");
    }
  });
});

describe("who may call it", () => {
  it("is executable by a signed-in user and the service role, and not by the public or anon", async () => {
    const [row] = await database.rows<{ acl: string[] }>(
      "select coalesce(proacl::text[], array[]::text[]) as acl from pg_proc where pronamespace = 'public'::regnamespace and proname = 'search_people'",
    );
    const acl = row.acl.join(" ");
    expect(acl).toContain("authenticated=X");
    expect(acl).toContain("service_role=X");
    expect(acl).not.toContain("anon=X");
    // An explicit ACL with no bare "=X/" entry is a revoked PUBLIC grant.
    expect(acl).not.toMatch(/(^| )=X\//);
  });
});
