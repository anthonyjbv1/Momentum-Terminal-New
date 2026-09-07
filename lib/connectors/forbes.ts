import { createStubConnector } from "./stub";

/**
 * Forbes connector — STUB. Returns no signals until implemented.
 *
 * TODO(activation):
 *  - Data: Forbes Real-Time Billionaires list (net worth, rank). Forbes has no
 *    official public API; use the RapidAPI wrapper or the list's JSON endpoint,
 *    fetched server-side.
 *  - Env: RAPIDAPI_KEY (server only) if the RapidAPI route is used.
 *  - external_identifier: the Forbes profile slug / URI (e.g. "elon-musk").
 *  - Snapshots: net_worth_usd, rank. Signals: net worth changes over a
 *    threshold, rank moves ("climbs to #2 on the Forbes list").
 */
export const forbesConnector = createStubConnector("forbes");
