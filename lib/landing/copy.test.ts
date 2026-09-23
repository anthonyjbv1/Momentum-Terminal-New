import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FEATURED_SLUG } from "./model";
import { FEATURED, HEADLINES, HERO, HOW, META, OG, PRIVACY, PRIVACY_CONTACT_EMAIL, PRIVACY_CONTACT_IS_PLACEHOLDER, WAITLIST, WHY, allCopyStrings } from "./copy";

/**
 * THE COPY RULES (Phase 28), held against every string a stranger reads.
 *
 * lib/landing/copy.ts is the one file of landing copy; this test walks all of
 * it, plus the source of every landing component and public page, so a
 * sentence that slips into a component rather than the copy file is caught
 * by the same rules. The other people's names are checked against the seed
 * in copy.db.test.ts, where the roster is read from the database.
 */

const root = join(__dirname, "..", "..");

/** Never, in any form: the words the brief forbids, and the two it forbids by frame. */
const BANNED: Array<{ name: string; pattern: RegExp }> = [
  { name: "invest", pattern: /\binvest\w*/i },
  { name: "bet", pattern: /\bbet(s|ting|tor|tors)?\b/i },
  { name: "gamble", pattern: /\bgambl\w*/i },
  { name: "wager", pattern: /\bwager\w*/i },
  { name: "earn", pattern: /\bearn(s|ed|ing|ings)?\b/i },
  { name: "profit", pattern: /\bprofit\w*/i },
  { name: "returns", pattern: /\breturn(s|ed|ing)?\b/i },
  { name: "income", pattern: /\bincome\b/i },
  { name: "get paid", pattern: /\bget(s|ting)? paid\b|\bpaid\b|\bpayout\w*/i },
  { name: "worth (a person's)", pattern: /\bworth\b/i },
  { name: "value (a person's)", pattern: /\bvalue[sd]?\b|\bvaluation\b/i },
  { name: "real money coming", pattern: /real[- ]money (trading )?(is|will|soon|coming|later|next)/i },
  { name: "Oracle", pattern: /\boracle\b/i },
  { name: "Black Mirror", pattern: /black mirror/i },
  { name: "Nosedive", pattern: /nosedive/i },
  // No manufactured urgency.
  { name: "urgency", pattern: /\b(hurry|limited (time|spots|places)|only \d+ (left|spots|places)|last chance|act now|don.t miss)\b/i },
  // The founder is never a pronoun.
  { name: "pronoun", pattern: /\b(he|him|his|she|her|hers)\b/ },
];

/** Every source file under a directory. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The text a component could put on screen: its string literals and its JSX
 * text nodes, one per line with the source line number. Code (a `return`, a
 * `value` prop) is not prose and is not scanned.
 */
function visibleText(source: string): Array<{ line: number; text: string }> {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " ")).replace(/^(\s*)\/\/.*$/gm, "$1");
  const out: Array<{ line: number; text: string }> = [];
  stripped.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push({ line: index + 1, text: match[1] ?? match[2] ?? match[3] ?? "" });
    for (const match of line.matchAll(/>([^<>{}]+)</g)) out.push({ line: index + 1, text: match[1] });
  });
  return out.filter((item) => item.text.trim() !== "");
}

