/**
 * CHECK: a recorded live session's clip counts against Twitch's own clip list.
 *
 *   TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... npx tsx scripts/check-clip-counts.ts <session.json>
 *
 * The export is the one scripts/replay-live-session.ts reads, with
 * session.broadcasterId. Live mode counted each sample's window as it went,
 * two minutes behind the present for Helix to index new clips. This asks
 * Helix again, after the fact, for every clip of the broadcast (paged to the
 * end, filtered by each clip's own created_at exactly as countTwitchClips
 * does), and compares:
 *
 *   - the session total with the sum the samples recorded
 *   - every recorded window with the clips the full list puts in it
 *
 * A window that live mode counted lower than the full list is a clip Helix had
 * not indexed within the lag (or had not yet listed); higher is a clip since
 * deleted, or one counted twice. It prints the totals, the windows that
 * differ, and how often. Reads Twitch and a file; writes nothing.
 */
import { readFileSync } from "node:fs";

import { countTwitchClips, fetchTwitchToken } from "../lib/connectors/twitch";

type Row = [number, number | null, number | null, number | null, number, boolean, string, number, string | null];

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: check-clip-counts.ts <session.json>");
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set (the app credentials production uses)");
  const data = JSON.parse(readFileSync(file, "utf8")) as { session: { broadcasterId: string; startedAt: number; endedAt: number }; units?: "ms" | "s"; rows: Row[] };
  const ms = (value: number) => (data.units === "ms" ? value : value * 1000);
  const accessToken = await fetchTwitchToken({ clientId, clientSecret }, fetch);
  const auth = { clientId, accessToken };
  const broadcaster = data.session.broadcasterId;

  // The whole broadcast, then each recorded window, all with the connector's own exact counting.
  const whole = await countTwitchClips(broadcaster, new Date(ms(data.session.startedAt)), new Date(ms(data.session.endedAt) + 2 * 60_000), auth, fetch, { maxPages: 100 });
  const recordedTotal = data.rows.reduce((sum, row) => sum + row[4], 0);
  console.log(`session: live mode recorded ${recordedTotal} clips; Twitch lists ${whole.count}${whole.truncated ? " (a floor: the page cap was reached)" : ""} in ${whole.requests} requests`);

  let differing = 0;
  let under = 0;
  let over = 0;
  for (const row of data.rows) {
    if (row[2] === null || row[3] === null) continue;
    const listed = await countTwitchClips(broadcaster, new Date(ms(row[2])), new Date(ms(row[3])), auth, fetch, { maxPages: 20 });
    if (listed.count !== row[4]) {
      differing += 1;
      if (row[4] < listed.count) under += listed.count - row[4];
      else over += row[4] - listed.count;
      console.log(`  window ending ${new Date(ms(row[3])).toISOString()}: live mode ${row[4]}, Twitch now ${listed.count}`);
    }
  }
  console.log(`${differing} of ${data.rows.filter((row) => row[3] !== null).length} windows differ: ${under} clips live mode missed, ${over} it counted that Twitch no longer lists`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
