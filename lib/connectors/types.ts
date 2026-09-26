import type { ExclusionReason } from "@/lib/ingest/disambiguation";
import type { PublisherPolicy } from "@/lib/ingest/publishers";
import type { DataSource, Person } from "@/types";
import type { Json } from "@/types/database";

/**
 * A single standardized data point produced by a connector.
 *
 * Signals are stored exactly as returned, with processed = false. Scoring,
 * sentiment and impact are the Engine's job in a later phase — connectors
 * never rank or weigh anything.
 */
export interface RawSignal {
  /** Self-contained, human-readable sentence, e.g. "MrBeast crosses 516M subscribers on YouTube". */
  headline: string;
  /** Everything the connector knows about the event: the numbers behind the headline, the API response, ids. */
  rawPayload: Record<string, unknown>;
  /** When the event happened (article publish time; poll time for a stats snapshot). */
  occurredAt: Date;
  /**
   * Optional idempotency key, unique per data source (article GUID, milestone
   * id). Re-running ingestion never stores the same key twice.
   */
  dedupeKey?: string;
  /**
   * The publisher's domain, for sources that name one per item (a news
   * search feed). The runner resolves the item's credibility tier from it
   * through the publisher allowlist: a blocked domain is dropped before
   * scoring, an unknown one accepted at the floor tier. Null = the item named
   * no publisher (treated as unknown). Leave undefined when the data source's
   * own tier applies, as it does for every API connector.
   */
  publisherDomain?: string | null;
  /**
   * The text that identifies the story, for story-level deduplication: the
   * headline as the outlet wrote it, without the outlet's name. Items that
   * carry it are collapsed with the same story's other copies; leave it
   * undefined for events that are not syndicated news (comments, milestones).
   */
  story?: string;
}

/** A stored metric value. */
export interface SnapshotValue {
  metricKey: string;
  value: number;
  recordedAt: Date;
}

/**
 * A raw metric level as a connector read it (a subscriber count, a popularity
 * index, a follower total). The runner snapshots it into the raw table,
 * differences it against the previous snapshot, normalises it against the
 * person's own trailing baseline and, only then, may emit a signal that
 * carries direction and normalised magnitude and never this value.
 */
export interface MetricReading {
  /** Snake-case key, must match a metric declared in data_sources.config.metrics to produce a signal. */
  metricKey: string;
  value: number;
  /** Defaults to the run's `now`. */
  recordedAt?: Date;
}

/** Whether a connector can run at all: its credentials are present, or it needs none. */
export type ConnectorAvailability = { ok: true } | { ok: false; reason: string };

/** Snapshot access scoped to one (person, data source) pair. */
export interface SnapshotStore {
  /** Newest stored value for a metric, or null on first contact. */
  latest(metricKey: string): Promise<SnapshotValue | null>;
  /** Queue a value; the runner persists queued values once the connector returns successfully. */
  record(metricKey: string, value: number, recordedAt?: Date): void;
}

