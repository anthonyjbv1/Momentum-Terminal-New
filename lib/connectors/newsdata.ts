import { createStubConnector } from "./stub";

/**
 * NewsData.io connector — STUB. Returns no signals until implemented.
 *
 * TODO(activation):
 *  - API: NewsData.io /api/1/latest?q=<person name>&language=en.
 *  - Env: NEWSDATA_KEY (server only).
 *  - external_identifier: the search query for the person (usually their name
 *    in quotes).
 *  - Signals: one per new article (headline = article title, dedupeKey =
 *    article_id / link, occurredAt = pubDate). No snapshots needed.
 */
export const newsdataConnector = createStubConnector("newsdata");
