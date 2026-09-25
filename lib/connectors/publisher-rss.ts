import { excludeReason, hasRules, readDisambiguation } from "@/lib/ingest/disambiguation";
import { normalizeDomain, publisherDomainOf } from "@/lib/ingest/publishers";
import type { Json } from "@/types/database";

import { NEWS_STORY_FAMILY, parseFeed, type FeedItem } from "./rss";
import { ConnectorError, type ConnectorContext, type DataConnector, type FeedCatalogEntry, type FeedHealthReport, type RawSignal } from "./types";

/**
 * Publisher-direct feeds — the outlets' own RSS, read as a SHARED catalogue.
 *
 * THE INVERSION. The Google News connector searches for a name and gets back
 * whatever the aggregator ranked, one to three days after publication, so a
 * real story arrives already discounted by the freshness curve. A publisher's
 * own section feed inverts that: it carries ALL of that section's coverage,
 * with the publication timestamp the outlet wrote, and we filter for the
 * subjects' names. More in, better timestamps, better provenance — and the
 * tier is trivial, because the feed's domain is the publisher.
 *
 * What the inversion costs: every catalogue feed is fetched every poll whether
 * or not it mentions anyone (the request volume is per feed, not per subject),
 * and every item is name-matched against every subject who watches that
 * feed's topics. Both are bounded here: feeds are fetched ONCE per run and
 * shared across subjects (a module cache keyed on the run's clock, as the
 * API-Sports games list is), with a concurrency cap, a per-feed timeout and a
 * budget for the whole fetch; matching is a word-boundary test over the
 * headline only.
 *
 * WHAT IS REFUSED. An item with no publication date is never ingested from
 * here — dating it "now" would put exactly the assumed timestamp this source
 * exists to avoid into the freshness curve — and is counted on the feed's
 * health instead. Items older than max_item_age_hours are not ingested either:
 * a first fetch of a deep feed must not backfill a week of stale coverage.
 *
 * WHAT IS WRITTEN BACK. Each fetch reports what it found — status, HTTP code,
 * item and dated and described counts, the newest date, the conditional
 * validators — through context.feeds, and the runner persists it onto the
 * catalogue row. That is how "does this outlet's feed actually carry real
 * pubDates" is answered: measured on every poll, never assumed.
 *
 * DISCOVERY. A catalogue row in mode "discover" names a page rather than a
 * feed. The connector fetches it, and if the page is not itself a feed, reads
 * the `<link rel="alternate" type="application/rss+xml">` declarations in its
 * head, then anchors that look like feed links, then the conventional paths
 * (/feed/, /rss, /rss.xml, /feed.xml, /index.xml, /atom.xml), validating each
 * candidate as a feed with dated items. The first that validates is recorded
 * as discovered_url; nothing is ingested from a discovery row, and a row that
 * has reported either way is not fetched again until an operator resets it.
 *
 * Entity disambiguation applies exactly as on the Google News feed: the
 * person_data_sources row's exclusions run over the headline and outlet, and
 * refusals are counted on the poll. The Google News feed stays registered as
 * the fallback for coverage this catalogue misses.
 */

export const PUBLISHER_RSS_SOURCE_NAME = "publisher_rss";

export interface PublisherRssConfig {
  /** Newest dated items read from one feed per poll. Default 50, at most 200. */
  max_items_per_feed: number;
  /** Newest matched items stored per person per poll. Default 60, at most 200. */
  max_items_per_person: number;
  /** Items published longer ago than this are not ingested. Default 72. */
  max_item_age_hours: number;
  /** Feeds fetched at once. Default 8, at most 16. */
  concurrency: number;
  /** Per-feed request timeout. Default 6000. */
  feed_timeout_ms: number;
  /** Budget for STARTING fetches of the catalogue; feeds not started inside it wait for the next poll. Default 15000. Never more than what is left of the run's own budget. */
  fetch_budget_ms: number;
}

const DEFAULT_CONFIG: PublisherRssConfig = {
  max_items_per_feed: 50,
  max_items_per_person: 60,
  max_item_age_hours: 72,
  concurrency: 8,
  feed_timeout_ms: 6_000,
  fetch_budget_ms: 15_000,
};