/** Everything a connector may need beyond the person and their identifier. */
export interface ConnectorContext {
  /** The data_sources row for this connector (tier, poll interval, config, ...). */
  source: DataSource;
  /** data_sources.config as a plain object ({} when null): thresholds and options. Never secrets — those come from env. */
  config: Record<string, Json | undefined>;
  /** Snapshot store scoped to this person + source, for delta detection. */
  snapshots: SnapshotStore;
  /** Wall-clock time of this run. Use it instead of new Date() so runs are reproducible and testable. */
  now: Date;
  /** fetch implementation with a timeout applied. Use it instead of global fetch so it can be mocked. */
  fetch: typeof fetch;
  /**
   * The publisher allowlist for the run, for connectors that count or weigh
   * items by publisher (a news feed's volume metric must not count blocked
   * domains). The runner supplies it; absent means every domain is unknown.
   */
  publishers?: PublisherPolicy;
  /**
   * person_data_sources.config for THIS (person, source) pair ({} when null):
   * the per-subject half of a source's configuration, where `config` above is
   * the per-source half. Entity disambiguation lives here, because "which other
   * Drake is this" is a fact about Drake and not about RSS.
   */
  personConfig?: Record<string, Json | undefined>;
  /**
   * Report an item the connector refused before it became a signal — one about
   * a different entity that happens to share the subject's name. The runner
   * counts these onto the poll row and logs each, so over-filtering is visible
   * rather than silent. Symmetric with `snapshots.record`: the connector
   * queues, the runner accounts.
   */
  exclude?(item: ExcludedItem): void;
  /**
   * The publisher feed catalogue, for connectors that read SHARED feeds rather
   * than a feed per person: the rows are configuration (publisher_feeds), the
   * runner supplies them once per run and writes back what each fetch found.
   * Symmetric with `publishers`: loaded by the runner, read by the connector.
   */
  feeds?: FeedCatalog;
  /**
   * Something the operator should know that did NOT fail the poll (Phase 16):
   * a fallback read that came back empty, a figure recorded from a degraded
   * response. The runner writes notes onto the poll row's reason when the
   * poll is otherwise ok and logs each one, so a source that is quietly
   * limping shows as such in the console instead of as either healthy or
   * dead. Symmetric with `exclude`: the connector says, the runner accounts.
   */
  note?(message: string): void;
  /**
   * A structured account of what the connector did this poll (Phase 29d),
   * under a key: the Finnhub connector's insider filings — every line fetched,
   * which were the tracked person's, and why each did or did not become a
   * signal. The runner writes every entry onto the poll row
   * (source_polls.detail -> key) and logs it. Unlike a note it says nothing
   * about the poll's health, so it never touches the poll's reason.
   */
  detail?(key: string, value: Json): void;
  /**
   * What is left of the run's wall-clock budget, in milliseconds (never below
   * 0), or null when the run is unbounded (the manual endpoint). A connector
   * with a long shared read of its own (the publisher catalogue) caps that read
   * by this, so nothing it starts runs past the budget by more than one of its
   * own request timeouts.
   */
  remainingBudgetMs?(): number | null;
  /**
   * The Phase 31 signal-quality rules, present only while SIGNAL_QUALITY_ENABLED
   * is on: a news connector then refuses items published more than
   * `maxAgeHours` before the poll (they would score at zero freshness anyway
   * and only fill the person's recent lists), applies the namesake and
   * obituary guards, and judges the name-conditional exclusions. Absent, none
   * of it runs and the connector behaves exactly as before.
   */
  quality?: ConnectorQuality;
}

export interface ConnectorQuality {
  /** Items published more than this many hours before the poll are refused as stale. The Engine's freshnessMaxAgeHours. */
  maxAgeHours: number;
}

// ---------------------------------------------------------------------------
// Live mode (Phase 16)
// ---------------------------------------------------------------------------

/** A broadcast in progress, as the platform reports it. */
export interface LiveStream {
  /** The platform's id for THIS broadcast: one session per id, however many checks see it. */
  id: string;
  /** The platform's id for the broadcaster, for the reads that need it (clips). */
  broadcasterId: string;
  /** The channel as the platform names it (a login), for the audit trail. */
  channel: string;
  title: string;
  /** The game or category, or null when the platform reports none. */
  category: string | null;
  viewerCount: number | null;
  startedAt: Date | null;
}

/** Whether one mapped broadcaster is live, keyed by the mapping's external identifier. */
export interface LiveStatus {
  externalIdentifier: string;
  stream: LiveStream | null;
}

/** Clips created inside a window of one broadcast. */
export interface LiveClipCount {
  count: number;
  /** True when the page cap was reached before the window was exhausted: the count is a floor. */
  truncated: boolean;
  /** Upstream requests spent. */
  requests: number;
}

/**
 * What a connector must be able to do for the live runner (lib/ingest/live)
 * to drive it minute by minute while a mapped broadcaster is on air. A
 * connector without it is polled on its source interval and nothing else;
 * a connector with it gets live mode for every mapped broadcaster, by
 * mapping and not by code: a streamer added later is a person_data_sources
 * row.
 */
export interface LiveCapability {
  /**
   * Which of these mapped broadcasters are live right now, in as few
   * upstream requests as the platform allows (Helix answers a hundred
   * logins in one). Every identifier asked for is answered, live or not.
   */
  detect(identifiers: string[], context: ConnectorContext): Promise<LiveStatus[]>;
  /** Clips of one broadcaster created at or after `from` and before `to`. */
  countClips(broadcasterId: string, from: Date, to: Date, context: ConnectorContext): Promise<LiveClipCount>;
  /**
   * The event for a broadcast having begun, keyed exactly as the source's own
   * event poll keys it, so whichever of the two sees the stream first stores
   * it once.
   */
  liveSignal(person: Person, stream: LiveStream, now: Date): RawSignal;
}

/** An item a connector refused as being about somebody else (or, Phase 31, as a namesake's obituary). */
export interface ExcludedItem {
  /** The headline as the feed carried it, so an over-filtered item is recognisable in the log. */
  headline: string;
  reason: ExclusionReason;
  /** The term that matched; null when the item simply carried none of the required context. */
  term: string | null;
}

