import { createHash } from "node:crypto";

/**
 * A dedupe key that fits the unique index (2026-10-12). The article
 * connectors key a signal on the feed item's guid, and a Google News guid
 * is the article's address encoded, which can run past 3,000 bytes: on
 * 2026-10-10 one such item made Postgres refuse the whole batch for
 * Wembanyama on every poll ("index row size 3312 exceeds btree version 4
 * maximum 2704"), 85 of his 92 polls in a day. A key longer than the bound
 * is replaced by the SHA-256 of what it carried, under the same prefix, so
 * it still names one item and only that item. The bound sits above the
 * longest key ever stored (1,722 bytes), so no stored article is re-admitted
 * under a new spelling, and well under the index's limit.
 */
export const DEDUPE_KEY_MAX_BYTES = 1800;

export function boundedDedupeKey(prefix: string, key: string): string {
  const raw = `${prefix}:${key}`;
  if (Buffer.byteLength(raw, "utf8") <= DEDUPE_KEY_MAX_BYTES) return raw;
  return `${prefix}:sha256:${createHash("sha256").update(key, "utf8").digest("hex")}`;
}
