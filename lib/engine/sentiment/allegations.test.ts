import { describe, expect, it } from "vitest";

import { allegationHoldRecord, allegationHoldsPayload, allegationTerm, classifyAllegation, publisherOf } from "./allegations";

/**
 * THE ALLEGATION HOLD (2026-10-09): the rule as settled, on the stories that
 * made it necessary. Kai Cenat's 30-day set, as production stored it:
 * azcentral.com resolved at tier 5 (an unknown publisher), USA Today at tier
 * 2, TMZ at tier 3, The Times of India at 5, x.com at 5.
 */

const article = (headline: string, domain: string | null, tier: number) => ({
  headline,
  rawPayload: { kind: "article", publisher_domain: domain, publisher_tier: tier, outlet: domain },
  sourceName: "rss",
  sourceTier: 3,
});

describe("the terms backstop", () => {
  it("flags the allegation terms of the 59-term list, by category, and nothing else on the list", () => {
    expect(allegationTerm("Twitch streamer Reggie Travers accuses brother of sexual abuse in tearful video")).toEqual({ category: "sexual_abuse", term: "sexual abuse" });
    expect(allegationTerm("Reggie Accuses Kai Cenat of Grooming in Streaming Feud")).toEqual({ category: "minors", term: "grooming" });
    expect(allegationTerm("Kai Cenat Calls Out Former Friend Over Grooming Allegations")).toEqual({ category: "minors", term: "grooming" });
    expect(allegationTerm("RaKai denies Reggie's childhood abuse allegations and breaks silence")).toEqual({ category: "sexual_abuse", term: "abuse" });
    expect(allegationTerm("Streamer charged with domestic violence after arrest")).toEqual({ category: "violence", term: "domestic violence" });
    // Death, illness and obituary terms are grave claims, not allegations of a crime.
    expect(allegationTerm("Larry Page Obituary (2026) - Greeneville, TN")).toBeNull();
    expect(allegationTerm("Tay Keith died of drug overdose: Autopsy report")).toBeNull();
    expect(allegationTerm("Tesla Killed Its Solar Roof. Now Elon Musk Wants 100 GW of Solar")).toBeNull();
    expect(allegationTerm(null)).toBeNull();
  });
});

describe("classifyAllegation", () => {
  it("takes the model's label first, and falls back to the terms with the method recorded", () => {
    const usaToday = article("Popular streamer Kai Cenat responds to abuse allegations: 'I'm suing you, bro!'", "usatoday.com", 2);
    expect(classifyAllegation(usaToday, { allegation: "minors" })).toMatchObject({ category: "minors", method: "model", publisherDomain: "usatoday.com", publisherTier: 2, qualifying: true, held: false });
    expect(classifyAllegation(usaToday, { allegation: "none" })).toMatchObject({ category: "sexual_abuse", method: "terms", term: "abuse" });
    expect(classifyAllegation(usaToday, undefined)).toMatchObject({ method: "terms" });
    // Neither method flags it: not an allegation story.
    expect(classifyAllegation(article("Kai Cenat hits 20M followers on Twitch", "dexerto.com", 3), { allegation: "none" })).toBeNull();
  });

  it("holds a lower-tier publisher's story, however many of them there are, and a denial the same way", () => {
    const azcentral = classifyAllegation(article("Twitch streamer Reggie Travers accuses brother of sexual abuse in tearful video", "azcentral.com", 5), { allegation: "sexual_abuse" });
    expect(azcentral).toMatchObject({ qualifying: false, held: true, publisherTier: 5 });
    const tmz = classifyAllegation(article("Kai Cenat Calls Out Former Friend Over Grooming Allegations", "tmz.com", 3), { allegation: "minors" });
    expect(tmz).toMatchObject({ qualifying: false, held: true, publisherTier: 3 });
    // A denial repeats the claim: held at its tier like any other story on it.
    const denial = classifyAllegation(article("RaKai denies Reggie's childhood abuse allegations and breaks silence on the viral controversy", "timesofindia.indiatimes.com", 5), { allegation: "sexual_abuse" });
    expect(denial).toMatchObject({ qualifying: false, held: true });
    // A post on x.com is not a publisher's report.
    expect(classifyAllegation(article("Reggie Accuses Kai Cenat of Grooming in Streaming Feud", "x.com", 5), { allegation: "minors" })).toMatchObject({ held: true });
  });

  it("lets only a tier 1-2 PUBLISHER's story display: the qualifying story, and later tier 1-2 coverage", () => {
    expect(classifyAllegation(article("Popular streamer Kai Cenat responds to abuse allegations: 'I'm suing you, bro!'", "usatoday.com", 2), { allegation: "minors" })).toMatchObject({ qualifying: true, held: false });
    expect(classifyAllegation(article("Kai Cenat sues former friend over abuse claim", "apnews.com", 1), { allegation: "minors" })).toMatchObject({ qualifying: true, held: false });
  });

  it("never lets a connector's tier lift a hold: Twitch, YouTube and API-Sports measure weighting, not reporting", () => {
    // The Twitch source is tier 2; a go-live or a live moment carrying the claim in its title is held.
    const twitch = classifyAllegation({ headline: 'Kai Cenat is live on Twitch: "Addressing the grooming allegations"', rawPayload: { kind: "stream", source: "twitch", stream_id: "1" }, sourceName: "twitch", sourceTier: 2 }, { allegation: "minors" });
    expect(twitch).toMatchObject({ category: "minors", publisherDomain: null, publisherTier: 2, qualifying: false, held: true });
    const youtube = classifyAllegation({ headline: "Kai Cenat uploads: responding to the abuse allegations", rawPayload: { kind: "video", source: "youtube" }, sourceName: "youtube", sourceTier: 2 }, { allegation: "sexual_abuse" });
    expect(youtube).toMatchObject({ publisherDomain: null, qualifying: false, held: true });
    // A feed item with no publisher element resolves to no publisher, whatever the source's tier.
    const bare = classifyAllegation({ headline: "Grooming allegations against streamer", rawPayload: { kind: "article", publisher_tier: 1 }, sourceName: "publisher_rss", sourceTier: 1 }, { allegation: "minors" });
    expect(bare).toMatchObject({ publisherDomain: null, qualifying: false, held: true });
    expect(publisherOf({ rawPayload: { kind: "article", publisher_domain: "Reuters.com ", publisher_tier: 1 }, sourceName: "rss", sourceTier: 3 })).toEqual({ domain: "reuters.com", tier: 1 });
  });

  it("builds the record the tick hands the database, in its column names", () => {
    const flag = classifyAllegation(article("Reggie Accuses Kai Cenat of Grooming in Streaming Feud", "x.com", 5), { allegation: "minors" })!;
    const record = allegationHoldRecord("sig-1", flag);
    expect(record).toEqual({ signalId: "sig-1", category: "minors", method: "model", publisherDomain: "x.com", publisherTier: 5, qualifying: false });
    expect(allegationHoldsPayload([record])).toEqual([{ signal_id: "sig-1", category: "minors", method: "model", publisher_domain: "x.com", publisher_tier: 5, qualifying: false }]);
  });
});
