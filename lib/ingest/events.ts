import type { RawSignal } from "@/lib/connectors/types";

import type { PublisherPolicy, PublisherResolution } from "./publishers";
import { collapseStories, personNames, storyTokens, type StoredStory } from "./stories";
import type { StoredSignalStory } from "./store";

/**
 * What happens to a connector's events before any becomes a signal.
 *
 *   1. Publisher. An event that names a publisher domain is resolved through
 *      the allowlist: blocked → dropped here, before scoring; known → the
 *      row's tier; unknown → the floor tier. The tier travels with the signal
 *      (signals.tier). An event that names no publisher keeps the data
 *      source's own tier, as every API connector's events do.
 *   2. Story. Events that carry story text are collapsed with the other
 *      copies of the same story, in this poll and among the signals already
 *      stored inside the lookback, keeping the highest-tier copy. A better
 *      copy of a story the Engine has not read yet upgrades the stored
 *      signal instead of joining it.
 *
 * Pure: the caller loads the stored stories and applies the upgrades.
 * Nothing here names a source.
 */

export interface AdmittedEvent {
  signal: RawSignal;
  /** The per-item tier, or null when the data source's tier applies. */
  tier: number | null;
  publisher: Exclude<PublisherResolution, { status: "blocked" }> | null;
}

export interface BlockedEvent {
  signal: RawSignal;
  publisher: Extract<PublisherResolution, { status: "blocked" }>;
}

export interface CollapsedEvent {
  signal: RawSignal;
  tier: number;
  similarity: number;
  into: { kind: "stored"; id: string; tier: number } | { kind: "run"; signal: RawSignal };
  /** The stored signal is unprocessed and of a worse tier: rewrite it to this copy (tier, headline, payload). */
  upgrade: { id: string; tier: number; headline: string; rawPayload: Record<string, unknown> } | null;
}

export interface AdmissionInput {
  events: RawSignal[];
  person: { display_name: string; full_name: string | null };
  /** The data source's tier, for events and stored signals that carry none of their own. */
  sourceTier: number;
  policy: PublisherPolicy;
  /** Signals already stored for this person and source inside the lookback (loaded by the caller; empty when nothing carries story text). */
  recent: StoredSignalStory[];
}

export interface AdmissionResult {
  accepted: AdmittedEvent[];
  blocked: BlockedEvent[];
  collapsed: CollapsedEvent[];
  /** Events whose dedupe key is already stored: the same item seen again, neither new nor a duplicate story. */
  alreadyStored: RawSignal[];
}

/** The stored stories a poll's items are compared against: the lookback reaches back from the earliest item, not only from now. */
export function recentSince(events: RawSignal[], now: Date, lookbackHours: number): Date | null {
  const withStory = events.filter((event) => event.story !== undefined);
  if (withStory.length === 0) return null;
  const earliest = Math.min(now.getTime(), ...withStory.map((event) => event.occurredAt.getTime()));
  return new Date(earliest - lookbackHours * 3_600_000);
}

export function admitEvents(input: AdmissionInput): AdmissionResult {
  const names = personNames(input.person);
  const storedKeys = new Set(input.recent.map((row) => row.dedupeKey).filter((key): key is string => key !== null));
  const blocked: BlockedEvent[] = [];
  const alreadyStored: RawSignal[] = [];
  const resolved: AdmittedEvent[] = [];

  for (const signal of input.events) {
    if (signal.dedupeKey !== undefined && storedKeys.has(signal.dedupeKey)) {
      // The same item, fetched again: the key-based upsert would ignore it, and it is not a copy of anything.
      alreadyStored.push(signal);
      continue;
    }
    if (signal.publisherDomain === undefined) {
      resolved.push({ signal, tier: null, publisher: null });
      continue;
    }
    const publisher = input.policy.resolve(signal.publisherDomain);
    if (publisher.status === "blocked") {
      blocked.push({ signal, publisher });
      continue;
    }
    // The domain travels normalised from here on, in the signal and in its payload, with the resolution beside it.
    const rawPayload = {
      ...signal.rawPayload,
      publisher_domain: publisher.domain,
      publisher_tier: publisher.tier,
      publisher_status: publisher.status,
      publisher_matched: publisher.status === "known" ? publisher.matched : null,
    };
    resolved.push({ signal: { ...signal, publisherDomain: publisher.domain, rawPayload }, tier: publisher.tier, publisher });
  }

  const withStory = resolved.filter((entry) => entry.signal.story !== undefined);
  if (withStory.length === 0) return { accepted: resolved, blocked, collapsed: [], alreadyStored };

  const outletOf = (payload: Record<string, unknown> | null) => (payload && typeof payload.outlet === "string" ? payload.outlet : null);
  const stored: StoredStory[] = input.recent.map((row) => ({
    id: row.id,
    tokens: storyTokens(row.headline, { personNames: names, outlet: row.outlet }),
    tier: row.tier ?? input.sourceTier,
    processed: row.processed,
    occurredAt: row.occurredAt,
  }));
  const { kept, collapsed } = collapseStories(
    withStory,
    (entry) => ({
      tokens: storyTokens(entry.signal.story as string, { personNames: names, outlet: outletOf(entry.signal.rawPayload) }),
      tier: entry.tier ?? input.sourceTier,
      occurredAt: entry.signal.occurredAt,
    }),
    stored,
  );

  const keptSet = new Set(kept);
  const accepted = resolved.filter((entry) => entry.signal.story === undefined || keptSet.has(entry));

  return {
    accepted,
    blocked,
    alreadyStored,
    collapsed: collapsed.map((collapse) => {
      const tier = collapse.item.tier ?? input.sourceTier;
      if (collapse.into.kind === "stored") {
        return {
          signal: collapse.item.signal,
          tier,
          similarity: collapse.similarity,
          into: { kind: "stored", id: collapse.into.id, tier: collapse.into.tier },
          upgrade: collapse.upgrade ? { id: collapse.into.id, tier, headline: collapse.item.signal.headline, rawPayload: collapse.item.signal.rawPayload } : null,
        };
      }
      return { signal: collapse.item.signal, tier, similarity: collapse.similarity, into: { kind: "run", signal: collapse.into.item.signal }, upgrade: null };
    }),
  };
}
