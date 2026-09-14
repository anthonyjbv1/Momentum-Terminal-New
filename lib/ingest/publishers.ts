/**
 * The tiered publisher allowlist, resolved per item.
 *
 * A data source carries one credibility tier for the whole connector. That
 * is right for an API (every Spotify reading is Spotify's) and wrong for a
 * news search feed, where one poll returns a paper of record, a music blog
 * and a scraped page side by side. For sources that name a publisher per
 * item, the runner resolves the tier from the publisher's DOMAIN through the
 * publisher_domains table:
 *
 *   known    a row with status allowed: the item takes the row's tier
 *   unknown  no row: the item is still accepted, at UNKNOWN_DOMAIN_TIER, the
 *            floor, so an outlet nobody thought to list contributes faintly
 *            rather than not at all (discovery is preserved and the log shows
 *            what keeps appearing)
 *   blocked  a row with status blocked: the item is dropped before scoring,
 *            and the drop is logged
 *
 * The table is configuration (a row, no deploy). Matching normalises the
 * domain (lower case, no www., no trailing dot) and walks up through the
 * parent domains, so music.example.com resolves through example.com unless a
 * more specific row exists. Nothing here names a source or a domain.
 */

/** The floor: what an unlisted publisher's items resolve to. Tier 5 carries the weakest multiplier in the Signals force. */
export const UNKNOWN_DOMAIN_TIER = 5;

export type PublisherStatus = "allowed" | "blocked";

/** One row of publisher_domains. */
export interface PublisherDomainRow {
  domain: string;
  status: PublisherStatus;
  tier: number | null;
}

export type PublisherResolution =
  | { status: "blocked"; domain: string; matched: string }
  | { status: "known"; domain: string; matched: string; tier: number }
  | { status: "unknown"; domain: string | null; tier: number };

export interface PublisherPolicy {
  /** How many rows the policy carries (0 = every domain is unknown). */
  readonly size: number;
  resolve(domain: string | null | undefined): PublisherResolution;
}

/**
 * Hosts that wrap, redirect to or aggregate publisher pages and are never the
 * publisher themselves. A link on one of these says nothing about who wrote
 * the story; the feed's source element does.
 */
const WRAPPER_HOSTS = ["news.google.com", "google.com", "feedproxy.google.com", "feeds.feedburner.com", "feedburner.com", "t.co", "bit.ly"];

/**
 * A domain in canonical form: lower case, no scheme, path, port or userinfo,
 * no leading "www." (or "www2."), no trailing dot. Null when the input is not
 * a domain at all (empty, no dot, illegal characters).
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value) || value.startsWith("//")) {
    try {
      value = new URL(value.startsWith("//") ? `https:${value}` : value).hostname;
    } catch {
      return null;
    }
  } else {
    value = value.split(/[/?#]/)[0].replace(/^[^@/]*@/, "").replace(/:\d+$/, "");
  }
  value = value.replace(/\.+$/, "").replace(/^www\d*\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return null;
  return value;
}

export function isWrapperHost(domain: string): boolean {
  return WRAPPER_HOSTS.some((host) => domain === host || domain.endsWith(`.${host}`));
}

/**
 * The publisher's domain for a feed item: the feed's source URL when it names
 * one (Google News does: `<source url="https://www.billboard.com">`), else
 * the item link's host, unless that host is a wrapper (a Google News redirect
 * says nothing about the publisher). Null when neither tells.
 */
export function publisherDomainOf(item: { sourceUrl: string | null; link: string | null }): { domain: string | null; from: "source" | "link" | null } {
  const fromSource = normalizeDomain(item.sourceUrl);
  if (fromSource && !isWrapperHost(fromSource)) return { domain: fromSource, from: "source" };
  const fromLink = normalizeDomain(item.link);
  if (fromLink && !isWrapperHost(fromLink)) return { domain: fromLink, from: "link" };
  return { domain: null, from: null };
}

/** The domain and each parent that still has two labels, most specific first: music.example.com → [music.example.com, example.com]. */
export function domainCandidates(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let start = 0; start <= labels.length - 2; start += 1) out.push(labels.slice(start).join("."));
  return out;
}

export function buildPublisherPolicy(rows: PublisherDomainRow[]): PublisherPolicy {
  const table = new Map<string, { status: PublisherStatus; tier: number | null }>();
  for (const row of rows) {
    const domain = normalizeDomain(row.domain);
    if (!domain) continue;
    table.set(domain, { status: row.status, tier: row.tier });
  }
  return {
    size: table.size,
    resolve(input) {
      const domain = normalizeDomain(input);
      if (!domain) return { status: "unknown", domain: null, tier: UNKNOWN_DOMAIN_TIER };
      for (const candidate of domainCandidates(domain)) {
        const entry = table.get(candidate);
        if (!entry) continue;
        if (entry.status === "blocked") return { status: "blocked", domain, matched: candidate };
        if (entry.tier !== null) return { status: "known", domain, matched: candidate, tier: entry.tier };
      }
      return { status: "unknown", domain, tier: UNKNOWN_DOMAIN_TIER };
    },
  };
}

/** No rows: every domain is unknown, nothing is blocked. */
export const EMPTY_PUBLISHER_POLICY: PublisherPolicy = buildPublisherPolicy([]);
