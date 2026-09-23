import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADMIN ACCESS, from the application's side (Phase 9).
 *
 * Two claims are checked here:
 *
 *   1. a non-admin gets 404 — signed out, or signed in without the flag — and
 *      the check happens BEFORE the service-role client exists. Not "the query
 *      returns nothing": the privileged client is never constructed, so there
 *      is no connection for a bug elsewhere to leak through.
 *   2. every exported read in lib/admin/data.ts carries its own check. A layout
 *      is not a security boundary, so the guarantee cannot rest on it.
 *
 * The SQL side — that these relations grant nothing to the anon and
 * authenticated roles in the first place, and that no one can grant themselves
 * the flag — is lib/admin/access.db.test.ts.
 */

const NOT_FOUND = "NEXT_NOT_FOUND";

/** Stands in for next/navigation's notFound(), which throws to unwind the render. */
const notFound = vi.fn(() => {
  throw new Error(NOT_FOUND);
});

/** Counts how many times a service-role client was asked for. Must stay 0 for a non-admin. */
const createSupabaseAdminClient = vi.fn(() => {
  throw new Error("the service-role client must not be built for a non-admin");
});

let user: { id: string; email: string } | null = null;
let profile: { id: string; email: string; username: string; is_admin: boolean } | null = null;

vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("@/lib/supabase-admin", () => ({ createSupabaseAdminClient: () => createSupabaseAdminClient() }));
vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }),
      }),
    }),
  }),
}));

// React's cache() memoises per request; in a test there is no request, so the
// module is re-imported per case to get a clean read.
async function loadAdmin() {
  vi.resetModules();
  const auth = await import("./auth");
  const data = await import("./data");
  return { ...auth, ...data };
}

beforeEach(() => {
  user = null;
  profile = null;
  notFound.mockClear();
  createSupabaseAdminClient.mockClear();
});

afterEach(() => {
  vi.resetModules();
});

function signIn(isAdmin: boolean) {
  user = { id: "u1", email: "someone@example.com" };
  profile = { id: "u1", email: "someone@example.com", username: "someone", is_admin: isAdmin };
}

describe("requireAdmin", () => {
  it("404s a signed-out visitor", async () => {
    const { requireAdmin, getAdminUser } = await loadAdmin();
    expect(await getAdminUser()).toBeNull();
    await expect(requireAdmin()).rejects.toThrow(NOT_FOUND);
    expect(notFound).toHaveBeenCalled();
  });

  it("404s a signed-in user without the flag", async () => {
    signIn(false);
    const { requireAdmin, getAdminUser } = await loadAdmin();
    expect(await getAdminUser()).toBeNull();
    await expect(requireAdmin()).rejects.toThrow(NOT_FOUND);
  });

  it("returns the operator when the flag is set", async () => {
    signIn(true);
    const { requireAdmin } = await loadAdmin();
    expect(await requireAdmin()).toEqual({ id: "u1", email: "someone@example.com", username: "someone" });
  });
});

describe("every admin read", () => {
  /** Called with a window where one is taken; the argument is ignored by the ones that don't. */
  const readers = ["readLlmCost", "readIngestion", "readEngine", "readLevers", "readBehaviour", "readWaitlist"] as const;

  it("refuses a signed-out caller and never builds the service-role client", async () => {
    const admin = await loadAdmin();
    for (const name of readers) {
      const read = admin[name] as (window: "24h") => Promise<unknown>;
      await expect(read("24h"), name).rejects.toThrow(NOT_FOUND);
    }
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(notFound).toHaveBeenCalledTimes(readers.length);
  });

  it("refuses a signed-in non-admin the same way", async () => {
    signIn(false);
    const admin = await loadAdmin();
    for (const name of readers) {
      const read = admin[name] as (window: "24h") => Promise<unknown>;
      await expect(read("24h"), name).rejects.toThrow(NOT_FOUND);
    }
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("is the complete set of exports: a new read cannot be added without appearing here", async () => {
    const admin = await loadAdmin();
    const exported = Object.entries(admin)
      .filter(([name, value]) => name.startsWith("read") && typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual([...readers].sort());
  });
});

describe("the admin surface", () => {
  const root = join(__dirname, "..", "..");
  const files = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        const full = join(current, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|css)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
      }
    };
    walk(join(root, dir));
    return out;
  };
  const surface = [...files("app/admin"), ...files("components/admin"), ...files("lib/admin")];

  it("names neither raw table, so no metric level can reach the page", () => {
    for (const file of surface) {
      const source = readFileSync(file, "utf8");
      for (const table of ["raw_source_snapshots", "raw_metric_observations"]) {
        // The privacy rule holds on admin too: it is a user-facing path. Baseline
        // progress comes from metric_baseline_progress, whose columns are counts.
        expect(source.includes(table), `${relative(root, file)} names ${table}`).toBe(false);
      }
    }
  });

  it("has no write path: the operator console reads and nothing else", () => {
    for (const file of surface) {
      const source = readFileSync(file, "utf8");
      for (const write of [".insert(", ".update(", ".upsert(", ".delete(", '"use server"']) {
        expect(source.includes(write), `${relative(root, file)} contains ${write}`).toBe(false);
      }
    }
  });

  it("lives outside the main app tree, so removing the Phase 7 auth gate cannot expose it", () => {
    const admin = surface.map((file) => relative(root, file));
    expect(admin.length).toBeGreaterThan(0);
    for (const file of admin) expect(file.startsWith("app/(app)/"), file).toBe(false);
    // And the layout that guards the tree is where it is expected to be.
    expect(admin).toContain(join("app", "admin", "layout.tsx"));
  });
});
