import { describe, expect, it } from "vitest";

import { readSearchResults, SEARCH_COPY, SEARCH_LIMIT, QUERY_DEBOUNCE_MS, QUERY_SETTLE_MS, type SearchRow } from "./search-model";

const row = (over: Partial<SearchRow> = {}): SearchRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  slug: "kai-cenat",
  display_name: "Kai Cenat",
  category: "creator",
  avatar_url: null,
  current_score: "60.0632",
  change: "0.4100",
  match_rank: 0,
  ...over,
});

describe("reading rows", () => {
  it("coerces the numerics Postgres hands back as strings, and derives the direction from the change", () => {
    const [result] = readSearchResults([row()]);
    expect(result).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      slug: "kai-cenat",
      displayName: "Kai Cenat",
      category: "creator",
      avatarUrl: null,
      score: 60.0632,
      change: 0.41,
      direction: "heating",
    });
  });

  it("keeps no movement as no movement: a null change is not a zero, and reads flat rather than falling", () => {
    const [result] = readSearchResults([row({ change: null })]);
    expect(result.change).toBeNull();
    expect(result.direction).toBe("neutral");
  });

  it("preserves the order the database ranked in, rather than re-sorting on the client", () => {
    const rows = [
      row({ id: "a", display_name: "Larry Ellison", current_score: "57.0", match_rank: 1 }),
      row({ id: "b", display_name: "Larry Page", current_score: "55.0", match_rank: 1 }),
      row({ id: "c", display_name: "Kendrick Lamar", current_score: "62.9", match_rank: 2 }),
    ];
    // Kendrick outscores both and still comes last: match quality leads.
    expect(readSearchResults(rows).map((r) => r.displayName)).toEqual(["Larry Ellison", "Larry Page", "Kendrick Lamar"]);
  });
});

describe("the two clocks", () => {
  it("send the query before they log it, so the logged event can carry a result count", () => {
    expect(QUERY_DEBOUNCE_MS).toBeLessThan(QUERY_SETTLE_MS);
    expect(SEARCH_LIMIT).toBe(8);
  });
});

describe("the words", () => {
  const all = Object.values(SEARCH_COPY);
  const text = all.map((state) => `${state.title} ${state.body}`).join(" ");

  it("never reports a count of nothing: every state is a sentence, not a log line", () => {
    expect(text).not.toMatch(/\b0 results?\b|\bno results\b|\bnot found\b/i);
    for (const state of all) {
      expect(state.title.length, state.title).toBeGreaterThan(0);
      expect(state.title).toMatch(/[.!?]$/);
      expect(state.body).toMatch(/[.!?]$/);
    }
  });

  it("follows the Phase 21+ language rules: plain words, no guessed pronoun, no statistics vocabulary", () => {
    expect(text).not.toMatch(/σ|sigma|baseline|deviation|percentile|index|query|record/i);
    expect(text).not.toMatch(/\b(he|she|his|her|hers|him)\b/i);
  });

  it("quotes no count, so nothing goes stale the day the seventeenth person is added", () => {
    expect(text).not.toMatch(/\b(sixteen|16|seventeen|17)\b/i);
  });

  it("says what search is FOR before anything has been typed, rather than apologising for having nothing", () => {
    expect(SEARCH_COPY.empty.title).toBe("Find a person.");
    expect(SEARCH_COPY.empty.body).toContain("name or a handle");
    expect(SEARCH_COPY.empty.body).not.toMatch(/sorry|nothing|empty|yet\b/i);
  });

  it("answers the question a no-result state is actually being asked — why am I not here — without calling the absence a fault", () => {
    expect(SEARCH_COPY.noResults.title).toBe("No one here by that name.");
    // The sentence the whole state exists for.
    expect(SEARCH_COPY.noResults.body).toContain("nobody is on this list by accident");
    expect(SEARCH_COPY.noResults.body).toContain("that is not an oversight");
    expect(SEARCH_COPY.noResults.body).not.toMatch(/error|invalid|failed|sorry/i);
  });
});
