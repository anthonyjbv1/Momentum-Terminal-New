/**
 * REPLAY: one recorded live session through the live runner, with and without
 * the Phase 31 quality rules.
 *
 *   npx tsx scripts/replay-live-session.ts <session.json> [--quality] [--phase 0|1] [--until <iso>]
 *
 * The export holds the session and its samples as live_samples stored them:
 *
 *   { "session": { "streamId", "startedAt", "endedAt" }, "units": "ms",
 *     "rows": [[sampledAt, viewers, clipsFrom, clipsTo, clips, truncated, status, signals, category], ...] }
 *
 * Times are epoch milliseconds when "units" is "ms", else seconds. Export them
 * to the millisecond: the Phase 16 rule compares with the newest sample at
 * least ten minutes old, and a sample 9.998 minutes old is not one.
 *
 * It drives runLiveMode itself (the real runner, rules and store contract, an
 * in-memory store) with a connector that answers from the recording: /streams
 * returns the viewer count the session held at that moment (the last recorded
 * reading at or before it, which is what Helix was serving), /clips returns
 * the clips of the recorded windows that end inside the asked window. The
 * runner is fired at every recorded sample time and decides for itself when a
 * sample is due, so the quality rules' four-minute cadence samples every other
 * recording; --phase 1 starts one recording later, the other half.
 *
 * Without --quality the replay should reproduce what production stored; that
 * is the check that the harness is faithful. It prints every moment and what
 * each would have done to the score: the prescored impact (base impact × tier
 * multiplier × confidence), summed per tick as the Signals force sums them,
 * and that move decayed by Gravity to the session's end and to --until.
 * Reads a file, calls nothing, changes nothing.
 */
import { readFileSync } from "node:fs";

import { makePerson, makeSource } from "../lib/__tests__/fixtures";
import type { DataConnector, LiveStream } from "../lib/connectors/types";
import { buildRegistry } from "../lib/connectors/registry";
import { DEFAULT_ENGINE_CONFIG } from "../lib/engine/config";
import { LIVE_QUALITY_DEFAULTS } from "../lib/ingest/live/rules";
import { runLiveMode } from "../lib/ingest/live/runner";
import { createMemoryLiveStore } from "../lib/ingest/live/store";
import type { Json } from "../types/database";

type Row = [number, number | null, number | null, number | null, number, boolean, string, number, string | null];
interface Export {
  session: { streamId: string; startedAt: number; endedAt: number };
  units?: "ms" | "s";
  rows: Row[];
  /** The source's live block; defaults to production's twitch row of 2026-09-26. */
  liveConfig?: Record<string, Json>;
}

