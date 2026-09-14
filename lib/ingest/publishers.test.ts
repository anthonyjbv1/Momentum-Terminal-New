import { describe, expect, it } from "vitest";

import { EMPTY_PUBLISHER_POLICY, UNKNOWN_DOMAIN_TIER, buildPublisherPolicy, domainCandidates, normalizeDomain, publisherDomainOf } from "./publishers";

describe("normalizeDomain", () => {
  it("lower-cases, strips scheme, path, port, userinfo, www. and a trailing dot", () => {
    expect(normalizeDomain("https://www.Billboard.com/music/rap/drake")).toBe("billboard.com");
    expect(normalizeDomain("WWW.Example.co.uk.")).toBe("example.co.uk");
    expect(normalizeDomain("www2.example.com")).toBe("example.com");
    expect(normalizeDomain("example.com:8080/path?x=1")).toBe("example.com");
    expect(normalizeDomain("user@example.com")).toBe("example.com");
    expect(normalizeDomain("//cdn.example.com/x")).toBe("cdn.example.com");
    expect(normalizeDomain("  M.Example.COM  ")).toBe("m.example.com");
  });

  it("keeps a subdomain other than www, so a more specific row can still match", () => {
    expect(normalizeDomain("music.example.com")).toBe("music.example.com");
  });

  it("returns null for what is not a domain", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("http://")).toBeNull();
  });
});

describe("publisherDomainOf", () => {
  it("takes the feed's source URL over the link, and never a Google News wrapper", () => {
    expect(publisherDomainOf({ sourceUrl: "https://www.billboard.com", link: "https://news.google.com/rss/articles/CBMi" })).toEqual({ domain: "billboard.com", from: "source" });
    expect(publisherDomainOf({ sourceUrl: null, link: "https://news.google.com/rss/articles/CBMi" })).toEqual({ domain: null, from: null });
    expect(publisherDomainOf({ sourceUrl: null, link: "https://www.theguardian.com/music/2026/drake" })).toEqual({ domain: "theguardian.com", from: "link" });
    expect(publisherDomainOf({ sourceUrl: "https://feeds.feedburner.com/x", link: "https://pitchfork.com/news/x" })).toEqual({ domain: "pitchfork.com", from: "link" });
    expect(publisherDomainOf({ sourceUrl: null, link: null })).toEqual({ domain: null, from: null });
  });
});

describe("domainCandidates", () => {
  it("walks up to the last two labels, most specific first", () => {
    expect(domainCandidates("music.example.co.uk")).toEqual(["music.example.co.uk", "example.co.uk", "co.uk"]);
    expect(domainCandidates("example.com")).toEqual(["example.com"]);
  });
});

describe("buildPublisherPolicy", () => {
  const policy = buildPublisherPolicy([
    { domain: "WWW.Complex.com", status: "allowed", tier: 2 },
    { domain: "bbc.co.uk", status: "allowed", tier: 1 },
    { domain: "sponsored.bbc.co.uk", status: "blocked", tier: null },
    { domain: "defensorianna.gob.ar", status: "blocked", tier: null },
    { domain: "not a domain", status: "allowed", tier: 1 },
  ]);

  it("resolves a known domain to its tier, through www. and subdomains", () => {
    expect(policy.size).toBe(4);
    expect(policy.resolve("complex.com")).toEqual({ status: "known", domain: "complex.com", matched: "complex.com", tier: 2 });
    expect(policy.resolve("https://www.complex.com/music")).toEqual({ status: "known", domain: "complex.com", matched: "complex.com", tier: 2 });
    expect(policy.resolve("music.bbc.co.uk")).toEqual({ status: "known", domain: "music.bbc.co.uk", matched: "bbc.co.uk", tier: 1 });
  });

  it("lets a more specific row override its parent, and blocks before scoring", () => {
    expect(policy.resolve("sponsored.bbc.co.uk")).toEqual({ status: "blocked", domain: "sponsored.bbc.co.uk", matched: "sponsored.bbc.co.uk" });
    expect(policy.resolve("www.defensorianna.gob.ar")).toEqual({ status: "blocked", domain: "defensorianna.gob.ar", matched: "defensorianna.gob.ar" });
  });

  it("accepts an unknown domain at the floor tier, never rejecting it", () => {
    expect(UNKNOWN_DOMAIN_TIER).toBe(5);
    expect(policy.resolve("inmusicblog.com")).toEqual({ status: "unknown", domain: "inmusicblog.com", tier: 5 });
    expect(policy.resolve(null)).toEqual({ status: "unknown", domain: null, tier: 5 });
    expect(policy.resolve("")).toEqual({ status: "unknown", domain: null, tier: 5 });
    expect(EMPTY_PUBLISHER_POLICY.resolve("complex.com")).toEqual({ status: "unknown", domain: "complex.com", tier: 5 });
  });
});
