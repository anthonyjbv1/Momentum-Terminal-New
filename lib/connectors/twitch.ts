import { createStubConnector } from "./stub";

/**
 * Twitch connector — STUB. Returns no signals until implemented.
 *
 * TODO(activation):
 *  - API: Twitch Helix. Get an app access token with the client-credentials
 *    flow, then GET /helix/users (profile), /helix/channels/followers (follower
 *    total) and /helix/streams (live status, concurrent viewers).
 *  - Env: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET (server only).
 *  - external_identifier: the Twitch login name (e.g. "kaicenat") or user id.
 *  - Snapshots: follower_count, peak_viewers. Signals: follower milestones,
 *    "goes live", record concurrent viewers.
 */
export const twitchConnector = createStubConnector("twitch");