describe("the copy file", () => {
  const strings = allCopyStrings();

  it("holds every sentence, and there are enough of them to be the whole page", () => {
    expect(strings.length).toBeGreaterThan(40);
    for (const value of strings) expect(value.trim(), JSON.stringify(value)).not.toBe("");
  });

  it("uses none of the banned words, in any string", () => {
    const hits: string[] = [];
    for (const value of strings) {
      for (const rule of BANNED) if (rule.pattern.test(value)) hits.push(`[${rule.name}] ${value}`);
    }
    expect(hits).toEqual([]);
  });

  it("says plainly that the beta is paper trading, not real money, in the hero, the beats and the footer", () => {
    expect(HERO.paper).toMatch(/paper trading/i);
    expect(HERO.paper).toMatch(/not real money/i);
    expect(HOW.beats[2].body).toMatch(/paper credits/i);
    expect(HOW.beats[2].body).toMatch(/no real money/i);
    expect(META.description).toMatch(/paper-trading/i);
  });

  it("uses the locked terminology: Momentum Score, the Engine, shares, Rising and Falling", () => {
    expect(HERO.scoreLabel).toBe("Momentum Score");
    expect(HOW.beats[1].title).toMatch(/the Engine/i);
    expect(HOW.beats[2].body).toMatch(/\bshares\b/);
    expect(HOW.beats[2].body).toMatch(/Rising or Falling/);
    // Lower-case "momentum score" is not the product's name.
    for (const value of strings) expect(value, value).not.toMatch(/momentum score/);
  });

  it("frames the number as momentum and trajectory, measured the same for everyone", () => {
    expect(HOW.beats[1].body).toMatch(/trajectory/);
    expect(HOW.beats[1].body).toMatch(/never the person/);
  });

  it("names only the founder, honestly, with consent, and matches the featured slug", () => {
    expect(FEATURED.slug).toBe(FEATURED_SLUG);
    expect(FEATURED.name).toBe("Anthony Baptiste");
    expect(FEATURED.role).toMatch(/Founder/);
    expect(FEATURED.consent).toMatch(/consent/);
    expect(HERO.sub).toMatch(/founder/);
    expect(META.ogAlt).toMatch(/founder/);
  });

  it("offers three headlines and picks one", () => {
    expect(HEADLINES.alternatives).toHaveLength(2);
    const all = [HEADLINES.chosen, ...HEADLINES.alternatives];
    expect(new Set(all).size).toBe(3);
    expect(HERO.headline).toBe(HEADLINES.chosen);
    for (const headline of all) expect(headline.length).toBeLessThanOrEqual(90);
  });

  it("promises no email beyond the invite, and shows a position only from a placeholder the server fills", () => {
    expect(WAITLIST.consent).toMatch(/nothing else/);
    expect(WAITLIST.success.withPosition).toContain("{position}");
    expect(WAITLIST.success.withoutPosition).not.toContain("{position}");
    expect(WAITLIST.success.withoutPosition).not.toMatch(/\d/);
  });

  it("carries a contact address for deletion requests on the privacy page, and a placeholder cannot pass for a real one", () => {
    expect(PRIVACY_CONTACT_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    // The flag and the value are held in step: a placeholder says so in its
    // own text (a reserved domain that can receive nothing), and a real
    // address is not allowed to look like one. Swapping the address without
    // clearing the flag, or the reverse, fails here.
    const looksLikePlaceholder = /placeholder|\.example$|@example\./i.test(PRIVACY_CONTACT_EMAIL);
    expect(looksLikePlaceholder, `PRIVACY_CONTACT_EMAIL "${PRIVACY_CONTACT_EMAIL}" vs PRIVACY_CONTACT_IS_PLACEHOLDER ${PRIVACY_CONTACT_IS_PLACEHOLDER}`).toBe(PRIVACY_CONTACT_IS_PLACEHOLDER);
    const deletion = PRIVACY.sections.find((section) => section.title === "Deletion")!;
    expect(deletion.body.join(" ")).toContain("{contact}");
    expect(PRIVACY.sections.map((section) => section.title)).toEqual(["What is collected", "Why", "How long", "Deletion"]);
    expect(PRIVACY.sections.find((section) => section.title === "Why")!.body.join(" ")).toMatch(/not sold/);
  });

  it("the OG image says the same things the page does", () => {
    expect(OG.scoreLabel).toBe(HERO.scoreLabel);
    expect(OG.brand).toBe("Momentum Terminal");
  });

  it("the why-it-moved lines name the founder by first name only and describe forces, not the person", () => {
    for (const line of Object.values(WHY.forces)) expect(line).not.toMatch(/\b(he|his|him)\b/);
    expect(WHY.noSignals).toMatch(/still real/);
  });
});

describe("the landing components carry no sentence of their own", () => {
  const files = [join(root, "components", "landing"), join(root, "app", "(public)")].flatMap((dir) => sources(dir));

  it("scans the landing tree", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  for (const file of files) {
    it(`${file.slice(root.length + 1)} uses none of the banned words in a literal or a text node`, () => {
      const hits: string[] = [];
      for (const { line, text } of visibleText(readFileSync(file, "utf8"))) {
        for (const rule of BANNED) {
          // The pronoun rule is for prose; a literal such as a field name is not prose.
          if (rule.name === "pronoun") continue;
          if (rule.pattern.test(text)) hits.push(`${line}: [${rule.name}] ${text.trim()}`);
        }
      }
      expect(hits).toEqual([]);
    });
  }
});
