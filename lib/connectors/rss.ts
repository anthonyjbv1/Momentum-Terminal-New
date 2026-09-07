import { createStubConnector } from "./stub";

/**
 * RSS connector — STUB. Returns no signals until implemented.
 *
 * Person-scoped by design: unlike the previous platform, where RSS pulled from
 * general news outlets, every feed here is ABOUT one tracked person. The likely
 * implementation is a per-person Google News RSS feed generated for the
 * person's name.
 *
 * TODO(activation):
 *  - external_identifier: the person-specific feed URL (e.g. a Google News RSS
 *    query URL for their name) or the search term used to build it.
 *  - Parsing: RSS/Atom XML. Add an XML parser dependency when activating
 *    (e.g. fast-xml-parser); do not hand-roll it.
 *  - Signals: one per new item (headline = item title, dedupeKey = guid or
 *    link, occurredAt = pubDate, rawPayload = the parsed item).
 *  - Lesson from the previous platform: RSS was broken there because the
 *    browser fetched feeds through corsproxy.io and hit CORS / proxy failures.
 *    Here the fetch happens inside the ingestion runner (a Next.js route
 *    handler), i.e. server-to-server, so browser CORS never applies. Keep it
 *    that way — never fetch feeds from client code.
 */
export const rssConnector = createStubConnector("rss");
