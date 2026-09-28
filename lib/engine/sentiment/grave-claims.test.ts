import { describe, expect, it } from "vitest";

import { graveClaimSupported, graveClaimTerm, guardNarrative, sourceOf, zeroedGraveClaim } from "./grave-claims";
import type { SentimentInput } from "./types";

/**
 * THE NARRATIVE SAFETY RULE, on the case that made it (2026-09-28): one item
 * headlined "Larry Page" from wgrv.com at the unknown-publisher tier, and the
 * model wrote "Larry Page has died." Larry Page is alive.
 */

/** The wgrv.com signal exactly as it was stored (id 2d73f458…), the source tier the RSS connector's 3, the publisher's 5. */
const WGRV: SentimentInput = {
  id: "2d73f458-a4f8-4a3b-b3f5-ae810d9e1025",
  personId: "b2c790cd-0413-48f1-9b40-410c9a40e04e",
  headline: "Larry Page",
  rawPayload: { kind: "article", title: "Larry Page - wgrv.com", outlet: "wgrv.com", source: "rss", source_url: "https://wgrv.com", publisher_tier: 5, publisher_domain: "wgrv.com", publisher_status: "unknown" },
  sourceName: "rss",
  sourceTier: 3,
};

const DEATH_NARRATIVE = "Larry Page has died. This ends his momentum profile as an active market figure.";

function item(id: string, headline: string, publisher: { tier: number; domain: string }): SentimentInput {
  return { id, personId: WGRV.personId, headline, rawPayload: { kind: "article", publisher_tier: publisher.tier, publisher_domain: publisher.domain }, sourceName: "rss", sourceTier: 3 };
}

describe("the source a signal is judged by", () => {
  it("is the publisher's tier and domain from the payload, not the connector's", () => {
    expect(sourceOf(WGRV)).toEqual({ tier: 5, outlet: "wgrv.com" });
  });

  it("falls back to the source tier and name when the payload says nothing", () => {
    expect(sourceOf({ ...WGRV, rawPayload: null })).toEqual({ tier: 3, outlet: "rss" });
    expect(sourceOf({ ...WGRV, rawPayload: { kind: "article", outlet: "Variety" } })).toEqual({ tier: 3, outlet: "variety" });
  });
});

describe("what counts as a grave claim", () => {
  it("a death, an arrest, a charge, a serious illness", () => {
    expect(graveClaimTerm(DEATH_NARRATIVE)).toBe("died");
    expect(graveClaimTerm("Drake was arrested in Toronto overnight.")).toBe("arrested");
    expect(graveClaimTerm("Prosecutors say he was charged with fraud.")).toBe("charged with");
    expect(graveClaimTerm("Mahomes was hospitalized after the game.")).toBe("hospitalized");
    expect(graveClaimTerm("A cancer diagnosis puts the tour in doubt.")).toBe("cancer");
    expect(graveClaimTerm("Reports say he is in critical condition.")).toBe("critical condition");
  });

  it("not an ordinary sentence about momentum", () => {
    expect(graveClaimTerm("MrBeast's channel is pulling views faster than usual.")).toBeNull();
    expect(graveClaimTerm("Oracle shares fell 4.7% as Ellison scrapped a share sale.")).toBeNull();
    expect(graveClaimTerm(undefined)).toBeNull();
    expect(graveClaimTerm("")).toBeNull();
  });
});

describe("what supports one", () => {
  it("a reputable outlet (tier 1 or 2) on its own", () => {
    expect(graveClaimSupported([{ tier: 1, outlet: "abcnews.com" }])).toBe(true);
    expect(graveClaimSupported([{ tier: 2, outlet: "variety.com" }, { tier: 5, outlet: "wgrv.com" }])).toBe(true);
  });

  it("two independent outlets, whatever their tier", () => {
    expect(graveClaimSupported([{ tier: 5, outlet: "wgrv.com" }, { tier: 4, outlet: "greenevillesun.com" }])).toBe(true);
  });

  it("not one unknown outlet, however many of its items, and not no outlet at all", () => {
    expect(graveClaimSupported([{ tier: 5, outlet: "wgrv.com" }])).toBe(false);
    expect(graveClaimSupported([{ tier: 5, outlet: "wgrv.com" }, { tier: 5, outlet: "wgrv.com" }])).toBe(false);
    expect(graveClaimSupported([{ tier: 3, outlet: null }])).toBe(false);
    expect(graveClaimSupported([])).toBe(false);
  });
});

describe("the guard, on the exact case", () => {
  it("withholds 'Larry Page has died.' written from the one wgrv.com item, and says why", () => {
    const guarded = guardNarrative(DEATH_NARRATIVE, [WGRV]);
    expect(guarded.narrative).toBeUndefined();
    expect(guarded.withheld).toEqual({ term: "died", sources: [{ tier: 5, outlet: "wgrv.com" }] });
  });

  it("would let the same sentence stand from a reputable outlet, or from two outlets", () => {
    expect(guardNarrative(DEATH_NARRATIVE, [item("s1", "Larry Page dies at 53", { tier: 1, domain: "nytimes.com" })]).narrative).toBe(DEATH_NARRATIVE);
    expect(guardNarrative(DEATH_NARRATIVE, [WGRV, item("s2", "Larry Page", { tier: 5, domain: "greenevillesun.com" })]).narrative).toBe(DEATH_NARRATIVE);
  });

  it("leaves a sentence with no grave claim alone, whatever its sources", () => {
    const plain = "Larry Page's coverage picked up on a local station's item.";
    expect(guardNarrative(plain, [WGRV])).toEqual({ narrative: plain, withheld: null });
    expect(guardNarrative(undefined, [WGRV])).toEqual({ narrative: undefined, withheld: null });
  });
});

describe("the companion scoring rule (decision 4): the signal scores zero on the same test", () => {
  it("zeroes the wgrv.com item and the Legacy.com notice, each alone from an unknown outlet, on what the model assessed", () => {
    expect(zeroedGraveClaim("Obituary published today confirms Larry Page's death, a catastrophic and unprecedented event for his momentum.", [sourceOf(WGRV)])).toBe("obituary");
    expect(zeroedGraveClaim("Obituary published suggests death or severe health event, drastically weakening momentum regardless of verification status.", [{ tier: 5, outlet: "legacy.com" }])).toBe("obituary");
  });

  it("judges the assessment, not the headline: 'Sued to Death' and 'Killed Its Solar Roof' stand when the model read nothing grave", () => {
    expect(zeroedGraveClaim("Huang's candid warning about lawsuit risk reinforces emerging concern narrative.", [{ tier: 5, outlet: "futurism.com" }])).toBeNull();
    expect(zeroedGraveClaim("Relaunch of solar ambitions signals continued diversification within energy portfolio.", [{ tier: 3, outlet: "finance.yahoo.com" }])).toBeNull();
  });

  it("lets a grave assessment stand on a reputable outlet or two outlets", () => {
    expect(zeroedGraveClaim("Death of a producer is contextual news without direct impact on Drake's current momentum trajectory.", [{ tier: 3, outlet: "hotnewhiphop.com" }, { tier: 2, outlet: "vice.com" }])).toBeNull();
    expect(zeroedGraveClaim("Workplace death lawsuit creates legal and reputational liability.", [{ tier: 3, outlet: "rss" }, { tier: 5, outlet: "independent.co.uk" }])).toBeNull();
  });
});
