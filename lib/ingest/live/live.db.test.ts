import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

/**
 * PHASE 16 on real Postgres: the live ledger is service-role only, a run may
 * be opened by live mode, Twitch declares live mode and its two session
 * metrics, and a live moment is neither volume nor a metric to the privacy
 * trigger.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe("the live ledger", () => {
  it("keeps live_sessions and live_samples for the service role alone: RLS on, no policy, nothing granted to anon or authenticated", async () => {
    for (const table of ["live_sessions", "live_samples"]) {
      const [row] = await database.rows<{ rls: boolean; policies: string }>(
        "select c.relrowsecurity as rls, (select count(*) from pg_policy p where p.polrelid = c.oid)::text as policies from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1",
        [table],
      );
      expect(row.rls, `${table} rls`).toBe(true);
      expect(row.policies, `${table} policies`).toBe("0");
      for (const role of ["anon", "authenticated"]) {
        const [{ ok }] = await database.rows<{ ok: boolean }>("select has_table_privilege($1, $2, 'select') as ok", [role, `public.${table}`]);
        expect(ok, `${role} may read ${table}`).toBe(false);
      }
    }
  });

  it("holds one session per (source, stream) and cascades its samples", async () => {
    const [{ id: personId }] = await database.rows<{ id: string }>("select id from public.people where slug = 'kai-cenat'");
    const [{ id: sourceId }] = await database.rows<{ id: string }>("select id from public.data_sources where name = 'twitch'");
    const [{ id }] = await database.rows<{ id: string }>(
      "insert into public.live_sessions (person_id, data_source_id, stream_id, broadcaster_id, channel, started_at, first_seen_at, last_seen_at) values ($1, $2, 's-1', 'b-1', 'kaicenat', now(), now(), now()) returning id",
      [personId, sourceId],
    );
    await expect(
      database.rows("insert into public.live_sessions (person_id, data_source_id, stream_id, broadcaster_id, channel, started_at, first_seen_at, last_seen_at) values ($1, $2, 's-1', 'b-1', 'kaicenat', now(), now(), now())", [personId, sourceId]),
    ).rejects.toThrow(/live_sessions_stream_unique/);
    await database.rows("insert into public.live_samples (session_id, sampled_at, viewer_count, status) values ($1, now(), 40327, 'ok')", [id]);
    await expect(database.rows("insert into public.live_samples (session_id, sampled_at, status) values ($1, now(), 'pending')", [id])).rejects.toThrow(/live_samples_status_check/);
    await database.rows("delete from public.live_sessions where id = $1", [id]);
    const [{ n }] = await database.rows<{ n: string }>("select count(*)::text as n from public.live_samples where session_id = $1", [id]);
    expect(n).toBe("0");
  });

  it("lets live mode open a run, and nothing else", async () => {
    const [{ id }] = await database.rows<{ id: string }>("insert into public.ingest_runs (started_at, trigger) values (now(), 'live') returning id");
    expect(id).toBeTruthy();
    await expect(database.rows("insert into public.ingest_runs (started_at, trigger) values (now(), 'webhook')")).rejects.toThrow(/ingest_runs_trigger_check/);
    await database.rows("delete from public.ingest_runs where id = $1", [id]);
  });
});

describe("Twitch declares live mode", () => {
  it("with the sample interval, the thresholds, and the two session metrics on a month of sessions", async () => {
    const [{ config }] = await database.rows<{ config: { live: Record<string, unknown>; metrics: Record<string, Record<string, unknown>> } }>("select config from public.data_sources where name = 'twitch'");
    expect(config.live).toMatchObject({ enabled: true, sample_interval_minutes: 2, warmup_minutes: 20, delta_window_minutes: 10, surge_fraction: 0.2, drop_fraction: null, min_viewers: 500, cooldown_minutes: 30, clip_window_minutes: 10, burst_multiple: 3, burst_min_clips: 5, floor_clips_per_hour: 6, end_after_missed_checks: 2 });
    expect(config.metrics.session_peak_viewers).toEqual({ label: "Twitch peak live audience per stream", delta: "level", polarity: 1, baseline_window_hours: 720, min_samples: 5, sd_floor: 50, scale: 0.8 });
    expect(config.metrics.clips_per_stream_hour).toEqual({ label: "Twitch clips per stream hour", delta: "level", polarity: 1, baseline_window_hours: 720, min_samples: 5, sd_floor: 2, scale: 1 });
    // The Phase 10 metrics are untouched.
    expect(Object.keys(config.metrics).sort()).toEqual(["clips_per_stream_hour", "follower_count", "session_peak_viewers", "stream_days_7d", "stream_hours_7d"]);
    // No other source declares live mode.
    const others = await database.rows<{ name: string }>("select name from public.data_sources where config ? 'live' and name <> 'twitch'");
    expect(others).toEqual([]);
  });
});

describe("a live moment", () => {
  it("is stored with its declared direction and confidence (the metric privacy trigger leaves it alone), and is not volume", async () => {
    const [{ id: personId }] = await database.rows<{ id: string }>("select id from public.people where slug = 'kai-cenat'");
    const [{ id: sourceId }] = await database.rows<{ id: string }>("select id from public.data_sources where name = 'twitch'");
    // Tracked since three days ago at noon, so there are complete days to count.
    await database.rows("update public.person_data_sources set created_at = (now() at time zone 'utc')::date - 3 + interval '12 hours' where person_id = $1", [personId]);
    const insert = (kind: string, key: string, hoursAgo: number, payload: Record<string, unknown> = {}) =>
      database.rows("insert into public.signals (person_id, data_source_id, headline, raw_payload, dedupe_key, occurred_at) values ($1, $2, $3, $4::jsonb, $5, now() - ($6 || ' hours')::interval)", [
        personId,
        sourceId,
        `${kind} ${key}`,
        JSON.stringify({ kind, ...payload }),
        `p16-${key}`,
        String(hoursAgo),
      ]);
    const volume = async () => {
      const [row] = await database.rows<{ current_24h: string; daily_total: number }>(
        "select current_24h, (select coalesce(sum(d), 0) from unnest(daily) as d)::int as daily_total from public.person_signal_volume(14) where person_id = $1",
        [personId],
      );
      return { current24h: Number(row.current_24h), dailyTotal: Number(row.daily_total) };
    };

    // Two live moments, a day and a half apart: neither is volume, at any
    // hour. (This used to pin the daily buckets to {0,1} from an offset of
    // "24 + 1 hours ago" called yesterday — which it is in the evening and
    // is not after midnight UTC, so the assertion failed for the first hours
    // of every day. What the test means to claim is that a live moment never
    // counts as volume, and that is true whatever the clock says.)
    await insert("live_moment", "m1", 36, { moment: "audience_surge", direction: 1, confidence: 0.5, magnitude: 0.25, from: 48200, to: 60250 });
    await insert("live_moment", "m2", 1, { moment: "clip_burst", direction: 1, confidence: 0.7, magnitude: 3.4 });
    expect(await volume()).toEqual({ current24h: 0, dailyTotal: 0 });

    // The same two moments beside two articles: only the articles count.
    await insert("article", "a1", 36);
    await insert("article", "a2", 1);
    const [{ in_complete_days: inCompleteDays }] = await database.rows<{ in_complete_days: number }>(
      "select count(*)::int as in_complete_days from public.signals where dedupe_key like 'p16-a%' and (occurred_at at time zone 'utc')::date < (now() at time zone 'utc')::date",
    );
    expect(inCompleteDays).toBeGreaterThanOrEqual(1); // the day-and-a-half-old one, always
    // The hour-old article is inside the trailing day; the older one is not.
    expect(await volume()).toEqual({ current24h: 1, dailyTotal: inCompleteDays });
    const [stored] = await database.rows<{ raw_payload: Record<string, unknown> }>("select raw_payload from public.signals where dedupe_key = 'p16-m1'");
    expect(stored.raw_payload).toMatchObject({ kind: "live_moment", direction: 1, confidence: 0.5, from: 48200 });
    await database.rows("delete from public.signals where dedupe_key like 'p16-%'");
  });
});