/** Items dated this far into the future are still accepted: publisher clocks drift by minutes, not hours. */
const FUTURE_TOLERANCE_MS = 10 * 60_000;
/** A row that keeps failing is retried less often: this many minutes per consecutive failure, up to twelve. */
const BACKOFF_STEP_MINUTES = 15;
const BACKOFF_MAX_STEPS = 12;
/** Discovery retries a transient error this many times, then waits for an operator. */
const DISCOVERY_MAX_FAILURES = 3;
const DISCOVERY_MAX_CANDIDATES = 12;
const CONVENTIONAL_FEED_PATHS = ["/feed/", "/rss", "/rss.xml", "/feed.xml", "/index.xml", "/atom.xml"];
const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.5, */*;q=0.4";

function positiveInt(value: Json | undefined, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(max, value) : fallback;
}

export function readPublisherRssConfig(config: Record<string, Json | undefined>): PublisherRssConfig {
  const hours = config.max_item_age_hours;
  return {
    max_items_per_feed: positiveInt(config.max_items_per_feed, DEFAULT_CONFIG.max_items_per_feed, 200),
    max_items_per_person: positiveInt(config.max_items_per_person, DEFAULT_CONFIG.max_items_per_person, 200),
    max_item_age_hours: typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_CONFIG.max_item_age_hours,
    concurrency: positiveInt(config.concurrency, DEFAULT_CONFIG.concurrency, 16),
    feed_timeout_ms: positiveInt(config.feed_timeout_ms, DEFAULT_CONFIG.feed_timeout_ms, 30_000),
    fetch_budget_ms: positiveInt(config.fetch_budget_ms, DEFAULT_CONFIG.fetch_budget_ms, 50_000),
  };
}

/** The per-subject half: the names an item must carry and the topics whose feeds are read. */
export interface PublisherSubjectConfig {
  /** Word-boundary, case-insensitive; the row's external_identifier is always the first. */
  terms: string[];
  /** Feeds tagged with any of these are read. Empty means every feed. */
  topics: string[];
}

