import { createStubConnector } from "./stub";

/**
 * Finnhub connector — STUB. Returns no signals until implemented.
 *
 * TODO(activation):
 *  - API: Finnhub REST. GET /quote (price, daily change) and /company-news for
 *    the public company a person is tied to (Musk -> TSLA, Huang -> NVDA).
 *  - Env: FINNHUB_API_KEY (server only).
 *  - external_identifier: the ticker symbol.
 *  - Snapshots: share_price, market_cap. Signals: daily moves beyond a
 *    threshold, notable company headlines. Poll interval is 5 min, so keep the
 *    thresholds meaningful to avoid noise.
 */
export const finnhubConnector = createStubConnector("finnhub");
