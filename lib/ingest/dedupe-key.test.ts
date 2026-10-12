import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { boundedDedupeKey, DEDUPE_KEY_MAX_BYTES } from "./dedupe-key";

describe("boundedDedupeKey (2026-10-12)", () => {
  it("keeps a key that fits exactly as it was, and hashes one that would not fit the unique index", () => {
    expect(boundedDedupeKey("rss", "one-guid")).toBe("rss:one-guid");
    // The longest key ever stored (1,722 bytes) stays as it is.
    const stored = "CBMi".padEnd(1718, "a");
    expect(boundedDedupeKey("rss", stored)).toBe(`rss:${stored}`);
    // Wembanyama's item of 2026-10-10: a guid past the index's limit.
    const huge = "CBMi".padEnd(3300, "b");
    const hashed = boundedDedupeKey("rss", huge);
    expect(hashed).toBe(`rss:sha256:${createHash("sha256").update(huge, "utf8").digest("hex")}`);
    expect(hashed.length).toBeLessThan(100);
    // The same item hashes to the same key; a different one does not.
    expect(boundedDedupeKey("rss", huge)).toBe(hashed);
    expect(boundedDedupeKey("rss", `${huge}c`)).not.toBe(hashed);
    expect(boundedDedupeKey("pub", huge)).toBe(hashed.replace(/^rss:/, "pub:"));
  });

  it("measures bytes, not characters, since the index limit is in bytes", () => {
    const multibyte = "é".repeat(1000); // 2,000 bytes, 1,000 characters
    expect(Buffer.byteLength(`rss:${multibyte}`, "utf8")).toBeGreaterThan(DEDUPE_KEY_MAX_BYTES);
    expect(boundedDedupeKey("rss", multibyte)).toMatch(/^rss:sha256:[0-9a-f]{64}$/);
    expect(DEDUPE_KEY_MAX_BYTES).toBe(1800);
  });
});