const PRODUCTION_LIVE_CONFIG: Record<string, Json> = {
  enabled: true,
  min_viewers: 500,
  drop_fraction: null,
  burst_multiple: 3,
  surge_fraction: 0.2,
  warmup_minutes: 20,
  burst_min_clips: 5,
  cooldown_minutes: 30,
  clip_window_minutes: 10,
  delta_window_minutes: 10,
  floor_clips_per_hour: 6,
  end_after_missed_checks: 2,
  sample_interval_minutes: 2,
};

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || index + 1 >= process.argv.length ? null : process.argv[index + 1];
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("usage: replay-live-session.ts <session.json> [--quality] [--phase 0|1] [--until <iso>]");
  const data = JSON.parse(readFileSync(file, "utf8")) as Export;
  const quality = process.argv.includes("--quality");
  const phase = Number(arg("phase") ?? 0);
  const until = arg("until") ? new Date(arg("until") as string) : null;
  const ms = (value: number) => (data.units === "ms" ? value : value * 1000);
  const startedAt = new Date(ms(data.session.startedAt));
  const endedAt = new Date(ms(data.session.endedAt));
  const rows = [...data.rows].sort((a, b) => a[0] - b[0]);

  const person = makePerson({ id: "p-replay", slug: "replay", display_name: "The streamer" });
  const source = makeSource({ id: "src-twitch", name: "twitch", display_name: "Twitch", is_active: true, tier: 2, config: { live: data.liveConfig ?? PRODUCTION_LIVE_CONFIG } as Json });
  const store = createMemoryLiveStore({ sources: [source], mappings: { "src-twitch": [{ person, externalIdentifier: "streamer" }] } });

  const viewersAt = (now: Date): number | null => {
    let value: number | null = null;
    for (const row of rows) if (ms(row[0]) <= now.getTime()) value = row[1];
    return value;
  };
  const connector: DataConnector = {
    name: "twitch",
    async fetchForPerson() {
      return [];
    },
    live: {
      async detect(identifiers, context) {
        const now = context.now;
        const live = now.getTime() <= endedAt.getTime();
        const stream: LiveStream | null = live ? { id: data.session.streamId, broadcasterId: "b-replay", channel: "streamer", title: "replay", category: rows[0]?.[8] ?? null, viewerCount: viewersAt(now), startedAt } : null;
        return identifiers.map((externalIdentifier) => ({ externalIdentifier, stream }));
      },
      async countClips(_broadcasterId, from, to) {
        // A recorded window counts when it ENDS inside the asked window: at the same cadence the windows are the same ones.
        const count = rows.filter((row) => row[3] !== null && ms(row[3]) > from.getTime() && ms(row[3]) <= to.getTime()).reduce((sum, row) => sum + row[4], 0);
        return { count, truncated: false, requests: 1 };
      },
      liveSignal(p, live, now) {
        return { headline: `${p.display_name} went live.`, occurredAt: live.startedAt ?? now, dedupeKey: `twitch:stream:${live.id}`, rawPayload: { kind: "stream", stream_id: live.id } };
      },
    },
  };
  const registry = buildRegistry([connector]);

  const fires = rows.slice(phase).map((row) => new Date(ms(row[0])));
  // Two checks past the end close the session, as production's did.
  fires.push(new Date(endedAt.getTime() + 60_000), new Date(endedAt.getTime() + 120_000));
  for (const now of fires) await runLiveMode({ store, registry, now, log: () => undefined, quality: quality ? LIVE_QUALITY_DEFAULTS : undefined });

  const cfg = DEFAULT_ENGINE_CONFIG;
  const tierMultiplier = cfg.signals.tierMultipliers[2] ?? cfg.signals.defaultTierMultiplier;
  const moments = store.ingest.signals
    .filter((signal) => (signal.rawPayload as Record<string, Json>).kind === "live_moment")
    .map((signal) => {
      const payload = signal.rawPayload as Record<string, Json>;
      const confidence = Number(payload.confidence);
      return { at: signal.occurredAt, moment: String(payload.moment), confidence, magnitude: Number(payload.magnitude), impact: cfg.signals.baseImpact * tierMultiplier * confidence * Number(payload.direction), headline: signal.headline, rationale: String(payload.rationale) };
    });

  const minutesIn = (at: Date) => Math.round((at.getTime() - startedAt.getTime()) / 60_000);
  const sampled = store.samples.length;
  console.log(`${quality ? "QUALITY RULES" : "PHASE 16 RULES (production)"}, phase ${phase}: ${sampled} samples taken, ${moments.length} moments`);
  for (const m of moments) console.log(`  min ${String(minutesIn(m.at)).padStart(3)}  ${m.moment.padEnd(14)} confidence ${m.confidence.toFixed(3)}  magnitude ${m.magnitude}  impact ${m.impact.toFixed(4)}\n      ${m.headline}\n      ${m.rationale}`);

  // Per tick, as the Signals force sums them: kept impacts over count^volumeExponent, capped.
  const byTick = new Map<number, number[]>();
  for (const m of moments) byTick.set(m.at.getTime(), [...(byTick.get(m.at.getTime()) ?? []), m.impact]);
  const decayTo = (at: Date, to: Date) => Math.exp(-cfg.gravity.lambdaPerHour * Math.max(0, (to.getTime() - at.getTime()) / 3_600_000));
  let applied = 0;
  let atEnd = 0;
  let atUntil = 0;
  for (const [time, impacts] of byTick) {
    const kept = impacts.slice(0, cfg.signals.maxPerSourcePerTick);
    const force = Math.max(-cfg.signals.maxAbsImpactPerTick, Math.min(cfg.signals.maxAbsImpactPerTick, kept.reduce((s, v) => s + v, 0) / (kept.length > 1 ? Math.pow(kept.length, cfg.signals.volumeExponent) : 1)));
    applied += force;
    atEnd += force * decayTo(new Date(time), endedAt);
    if (until) atUntil += force * decayTo(new Date(time), until);
  }
  console.log(`  applied to the score, summed: ${applied.toFixed(3)}; left of it at the session's end after Gravity: ${atEnd.toFixed(3)}${until ? `; at ${until.toISOString()}: ${atUntil.toFixed(3)}` : ""}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
