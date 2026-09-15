import { describe, expect, it } from "vitest";

import { applyQueryExclusions, excludeReason, hasRules, isGoogleNewsSearch, readDisambiguation, type Disambiguation } from "./disambiguation";

/** Drake's seeded rules, as the migration writes them. */
const DRAKE: Disambiguation = {
  exclude_terms: [
    "drake university",
    "drake bulldogs",
    "drake relays",
    "drake law",
    "drake maye",
    "drake bell",
    "non-conference",
    "missouri valley",
    "ncaa tournament",
  ],
  require_any: [],
};

const DRAKE_FEED = "https://news.google.com/rss/search?q=%22Drake%22+rapper&hl=en-US&gl=US&ceid=US%3Aen";

describe("readDisambiguation", () => {
  it("reads the block, lowercasing and de-duplicating terms", () => {
    const rules = readDisambiguation({ disambiguation: { exclude_terms: ["Drake University", "DRAKE UNIVERSITY", " drake relays "], require_any: ["Rapper"] } });
    expect(rules.exclude_terms).toEqual(["drake university", "drake relays"]);
    expect(rules.require_any).toEqual(["rapper"]);
  });

  it("treats anything malformed or absent as no rules rather than throwing", () => {
    for (const config of [null, undefined, {}, { disambiguation: null }, { disambiguation: "yes" }, { disambiguation: [] }, { disambiguation: { exclude_terms: "drake" } }]) {
      const rules = readDisambiguation(config as Record<string, never>);
      expect(rules, JSON.stringify(config)).toEqual({ exclude_terms: [], require_any: [] });
      expect(hasRules(rules)).toBe(false);
    }
    // Non-string entries are dropped, not fatal.
    expect(readDisambiguation({ disambiguation: { exclude_terms: ["ok", 7, null] } }).exclude_terms).toEqual(["ok"]);
  });
});

describe("excludeReason", () => {
  it("refuses the item that actually reached production, on its context term", () => {
    // The real one. It names neither "Drake University" nor "Bulldogs" — only
    // the collegiate-athletics vocabulary gives it away, which is why the
    // seeded terms cover the discourse and not just the names.
    const verdict = excludeReason("Michigan State Adds Non-Conference Game Against Drake", DRAKE);
    expect(verdict).toEqual({ reason: "excluded_term", term: "non-conference" });
  });

  it("refuses the other entities by name, whatever the casing", () => {
    expect(excludeReason("Drake University names new athletic director", DRAKE)?.term).toBe("drake university");
    expect(excludeReason("DRAKE BULLDOGS fall in overtime", DRAKE)?.term).toBe("drake bulldogs");
    expect(excludeReason("Drake Maye throws for 300 yards", DRAKE)?.term).toBe("drake maye");
    expect(excludeReason("Drake Bell speaks out", DRAKE)?.term).toBe("drake bell");
  });

  it("admits the real Drake stories the feed actually carried", () => {
    // Every one of these is a genuine signal from the production corpus. If a
    // term ever starts refusing one of them, this test is where it shows up.
    const real = [
      "Drake Reveals “FOMO” As Self-Funded Film About One Wild Summer",
      "Everybody Likes Drake Again. That Means We’re Healing",
      "Drake Says Jim Carrey Roast Is 'All I Want for My Birthday'",
      "Judge Sends Drake's Stake Gambling Lawsuit to Arbitration, Pauses Rapper's Case",
      "Drake Rolls With Powerhouse College Football Teams In New OVO Collab— See Every Look",
      "'Drake Curse' Continues As Canadian Rapper Placed A $1.5 Million Bet On Argentina",
      "Why is Drake barking like a dog? Six things you need to know about the rapper’s midlife pivot",
      "Is Drake making country music? Rapper teases 'Choosin' Texas' remix",
    ];
    for (const headline of real) expect(excludeReason(headline, DRAKE), headline).toBeNull();
  });

  it("keeps a subject-adjacent sports story: a college football collab is still about him", () => {
    // "College Football" alone must NOT be an exclusion term — he collaborates
    // with college programmes. Only the conference vocabulary is specific
    // enough, which is why "college" is deliberately not seeded.
    expect(excludeReason("Drake Rolls With Powerhouse College Football Teams In New OVO Collab", DRAKE)).toBeNull();
  });

  it("matches the outlet as well as the headline, since the caller passes both", () => {
    expect(excludeReason("Bulldogs win again Drake Athletics", { exclude_terms: ["drake athletics"], require_any: [] })?.term).toBe("drake athletics");
  });

  it("applies require_any only when it is set, and says which rule refused", () => {
    const withContext: Disambiguation = { exclude_terms: [], require_any: ["rapper", "album", "ovo"] };
    expect(excludeReason("Drake drops a new album", withContext)).toBeNull();
    expect(excludeReason("Drake wins the 400m", withContext)).toEqual({ reason: "missing_context", term: null });
    // Empty require_any admits everything, so an unconfigured subject is untouched.
    expect(excludeReason("Anything at all", { exclude_terms: [], require_any: [] })).toBeNull();
  });

  it("checks exclusions before context, so the reported reason is the specific one", () => {
    const both: Disambiguation = { exclude_terms: ["drake university"], require_any: ["rapper"] };
    expect(excludeReason("Drake University hires a rapper", both)).toEqual({ reason: "excluded_term", term: "drake university" });
  });
});

describe("applyQueryExclusions", () => {
  it("pushes the terms into a Google News query as negatives, quoting the phrases", () => {
    const url = new URL(applyQueryExclusions(DRAKE_FEED, DRAKE));
    const query = url.searchParams.get("q") ?? "";
    expect(query).toContain('"Drake" rapper');
    expect(query).toContain('-"drake university"');
    expect(query).toContain('-"non-conference"');
    // The rest of the query string survives untouched.
    expect(url.searchParams.get("hl")).toBe("en-US");
    expect(url.searchParams.get("ceid")).toBe("US:en");
  });

  it("quotes only multi-word terms", () => {
    const query = new URL(applyQueryExclusions(DRAKE_FEED, { exclude_terms: ["bulldogs", "drake university"], require_any: [] })).searchParams.get("q") ?? "";
    expect(query).toContain("-bulldogs");
    expect(query).toContain('-"drake university"');
  });

  it("does not add a term the query already excludes", () => {
    const once = applyQueryExclusions(DRAKE_FEED, DRAKE);
    expect(applyQueryExclusions(once, DRAKE)).toBe(once);
  });

  it("leaves a feed alone when it is not a Google News search, or when there is nothing to exclude", () => {
    const outletFeed = "https://www.billboard.com/feed/";
    expect(applyQueryExclusions(outletFeed, DRAKE)).toBe(outletFeed);
    expect(applyQueryExclusions(DRAKE_FEED, { exclude_terms: [], require_any: [] })).toBe(DRAKE_FEED);
    // A Google News URL with no q is not rewritten into a broken one.
    const noQuery = "https://news.google.com/rss/search?hl=en-US";
    expect(applyQueryExclusions(noQuery, DRAKE)).toBe(noQuery);
  });

  it("recognises only the Google News search shape", () => {
    expect(isGoogleNewsSearch(DRAKE_FEED)).toBe(true);
    expect(isGoogleNewsSearch("https://news.google.com/rss/topics/abc")).toBe(false);
    expect(isGoogleNewsSearch("https://example.com/rss")).toBe(false);
  });
});
