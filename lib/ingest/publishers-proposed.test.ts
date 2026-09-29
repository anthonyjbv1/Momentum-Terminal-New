import { describe, expect, it } from "vitest";

import { UNKNOWN_DOMAIN_TIER, buildPublisherPolicy, normalizeDomain } from "./publishers";
import { DO_NOT_LIST, PROPOSED_TIERS, proposedPublisherRows, withProposedTiers } from "./publishers-proposed";

/**
 * THE PROPOSED TIERS (2026-09-29): a proposal, not a promotion. Off, the
 * policy is the table's rows and nothing else; on, the proposal lies beneath
 * the table and never over it. Newsweek is the case that made it.
 */

describe("the proposed publisher tiers", () => {
  it("are normalised domains at tiers 1 to 4, each with a reason, and none of them is on the do-not-list", () => {
    for (const [domain, proposal] of Object.entries(PROPOSED_TIERS)) {
      expect(normalizeDomain(domain), domain).toBe(domain);
      expect([1, 2, 3, 4]).toContain(proposal.tier);
      expect(proposal.reason.length, domain).toBeGreaterThan(10);
      expect(DO_NOT_LIST[domain], domain).toBeUndefined();
    }
    for (const domain of Object.keys(DO_NOT_LIST)) expect(normalizeDomain(domain), domain).toBe(domain);
  });

  it("place Newsweek at tier 2 and leave wgrv.com, the subjects' own channels and the aggregators at the floor", () => {
    expect(PROPOSED_TIERS["newsweek.com"].tier).toBe(2);
    for (const domain of ["wgrv.com", "chiefs.com", "youtu.be", "stocktwits.com", "aol.com"]) {
      expect(PROPOSED_TIERS[domain]).toBeUndefined();
      expect(DO_NOT_LIST[domain]).toBeDefined();
    }
  });

  it("do nothing while the switch is off", () => {
    const rows = [{ domain: "nytimes.com", status: "allowed" as const, tier: 1 }];
    expect(withProposedTiers(rows, false)).toEqual(rows);
    const policy = buildPublisherPolicy(withProposedTiers(rows, false));
    expect(policy.resolve("newsweek.com")).toEqual({ status: "unknown", domain: "newsweek.com", tier: UNKNOWN_DOMAIN_TIER });
  });

  it("lie beneath the table's rows when the switch is on: a listed domain keeps its row, the rest are added", () => {
    const rows = [
      { domain: "nytimes.com", status: "allowed" as const, tier: 1 },
      // The operator has decided otherwise for one of the proposed domains: the table wins.
      { domain: "fool.com", status: "blocked" as const, tier: null },
    ];
    const merged = withProposedTiers(rows, true);
    expect(merged).toHaveLength(rows.length + proposedPublisherRows().length - 1);
    const policy = buildPublisherPolicy(merged);
    expect(policy.resolve("www.newsweek.com")).toMatchObject({ status: "known", tier: 2 });
    expect(policy.resolve("fool.com")).toMatchObject({ status: "blocked" });
    expect(policy.resolve("nytimes.com")).toMatchObject({ status: "known", tier: 1 });
    expect(policy.resolve("wgrv.com")).toMatchObject({ status: "unknown", tier: UNKNOWN_DOMAIN_TIER });
  });
});