/** One row of the publisher feed catalogue, as the runner hands it to a connector. */
export interface FeedCatalogEntry {
  id: string;
  /** The publisher's domain: the tier resolves through the allowlist from it, and it is the fallback when an item's link names no host. */
  domain: string;
  url: string;
  /** A label for the operator: "NFL", "Music", "Top stories". */
  section: string;
  /** Which subjects watch this feed: a person whose topics intersect these reads it. Empty means everyone. */
  topics: string[];
  /** "feed": fetch and read it. "discover": find the feed behind a page, record what was found, ingest nothing. */
  mode: "feed" | "discover";
  /** Conditional-request validators from the last successful fetch. */
  etag: string | null;
  lastModified: string | null;
  lastFetchedAt: Date | null;
  lastStatus: string | null;
  consecutiveFailures: number;
}

/**
 * What one fetch of a catalogue row found.
 *   ok             a feed with dated items
 *   not_modified   the publisher answered 304 to the conditional request
 *   empty          a well-formed feed carrying no items
 *   undated        items, none with a publication date: nothing is ingested from it
 *   not_feed       the URL answers, but not with RSS or Atom
 *   error          HTTP failure, timeout, network
 *   discovered     discovery mode: a feed was found behind the page (see discoveredUrl)
 *   no_feed_found  discovery mode: nothing behind the page parsed as a feed
 */
export type FeedStatus = "ok" | "not_modified" | "empty" | "undated" | "not_feed" | "error" | "discovered" | "no_feed_found";

export interface FeedHealthReport {
  id: string;
  fetchedAt: Date;
  status: FeedStatus;
  httpStatus: number | null;
  error: string | null;
  itemCount: number | null;
  /** Items carrying a publication date: the only ones a publisher feed may ingest. */
  datedCount: number | null;
  /** Items carrying a description or body, as opposed to a bare headline. */
  describedCount: number | null;
  newestPublishedAt: Date | null;
  discoveredUrl: string | null;
  etag: string | null;
  lastModified: string | null;
}

export interface FeedCatalog {
  /** The active catalogue rows. */
  list(): Promise<FeedCatalogEntry[]>;
  /** What a fetch found; the runner persists it onto the row once the source has been polled. */
  report(health: FeedHealthReport): void;
  /** How many of a feed's items named a subject, summed over the run's people. */
  matched(feedId: string, count: number): void;
}

/**
 * Contract every data source module implements. One module per source under
 * lib/connectors/, registered in lib/connectors/registry.ts. The ingestion
 * runner reads active sources from the data_sources table and calls the
 * matching connector for every active person_data_sources mapping.
 *
 * A connector may produce EVENTS (fetchForPerson: news items, comments, real
 * text the sentiment scorer reads), METRICS (fetchMetrics: raw levels the
 * runner normalises before anything sees them), or both. What a metric means
 * (its polarity, baseline window, minimum sample, scaling) is not the
 * connector's business: it is declared on the data_sources row.
 */
export interface DataConnector {
  /** Must equal data_sources.name (e.g. "youtube"). */
  readonly name: string;
  /**
   * Connectors that carry the same STORIES declare one family, and the runner
   * then deduplicates their events against each other: a story the publisher's
   * own feed delivered at noon must not become a second signal when Google
   * News surfaces it two days later. Omitted: the source deduplicates only
   * against itself.
   */
  readonly storyFamily?: string;
  /**
   * The connector's expensive work is ONE read shared by every person of the
   * run (the publisher catalogue), and each person's poll after it is local
   * matching and a few writes. The runner then finishes every person of the
   * source once it has started, rather than skipping those left when the run
   * budget runs out: skipping them saved a second of work each after the
   * shared read had already been paid for, and deferred their items (after
   * Phase 29e). Bounded by the runner's grace past the budget.
   */
  readonly sharedFetch?: boolean;
  /**
   * Fetch fresh data about one person and translate it into RawSignals.
   * Throw (ideally a ConnectorError) on failure; the runner records the error
   * and continues with the next person.
   */
  fetchForPerson(person: Person, externalIdentifier: string, context: ConnectorContext): Promise<RawSignal[]>;
  /**
   * Read the person's current metric levels. Optional: event-only connectors
   * omit it. Throw on failure as above.
   */
  fetchMetrics?(person: Person, externalIdentifier: string, context: ConnectorContext): Promise<MetricReading[]>;
  /**
   * Can this connector run at all? A connector whose credentials are missing
   * reports why; the runner then treats the source as inactive for the run
   * and the system carries on without it. Omitted means always available.
   */
  available?(): ConnectorAvailability;
  /**
   * Live mode (Phase 16): the reads the live runner needs to follow a
   * broadcast minute by minute. Omitted: the source has no live mode.
   */
  readonly live?: LiveCapability;
}

/** Error raised by connectors for upstream API problems. */
export class ConnectorError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