function stringList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function readSubjectConfig(config: Record<string, Json | undefined> | null | undefined, identifier: string, person: { display_name: string }): PublisherSubjectConfig {
  const record = config && typeof config === "object" ? config : {};
  const terms = [identifier.trim(), ...stringList(record.match_terms)].filter((term, index, all) => term.length > 0 && all.indexOf(term) === index);
  return { terms: terms.length > 0 ? terms : [person.display_name], topics: stringList(record.topics).map((topic) => topic.toLowerCase()) };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Lower case, ASCII-folded (é → e), whitespace collapsed. */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the text names the term as whole words: "Drake's" and "Mahomes,"
 * match, "Drakeford" and "Mahomesville" do not. Substring matching is right
 * for EXCLUSIONS (a fragment of the wrong entity's vocabulary is evidence
 * enough to refuse) and wrong for ADMISSION, where a short name inside a
 * longer word is not a mention.
 */
export function matchesTerm(text: string, term: string): boolean {
  const needle = fold(term);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(fold(text));
}

/** The first configured term the headline names, or null. */
export function matchedTerm(text: string, terms: string[]): string | null {
  return terms.find((term) => matchesTerm(text, term)) ?? null;
}

/** A subject reads a feed when their topics meet; an untagged feed or an untagged subject reads everything. */
export function watchesFeed(subjectTopics: string[], feedTopics: string[]): boolean {
  if (subjectTopics.length === 0 || feedTopics.length === 0) return true;
  return feedTopics.some((topic) => subjectTopics.includes(topic.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Fetching the catalogue, once per run
// ---------------------------------------------------------------------------

export interface FetchedFeed {
  entry: FeedCatalogEntry;
  /** Dated items inside the age window, newest first, capped. Empty for a discovery row or a failed fetch. */
  items: FeedItem[];
}

let catalogCache: { key: string; pending: Promise<FetchedFeed[]> } | null = null;

/** For tests. */
export function resetPublisherFeedCache(): void {
  catalogCache = null;
}

/**
 * Whether a row is fetched on this poll. A feed that keeps failing backs off
 * (a dead URL is one request an hour, not four); a discovery row runs until
 * it has reported a finding either way, retrying only a transient error.
 */
export function isDue(entry: FeedCatalogEntry, now: Date): boolean {
  if (entry.mode === "discover") {
    if (entry.lastStatus === null) return true;
    return entry.lastStatus === "error" && entry.consecutiveFailures < DISCOVERY_MAX_FAILURES;
  }
  if (entry.consecutiveFailures < 3 || !entry.lastFetchedAt) return true;
  const waitMs = Math.min(entry.consecutiveFailures, BACKOFF_MAX_STEPS) * BACKOFF_STEP_MINUTES * 60_000;
  return now.getTime() - entry.lastFetchedAt.getTime() >= waitMs;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" || error.name === "AbortError" ? "timed out" : error.message;
  return String(error);
}

/** Parses a body as a feed, or null when it is not one. */
function tryParseFeed(body: string): ReturnType<typeof parseFeed> | null {
  try {
    return parseFeed(body);
  } catch {
    return null;
  }
}

function summarise(items: FeedItem[]): Pick<FeedHealthReport, "itemCount" | "datedCount" | "describedCount" | "newestPublishedAt"> {
  const dated = items.filter((item) => item.publishedAt !== null);
  return {
    itemCount: items.length,
    datedCount: dated.length,
    describedCount: items.filter((item) => item.hasDescription === true).length,
    newestPublishedAt: dated.length > 0 ? new Date(Math.max(...dated.map((item) => (item.publishedAt as Date).getTime()))) : null,
  };
}

/** The items a feed contributes: dated, inside the age window, newest first, capped. */
export function usableItems(items: FeedItem[], now: Date, config: PublisherRssConfig): FeedItem[] {
  const oldest = now.getTime() - config.max_item_age_hours * 3_600_000;
  const newest = now.getTime() + FUTURE_TOLERANCE_MS;
  return items
    .filter((item): item is FeedItem & { publishedAt: Date } => item.publishedAt !== null && item.publishedAt.getTime() >= oldest && item.publishedAt.getTime() <= newest)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, config.max_items_per_feed);
}

async function fetchFeedRow(entry: FeedCatalogEntry, context: ConnectorContext, config: PublisherRssConfig): Promise<FetchedFeed> {
  const base: Pick<FeedHealthReport, "id" | "fetchedAt" | "discoveredUrl"> = { id: entry.id, fetchedAt: context.now, discoveredUrl: null };
  const failed = (status: "error" | "not_feed", httpStatus: number | null, error: string): FetchedFeed => {
    context.feeds?.report({ ...base, status, httpStatus, error, itemCount: null, datedCount: null, describedCount: null, newestPublishedAt: null, etag: null, lastModified: null });
    return { entry, items: [] };
  };
  try {
    const headers: Record<string, string> = { accept: FEED_ACCEPT };
    if (entry.etag) headers["if-none-match"] = entry.etag;
    if (entry.lastModified) headers["if-modified-since"] = entry.lastModified;
    const response = await context.fetch(entry.url, { headers, signal: AbortSignal.timeout(config.feed_timeout_ms) });
    if (response.status === 304) {
      context.feeds?.report({ ...base, status: "not_modified", httpStatus: 304, error: null, itemCount: null, datedCount: null, describedCount: null, newestPublishedAt: null, etag: entry.etag, lastModified: entry.lastModified });
      return { entry, items: [] };
    }
    if (!response.ok) return failed("error", response.status, `responded ${response.status}`);
    const body = await response.text();
    const parsed = tryParseFeed(body);
    if (!parsed) return failed("not_feed", response.status, /<html[\s>]/i.test(body.slice(0, 2_000)) ? "answered with an HTML page, not a feed" : "answered with something that is not RSS or Atom");
    const counts = summarise(parsed.items);
    const status = parsed.items.length === 0 ? "empty" : counts.datedCount === 0 ? "undated" : "ok";
    context.feeds?.report({ ...base, ...counts, status, httpStatus: response.status, error: null, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") });
    return { entry, items: usableItems(parsed.items, context.now, config) };
  } catch (error) {
    return failed("error", null, errorText(error));
  }
}

/** Absolute feed URLs a page declares or links to, head declarations first, then the conventional paths. */
export function feedCandidatesFrom(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const add = (href: string | null | undefined) => {
    if (!href) return;
    let resolved: URL;
    try {
      resolved = new URL(href.replace(/&amp;/g, "&").trim(), pageUrl);
    } catch {
      return;
    }
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return;
    const url = resolved.toString();
    if (!out.includes(url)) out.push(url);
  };
  const attribute = (tag: string, name: string): string | null => {
    const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
  };

  const head = html.slice(0, 200_000);
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attribute(tag, "rel") ?? "";
    const type = attribute(tag, "type") ?? "";
    if (/\balternate\b/i.test(rel) && /application\/(rss|atom)\+xml/i.test(type)) add(attribute(tag, "href"));
  }
  const page = new URL(pageUrl);
  const site = page.hostname.replace(/^www\d*\./, "").split(".").slice(-2).join(".");
  for (const tag of head.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attribute(tag, "href");
    if (!href || !/(rss|feed|atom)/i.test(href) && !/\.xml(\?|$)/i.test(href)) continue;
    let resolved: URL;
    try {
      resolved = new URL(href.replace(/&amp;/g, "&"), pageUrl);
    } catch {
      continue;
    }
    const host = resolved.hostname;
    if (host.endsWith(site) || host.startsWith("feeds.") || host.includes("feedburner")) add(resolved.toString());
    if (out.length >= DISCOVERY_MAX_CANDIDATES) break;
  }
  const trimmedPath = page.pathname.replace(/\/+$/, "");
  const bases = trimmedPath ? [`${page.origin}${trimmedPath}`, page.origin] : [page.origin];
  for (const basePath of bases) for (const path of CONVENTIONAL_FEED_PATHS) add(`${basePath}${path}`);
  return out.slice(0, DISCOVERY_MAX_CANDIDATES);
}

async function discoverFeedRow(entry: FeedCatalogEntry, context: ConnectorContext, config: PublisherRssConfig): Promise<FetchedFeed> {
  const report = (health: Omit<FeedHealthReport, "id" | "fetchedAt" | "etag" | "lastModified">) =>
    context.feeds?.report({ id: entry.id, fetchedAt: context.now, etag: null, lastModified: null, ...health });
  const empty = { itemCount: null, datedCount: null, describedCount: null, newestPublishedAt: null, discoveredUrl: null };
  const probe = async (url: string): Promise<{ counts: ReturnType<typeof summarise>; status: number } | null> => {
    try {
      const response = await context.fetch(url, { headers: { accept: FEED_ACCEPT }, signal: AbortSignal.timeout(config.feed_timeout_ms) });
      if (!response.ok) return null;
      const parsed = tryParseFeed(await response.text());
      if (!parsed) return null;
      const counts = summarise(parsed.items);
      return counts.datedCount !== null && counts.datedCount > 0 ? { counts, status: response.status } : null;
    } catch {
      return null;
    }
  };
  try {
    const response = await context.fetch(entry.url, { headers: { accept: FEED_ACCEPT }, signal: AbortSignal.timeout(config.feed_timeout_ms) });
    if (!response.ok) {
      report({ ...empty, status: "error", httpStatus: response.status, error: `responded ${response.status}` });
      return { entry, items: [] };
    }
    const body = await response.text();
    const direct = tryParseFeed(body);
    if (direct) {
      report({ ...summarise(direct.items), status: "discovered", httpStatus: response.status, error: null, discoveredUrl: entry.url });
      return { entry, items: [] };
    }
    const candidates = feedCandidatesFrom(body, entry.url);
    for (const candidate of candidates) {
      const found = await probe(candidate);
      if (!found) continue;
      report({ ...found.counts, status: "discovered", httpStatus: found.status, error: null, discoveredUrl: candidate });
      return { entry, items: [] };
    }
    report({ ...empty, status: "no_feed_found", httpStatus: response.status, error: `no feed among ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} (head links, feed-like anchors, conventional paths)` });
  } catch (error) {
    report({ ...empty, status: "error", httpStatus: null, error: errorText(error) });
  }
  return { entry, items: [] };
}

async function loadCatalog(context: ConnectorContext, config: PublisherRssConfig): Promise<FetchedFeed[]> {
  if (!context.feeds) throw new ConnectorError("The publisher feed catalogue was not supplied to this run.");
  const entries = await context.feeds.list();
  if (entries.length === 0) throw new ConnectorError("The publisher feed catalogue is empty: no active publisher_feeds row.");
  // Never-fetched rows first, then the longest-unfetched, so a budget that
  // runs out cannot starve the same feeds every poll.
  const queue = entries
    .filter((entry) => isDue(entry, context.now))
    .sort((a, b) => (a.lastFetchedAt?.getTime() ?? 0) - (b.lastFetchedAt?.getTime() ?? 0));
  // Never past the run's own budget (after Phase 29e): a catalogue started
  // late gets what is left, the last feed it starts ends within one feed
  // timeout of the budget, and the feeds it does not reach are the
  // longest-unfetched next time, so they are first in the queue.
  const remaining = context.remainingBudgetMs?.() ?? null;
  const deadline = Date.now() + (remaining === null ? config.fetch_budget_ms : Math.min(config.fetch_budget_ms, remaining));
  const fetched: FetchedFeed[] = [];
  const workers = Array.from({ length: Math.min(config.concurrency, queue.length) }, async () => {
    while (queue.length > 0 && Date.now() < deadline) {
      const entry = queue.shift() as FeedCatalogEntry;
      fetched.push(entry.mode === "discover" ? await discoverFeedRow(entry, context, config) : await fetchFeedRow(entry, context, config));
    }
  });
  await Promise.all(workers);
  return fetched;
}

/** The catalogue as fetched for this run: once, shared by every subject the runner polls with the same clock. */
export function catalogFor(context: ConnectorContext, config: PublisherRssConfig): Promise<FetchedFeed[]> {
  const key = `${context.source.id}|${context.now.toISOString()}`;
  if (catalogCache && catalogCache.key === key) return catalogCache.pending;
  const pending = loadCatalog(context, config);
  catalogCache = { key, pending };
  return pending;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** The publisher an item came from: its link's host when that is a real host, else the catalogue row's domain. */
export function itemPublisher(item: FeedItem, entry: FeedCatalogEntry): { domain: string; from: "link" | "feed" } {
  const resolved = publisherDomainOf({ sourceUrl: null, link: item.link });
  if (resolved.domain) return { domain: resolved.domain, from: "link" };
  return { domain: normalizeDomain(entry.domain) ?? entry.domain, from: "feed" };
}

export function publisherSignal(item: FeedItem & { publishedAt: Date }, entry: FeedCatalogEntry, term: string): RawSignal | null {
  const key = item.guid ?? item.link;
  if (!key) return null;
  const headline = item.title.trim();
  const publisher = itemPublisher(item, entry);
  return {
    headline,
    story: headline,
    publisherDomain: publisher.domain,
    occurredAt: item.publishedAt,
    dedupeKey: `pub:${key}`,
    rawPayload: {
      kind: "article",
      source: PUBLISHER_RSS_SOURCE_NAME,
      outlet: item.outlet,
      title: item.title,
      link: item.link,
      guid: item.guid,
      publishedAt: item.publishedAt.toISOString(),
      publisher_domain: publisher.domain,
      publisher_domain_from: publisher.from,
      feed_id: entry.id,
      feed_url: entry.url,
      feed_section: entry.section,
      matched_term: term,
    },
  };
}

export const publisherRssConnector: DataConnector = {
  name: PUBLISHER_RSS_SOURCE_NAME,
  storyFamily: NEWS_STORY_FAMILY,
  // One catalogue read per run, shared by every subject: once it is paid for, every subject is matched.
  sharedFetch: true,

  /**
   * Events only. The catalogue is fetched once for the run; this subject's
   * feeds are the ones their topics select; an item is theirs when its
   * headline names one of their terms as whole words and the disambiguation
   * rules do not refuse it. Newest first, capped per person.
   */
  async fetchForPerson(person, identifier, context): Promise<RawSignal[]> {
    if (typeof window !== "undefined") throw new Error("The publisher feed connector is server-only.");
    const config = readPublisherRssConfig(context.config);
    const subject = readSubjectConfig(context.personConfig, identifier, person);
    const rules = readDisambiguation(context.personConfig);
    const catalog = await catalogFor(context, config);

    const signals: Array<RawSignal & { occurredAt: Date }> = [];
    const seen = new Set<string>();
    for (const { entry, items } of catalog) {
      if (entry.mode !== "feed" || !watchesFeed(subject.topics, entry.topics)) continue;
      let matched = 0;
      for (const item of items) {
        const term = matchedTerm(item.title, subject.terms);
        if (term === null) continue;
        matched += 1;
        if (hasRules(rules)) {
          const verdict = excludeReason(`${item.title} ${item.outlet ?? ""}`, rules);
          if (verdict) {
            context.exclude?.({ headline: item.title, reason: verdict.reason, term: verdict.term });
            continue;
          }
        }
        const signal = publisherSignal(item as FeedItem & { publishedAt: Date }, entry, term);
        if (!signal || !signal.dedupeKey || seen.has(signal.dedupeKey)) continue;
        seen.add(signal.dedupeKey);
        signals.push(signal);
      }
      context.feeds?.matched(entry.id, matched);
    }
    return signals.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, config.max_items_per_person);
  },
};
