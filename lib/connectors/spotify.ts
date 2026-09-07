import { createStubConnector } from "./stub";

/**
 * Spotify connector — STUB. Returns no signals until implemented.
 *
 * TODO(activation):
 *  - API: Spotify Web API. Client-credentials token, then GET /v1/artists/{id}
 *    (followers.total, popularity) and /v1/artists/{id}/albums for releases.
 *  - Env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET (server only).
 *  - external_identifier: the Spotify artist ID.
 *  - Snapshots: follower_count, popularity. Signals: follower milestones,
 *    popularity moves, new album / single releases.
 */
export const spotifyConnector = createStubConnector("spotify");
