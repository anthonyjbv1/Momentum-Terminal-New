import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

import { allCopyStrings } from "./copy";
import { FEATURED_SLUG } from "./model";

/**
 * HARD RULE 1 (Phase 28): no other tracked person's name, slug or likeness
 * anywhere the public can see. The roster is read from the seeded database
 * so a person added later is covered without editing this file; every copy
 * string, every landing component, both public API routes and the OG image
 * are searched for each of them.
 */

const root = join(__dirname, "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

let database: TestDatabase;
let others: Array<{ slug: string; display_name: string; full_name: string | null }> = [];

beforeAll(async () => {
  database = await createTestDatabase();
  others = await database.rows("select slug, display_name, full_name from public.people where slug <> $1 order by slug", [FEATURED_SLUG]);
}, 180_000);

afterAll(async () => {
  await database?.close();
});

/**
 * Surnames that are also ordinary English words, exempted from the surname
 * check ("this page asks for an email" is not about Larry Page). The full
 * name and the slug are still checked for them.
 */
const ORDINARY_WORDS = new Set(["page"]);

/** Every way a person could be named: slug, display name, full name, and the surname on its own. */
function namesOf(person: { slug: string; display_name: string; full_name: string | null }): string[] {
  const surnames = [person.display_name, person.full_name ?? ""]
    .map((name) => name.split(/\s+/).filter((token) => token.replace(/[^a-z]/gi, "").length >= 4).pop())
    .filter((token): token is string => Boolean(token) && !ORDINARY_WORDS.has(token!.toLowerCase()));
  return [...new Set([person.slug, person.display_name, ...(person.full_name ? [person.full_name] : []), ...surnames])];
}

describe("the other fifteen", () => {
  it("are in the seed, and the founder is the sixteenth", async () => {
    expect(others.length).toBeGreaterThanOrEqual(15);
    const [founder] = await database.rows<{ display_name: string }>("select display_name from public.people where slug = $1", [FEATURED_SLUG]);
    expect(founder.display_name).toBe("Anthony Baptiste");
  });

  it("appear in no copy string", () => {
    const hits: string[] = [];
    for (const value of allCopyStrings()) {
      for (const person of others) {
        for (const name of namesOf(person)) {
          if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(value)) hits.push(`${person.slug} as "${name}" in: ${value}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("appear nowhere in the landing components, the public pages, the OG image or the public API", () => {
    const files = [join(root, "components", "landing"), join(root, "app", "(public)"), join(root, "app", "api", "public"), join(root, "app", "api", "waitlist"), join(root, "lib", "landing")].flatMap((dir) => sources(dir));
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const person of others) {
        for (const name of namesOf(person)) {
          if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) hits.push(`${file.slice(root.length + 1)}: ${person.slug} as "${name}"`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
