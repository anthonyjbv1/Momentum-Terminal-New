import { createStubConnector } from "./stub";

/**
 * API-Sports connector — STUB. Returns no signals until implemented.
 *
 * TODO(activation):
 *  - API: API-Sports (api-sports.io), e.g. the American Football API for NFL
 *    players: /players/statistics, /games for results.
 *  - Env: APISPORTS_KEY (server only).
 *  - external_identifier: the API-Sports player id.
 *  - Snapshots: season totals (passing_yards, touchdowns...). Signals: game
 *    results, statistical milestones, awards.
 */
export const apisportsConnector = createStubConnector("apisports");
