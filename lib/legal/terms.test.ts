import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HOUSE_BANNED, copyViolations } from "@/lib/copy-rules";

import { TERMS, TERMS_CONTACT_EMAIL, allTermsStrings } from "./terms";
import { MINIMUM_AGE, TERMS_VERSION } from "./versions";

/**
 * THE BETA TERMS (Phase 32): a draft for counsel that says so, describes the
 * product as built, and keeps the house rules. A contract may speak of cash
 * in the negative ("no cash equivalent"), but never of investing, earnings,
 * returns, betting, or real money to come, and never with urgency.
 */

const root = join(__dirname, "..", "..");
// The pronoun rule is for the founder; a contract addresses "you".
const RULES = HOUSE_BANNED.filter((rule) => rule.name !== "pronoun");

describe("the beta Terms", () => {
  const strings = allTermsStrings();

  it("is marked DRAFT FOR COUNSEL on the page, with the version the consent record stores", () => {
    expect(TERMS.draft.label).toBe("DRAFT FOR COUNSEL");
    expect(TERMS.version).toBe(TERMS_VERSION);
    const page = readFileSync(join(root, "app", "(public)", "terms", "page.tsx"), "utf8");
    expect(page).toContain("TERMS.draft.label");
    expect(page).toContain("TERMS.version");
    expect(page).toMatch(/isBetaSignupEnabled\(\)\) notFound\(\)/);
    expect(page).toMatch(/index: false/);
  });

  it("breaks none of the house rules", () => {
    const hits = strings.flatMap((value) => copyViolations(value, RULES).map((rule) => `[${rule}] ${value}`));
    expect(hits).toEqual([]);
  });

  it("says paper, not money, no prize, no advice, and the age", () => {
    const all = strings.join(" ");
    expect(all).toMatch(/Paper credit is not money/);
    expect(all).toMatch(/No prize is offered/);
    expect(all).toMatch(/Nothing on the platform is financial advice/);
    expect(all).toMatch(/offers no trading with real money/);
    expect(all).toMatch(/cannot lose more than you put into a position/);
    expect(all).toContain(`${MINIMUM_AGE} or older`);
  });

  it("describes deletion as the Privacy notice and the database do: personal details deleted, trades kept without a name", () => {
    const account = TERMS.sections.find((section) => section.title === "Your account")!.body.join(" ");
    expect(account).toMatch(/delete your account at any time from your profile/);
    expect(account).toMatch(/paper trades, the paper ledger and your forecasts are kept without your name/);
  });

  it("lists what counsel must add instead of guessing at it", () => {
    const counsel = TERMS.sections.find((section) => section.title === "For counsel")!.body.join(" ");
    for (const topic of [/governing law/, /limitation of liability/, /legal entity/, /age check/]) expect(counsel).toMatch(topic);
  });

  it("gives a contact that is a real address, not a placeholder", () => {
    expect(TERMS_CONTACT_EMAIL).toBe("info@momentumterminal.app");
    expect(strings.join(" ")).toContain("{contact}");
  });
});
