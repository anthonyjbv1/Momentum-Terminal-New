import { createStubConnector } from "./stub";

/**
 * Billboard connector — STUB. Returns no signals until implemented.
 *
 * TODO(activation):
 *  - Data: weekly Billboard charts (Hot 100, Billboard 200, Artist 100) via a
 *    RapidAPI chart provider; Billboard has no official public API.
 *  - Env: RAPIDAPI_KEY (server only).
 *  - external_identifier: the artist name as it appears on the charts.
 *  - Snapshots: best_hot100_position, artist100_position. Signals: new chart
 *    entries, #1 debuts, position jumps. Poll interval is weekly (10080 min).
 */
export const billboardConnector = createStubConnector("billboard");
