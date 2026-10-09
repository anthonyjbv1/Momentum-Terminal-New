import { allegationHoldsPayload } from "@/lib/engine/sentiment/allegations";
import type { EngineConfig } from "@/lib/engine/config";
import type { MoodWindowHistory } from "@/lib/engine/forces/market-mood";
import { isFreeSignal } from "@/lib/engine/selection";
import { LIVE_MOMENT_KIND } from "@/lib/engine/sentiment/prescored";
import { dayStateFromSignals, type NewsVolumeContext, type WindowStory } from "@/lib/engine/news-volume";
import { readSignalVolumeRow, type PersonSignalVolume, type PersonSignalVolumeRow } from "@/lib/engine/signal-volume";
import { VOIDED_COLUMN_PATH } from "@/lib/signals/voided";
import type {
  EngineSignal,
  RecentStory,
  SignalActivity,
  TickContext,
  TickPersistence,
  TickPersistenceResult,
  TradeEvent,
  EngineParameters,
} from "@/lib/engine/types";
import type { InversePair, Person, TypedSupabaseClient } from "@/types";
import type { Json } from "@/types/database";

import { storyRecordsPayload, type StoryClusterRecord } from "./story-records";

/**
 * Persistence boundary for the Engine. The Supabase implementation runs in
 * production with the service-role client (reads several tables, persists
 * through the atomic apply_engine_tick RPC); the in-memory implementation
 * makes the tick testable without a database.
 */
export interface EngineStore {
  loadTickContext(now: Date, config: EngineConfig): Promise<TickContext>;
  applyTick(tick: TickPersistence): Promise<TickPersistenceResult>;
}

function sumBy<T>(rows: T[], key: (row: T) => string, value: (row: T) => number): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(key(row), (totals.get(key(row)) ?? 0) + value(row));
  return totals;
}

/**
 * When each person's EVENT signals were last processed, from the processed
 * rows in the activity window. Metric, baseline and prescored live-moment
 * signals are excluded: they are processed on every tick for free and would
 * make everyone look recently served. Expired event signals (processed at
 * zero cost) do count, which is a mild imprecision after an outage and
 * nothing in steady state.
 */
export function lastServedByPerson(rows: Array<{ person_id: string; processed_at: string | null; kind: string | null }>): Map<string, Date> {
  const latest = new Map<string, Date>();
  for (const row of rows) {
    if (!row.processed_at || row.kind === "metric" || row.kind === "baseline" || row.kind === LIVE_MOMENT_KIND) continue;
    const at = new Date(row.processed_at);
    const current = latest.get(row.person_id);
    if (!current || at > current) latest.set(row.person_id, at);
  }
  return latest;
}

export function aggregateSignalActivity(rows: Array<{ person_id: string; sentiment_confidence: number | null }>): Map<string, SignalActivity> {
  const counts = new Map<string, { count: number; confidenceSum: number }>();
  for (const row of rows) {
    const entry = counts.get(row.person_id) ?? { count: 0, confidenceSum: 0 };
    entry.count += 1;
    entry.confidenceSum += row.sentiment_confidence ?? 0;
    counts.set(row.person_id, entry);
  }
  const activity = new Map<string, SignalActivity>();
  for (const [personId, { count, confidenceSum }] of counts) {
    activity.set(personId, { personId, count, averageConfidence: count > 0 ? confidenceSum / count : 0 });
  }
  return activity;
}

/**
 * Market Mood's window, read back from the Signals force's audit trail
 * (Phase 19+). A READING is a tick that moved somebody; ticks the force
 * never wrote a row for are not readings and must not dilute the mean.
 * Rows belonging to people who have since left the board are dropped: the
 * mean is spread across the people on it now.
 */
/** Recently scored event signals grouped by person, for story confirmation (Phase 31). Only articles that moved something. */
export function groupRecentStories(rows: Array<{ id: string; person_id: string; headline: string; impact_score: number | string | null; occurred_at: string }>, activeIds: Set<string>): Map<string, RecentStory[]> {
  const out = new Map<string, RecentStory[]>();
  for (const row of rows) {
    if (!activeIds.has(row.person_id)) continue;
    const impact = Number(row.impact_score);
    if (!Number.isFinite(impact) || impact === 0) continue;
    const list = out.get(row.person_id) ?? [];
    list.push({ id: row.id, personId: row.person_id, headline: row.headline, occurredAt: new Date(row.occurred_at), impact });
    out.set(row.person_id, list);
  }
  return out;
}

/**
 * The news-volume tune's inputs per person (variant C), as the store reads
 * them back: the signed article stories of the trailing window and the
 * day's state from the processed news-volume signals of the UTC day.
 */
export function groupNewsVolumeContext(
  stories: Array<{ person_id: string; impact_score: number | string | null; sentiment_confidence: number | string | null; occurred_at: string }>,
  firings: Array<{ person_id: string; impact_score: number | string | null; occurred_at: string; sigma: number | string | null }>,
  activeIds: Set<string>,
  now: Date,
): Map<string, NewsVolumeContext> {
  const storiesByPerson = new Map<string, WindowStory[]>();
  for (const row of stories) {
    if (!activeIds.has(row.person_id)) continue;
    const impact = Number(row.impact_score);
    if (!Number.isFinite(impact) || impact === 0) continue;
    const list = storiesByPerson.get(row.person_id) ?? [];
    list.push({ occurredAt: new Date(row.occurred_at), impact, confidence: Number(row.sentiment_confidence ?? 0) || 0 });
    storiesByPerson.set(row.person_id, list);
  }
  const firingsByPerson = new Map<string, Array<{ sigma: number | null; impact: number; occurredAt: Date }>>();
  for (const row of firings) {
    if (!activeIds.has(row.person_id)) continue;
    const list = firingsByPerson.get(row.person_id) ?? [];
    const sigma = row.sigma === null ? null : Number(row.sigma);
    list.push({ sigma: sigma !== null && Number.isFinite(sigma) ? sigma : null, impact: Number(row.impact_score) || 0, occurredAt: new Date(row.occurred_at) });
    firingsByPerson.set(row.person_id, list);
  }
  const out = new Map<string, NewsVolumeContext>();
  for (const id of new Set([...storiesByPerson.keys(), ...firingsByPerson.keys()])) {
    out.set(id, { stories: (storiesByPerson.get(id) ?? []).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()), today: dayStateFromSignals(firingsByPerson.get(id) ?? [], now) });
  }
  return out;
}

export function readMoodWindowHistory(
  rows: Array<{ person_id: string; impact: number | string | null; tick_number: number | string }>,
  activeIds: Set<string>,
): MoodWindowHistory {
  const totalByPerson = new Map<string, number>();
  const readingTicks = new Set<string>();
  let totalImpact = 0;
  for (const row of rows) {
    if (!activeIds.has(row.person_id)) continue;
    const impact = Number(row.impact);
    if (!Number.isFinite(impact) || impact === 0) continue;
    totalImpact += impact;
    totalByPerson.set(row.person_id, (totalByPerson.get(row.person_id) ?? 0) + impact);
    readingTicks.add(String(row.tick_number));
  }
  return { totalImpact, totalByPerson, readings: readingTicks.size };
}

// ---------------------------------------------------------------------------
// Supabase implementation
// ---------------------------------------------------------------------------

export function createSupabaseEngineStore(client: TypedSupabaseClient): EngineStore {
  return {
    async loadTickContext(now, config) {
      const depthSince = new Date(now.getTime() - config.spread.depthWindowHours * 3600 * 1000).toISOString();
      const tradesSince = new Date(now.getTime() - config.tradingActivity.baselineHours * 3600 * 1000).toISOString();
      // Market Mood's trailing window (Phase 19+): the Signals force's own
      // audit trail over the last windowMinutes. Only the rows the force
      // actually wrote exist, so a tick that moved nobody is simply absent
      // and is not counted as a reading.
      const moodSince = new Date(now.getTime() - config.marketMood.windowMinutes * 60 * 1000).toISOString();

      const [people, signals, positions, activity, trades, pairs, lastTick, volume, moodEvents] = await Promise.all([
        client.from("people").select("*").eq("is_active", true).order("slug"),
        client
          .from("signals")
          .select("id, person_id, headline, raw_payload, occurred_at, created_at, tier, source:data_sources!inner(name, tier)")
          .eq("processed", false)
          // A voided signal (a false input the operator struck) is never scored.
          .is(VOIDED_COLUMN_PATH, null)
          // Newest first, then id: the ceiling's window must hold the signals
          // freshness weights highest, and a batch stamped with one timestamp
          // must be cut the same way every time.
          .order("occurred_at", { ascending: false })
          .order("id")
          .limit(config.tick.loadCeiling),
        client.from("positions").select("person_id, amount_cents").eq("is_open", true),
        // ...and no longer counts toward anyone's depth.
        client.from("signals").select("person_id, sentiment_confidence, processed_at, kind:raw_payload->>kind").eq("processed", true).is(VOIDED_COLUMN_PATH, null).gte("processed_at", depthSince),
        client.from("trade_events").select("person_id, side, amount_cents, created_at").gte("created_at", tradesSince),
        client.from("inverse_pairs").select("*"),
        client.from("engine_ticks").select("tick_number").order("tick_number", { ascending: false }).limit(1).maybeSingle(),
        // Each person's event-signal volume, for the per-person weight (Phase 15).
        client.rpc("person_signal_volume", { p_days: config.signals.volume.windowDays }),
        client.from("score_events").select("person_id, impact, tick_number").eq("force", "signals").gte("created_at", moodSince),
      ]);

      for (const [label, result] of Object.entries({ people, signals, positions, activity, trades, pairs, lastTick, volume, moodEvents })) {
        if (result.error) throw new Error(`Engine failed to load ${label}: ${result.error.message}`);
      }

      const activeIds = new Set((people.data ?? []).map((p) => p.id));

      // The backlog: every unprocessed signal of an active person, not just
      // the ceiling's worth. A count, so the tick can report what it left.
      const backlogCount = await client
        .from("signals")
        .select("id", { count: "exact", head: true })
        .eq("processed", false)
        .in("person_id", [...activeIds]);
      if (backlogCount.error) throw new Error(`Engine failed to load backlog: ${backlogCount.error.message}`);

      // The stories already scored inside the story window (Phase 31), read
      // only while the quality rules are on: off, the tick pays nothing for it.
      let recentStoriesByPerson: Map<string, RecentStory[]> | undefined;
      if (config.signalQuality.enabled) {
        const storiesSince = new Date(now.getTime() - config.signalQuality.storyWindowHours * 3600 * 1000).toISOString();
        const recent = await client
          .from("signals")
          .select("id, person_id, headline, impact_score, occurred_at")
          .eq("processed", true)
          .eq("raw_payload->>kind", "article")
          .neq("impact_score", 0)
          .gte("occurred_at", storiesSince)
          .in("person_id", [...activeIds])
          .order("occurred_at", { ascending: true })
          .order("id")
          .limit(2_000);
        if (recent.error) throw new Error(`Engine failed to load recent stories: ${recent.error.message}`);
        recentStoriesByPerson = groupRecentStories(recent.data ?? [], activeIds);
      }

      // The news-volume tune's inputs (variant C), read only while the tune is
      // on: the signed articles of the trailing window and today's processed
      // news-volume firings (the day's peak sigma and what it was given).
      // The company-news tune (2026-10-09) reads the same stories with its
      // own day state, so the stories are read once for whichever is on.
      let newsVolumeByPerson: Map<string, NewsVolumeContext> | undefined;
      let companyNewsVolumeByPerson: Map<string, NewsVolumeContext> | undefined;
      const tunes = [config.newsVolume, config.companyNewsVolume].filter((tune) => tune.enabled);
      if (tunes.length > 0) {
        const windowHours = Math.max(...tunes.map((tune) => tune.windowHours));
        const windowSince = new Date(now.getTime() - windowHours * 3600 * 1000).toISOString();
        const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
        const firingsOf = (metric: string) =>
          client
            .from("signals")
            .select("person_id, impact_score, occurred_at, sigma:raw_payload->sigma")
            .eq("processed", true)
            .is(VOIDED_COLUMN_PATH, null)
            .eq("raw_payload->>metric", metric)
            .gte("occurred_at", dayStart)
            .in("person_id", [...activeIds])
            .limit(2_000);
        const [windowStories, todaysFirings, todaysCompanyFirings] = await Promise.all([
          client
            .from("signals")
            .select("person_id, impact_score, sentiment_confidence, occurred_at")
            .eq("processed", true)
            .is(VOIDED_COLUMN_PATH, null)
            .eq("raw_payload->>kind", "article")
            .neq("impact_score", 0)
            .gte("occurred_at", windowSince)
            .in("person_id", [...activeIds])
            .limit(2_000),
          config.newsVolume.enabled ? firingsOf(config.newsVolume.metric) : Promise.resolve({ data: [], error: null }),
          config.companyNewsVolume.enabled ? firingsOf(config.companyNewsVolume.metric) : Promise.resolve({ data: [], error: null }),
        ]);
        if (windowStories.error) throw new Error(`Engine failed to load news-volume stories: ${windowStories.error.message}`);
        if (todaysFirings.error) throw new Error(`Engine failed to load news-volume firings: ${todaysFirings.error.message}`);
        if (todaysCompanyFirings.error) throw new Error(`Engine failed to load company-news firings: ${todaysCompanyFirings.error.message}`);
        type FiringRow = { person_id: string; impact_score: number | string | null; occurred_at: string; sigma: number | string | null };
        if (config.newsVolume.enabled) newsVolumeByPerson = groupNewsVolumeContext(windowStories.data ?? [], (todaysFirings.data ?? []) as FiringRow[], activeIds, now);
        if (config.companyNewsVolume.enabled) companyNewsVolumeByPerson = groupNewsVolumeContext(windowStories.data ?? [], (todaysCompanyFirings.data ?? []) as FiringRow[], activeIds, now);
      }

      // The logged Engine parameters (2026-10-09): Gravity's rate, read every
      // tick so an audited change takes effect on the next tick.
      const parameters = await client.from("engine_parameters").select("key, value");
      if (parameters.error) throw new Error(`Engine failed to load engine parameters: ${parameters.error.message}`);
      const engineParameters = readEngineParameters(parameters.data ?? []);

      const engineSignals: EngineSignal[] = (signals.data ?? [])
        .filter((row) => activeIds.has(row.person_id))
        .map((row) => ({
          id: row.id,
          personId: row.person_id,
          headline: row.headline,
          rawPayload: row.raw_payload,
          sourceName: row.source.name,
          // A per-item tier (RSS resolves one from the publisher domain) outranks the source's; null means the source's applies.
          sourceTier: row.tier ?? row.source.tier,
          occurredAt: new Date(row.occurred_at),
          createdAt: new Date(row.created_at),
        }));

      const tradeEvents: TradeEvent[] = (trades.data ?? []).map((row) => ({
        personId: row.person_id,
        side: row.side === "SELL" ? "SELL" : "BUY",
        amountCents: Number(row.amount_cents),
        createdAt: new Date(row.created_at),
      }));

      return {
        now,
        people: people.data ?? [],
        signals: engineSignals,
        backlog: backlogCount.count ?? engineSignals.length,
        lastServedAtByPerson: lastServedByPerson((activity.data ?? []) as Array<{ person_id: string; processed_at: string | null; kind: string | null }>),
        openCapitalCentsByPerson: sumBy(positions.data ?? [], (p) => p.person_id, (p) => Number(p.amount_cents)),
        signalActivityByPerson: aggregateSignalActivity(activity.data ?? []),
        signalVolumeByPerson: new Map(((volume.data ?? []) as PersonSignalVolumeRow[]).map(readSignalVolumeRow)),
        ...(recentStoriesByPerson ? { recentStoriesByPerson } : {}),
        ...(newsVolumeByPerson ? { newsVolumeByPerson } : {}),
        ...(companyNewsVolumeByPerson ? { companyNewsVolumeByPerson } : {}),
        engineParameters,
        tradeEvents,
        moodWindow: readMoodWindowHistory(moodEvents.data ?? [], activeIds),
        inversePairs: pairs.data ?? [],
        lastTickNumber: lastTick.data ? Number(lastTick.data.tick_number) : 0,
      };
    },

    async applyTick(tick) {
      const payload = {
        expected_tick_number: tick.expectedTickNumber,
        started_at: tick.startedAt.toISOString(),
        finished_at: tick.finishedAt.toISOString(),
        mood: tick.mood,
        summary: tick.summary,
        people: tick.people.map((p) => ({ id: p.id, score: p.score, spread: p.spread, target_attention: p.targetAttention, target_direction: p.targetDirection, target_offset: p.targetOffset })),
        signals: tick.signals.map((s) => ({
          id: s.id,
          impact_score: s.impactScore,
          sentiment_label: s.sentimentLabel,
          sentiment_confidence: s.sentimentConfidence,
        })),
        events: tick.events.map((e) => ({ person_id: e.personId, force: e.force, impact: e.impact, details: e.details })),
      };

      const { data, error } = await client.rpc("apply_engine_tick", { p_tick: payload as unknown as Json });
      if (error) throw new Error(`apply_engine_tick failed: ${error.message}`);

      // The story record (Part B): after the tick has committed, so every
      // member is a processed signal. Idempotent, and a failure here is
      // logged rather than thrown: the tick is published; the story rows
      // catch up on the next tick that confirms the same story.
      if (tick.stories.length > 0) {
        const stories = await client.rpc("record_story_clusters", { p_clusters: storyRecordsPayload(tick.stories) as unknown as Json });
        if (stories.error) console.warn("[engine] record_story_clusters failed:", stories.error.message);
      }
      // The allegation hold (2026-10-09): the tick's classifications, after
      // the tick has committed; display only, so a failure is logged and the
      // next tick that scores the story records it.
      if (tick.allegations.length > 0) {
        const holds = await client.rpc("record_allegation_holds", { p_rows: allegationHoldsPayload(tick.allegations) });
        if (holds.error) console.warn("[engine] record_allegation_holds failed:", holds.error.message);
      }

      const result = (data ?? {}) as Record<string, unknown>;
      return {
        tickNumber: Number(result.tick_number ?? tick.expectedTickNumber),
        peopleUpdated: Number(result.people_updated ?? 0),
        signalsProcessed: Number(result.signals_processed ?? 0),
        scoreEvents: Number(result.score_events ?? 0),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests, dry runs)
// ---------------------------------------------------------------------------

export interface MemoryEngineSeed {
  people: Person[];
  signals?: Array<EngineSignal & { processed?: boolean; processedAt?: Date; sentimentConfidence?: number | null }>;
  openCapitalCents?: Record<string, number>;
  tradeEvents?: TradeEvent[];
  inversePairs?: InversePair[];
  lastTickNumber?: number;
  /** personId -> event-signal volume (Phase 15). Absent people carry no weight (1). */
  signalVolume?: Record<string, PersonSignalVolume>;
  /**
   * Market Mood's window as it stood BEFORE the first tick of the test
   * (Phase 19+). Without it the store reconstructs the window from the ticks
   * it has itself recorded, exactly as the Supabase store reads it back from
   * score_events, so a run of ticks behaves as production does.
   */
  moodWindow?: { totalImpact: number; totalByPerson: Record<string, number>; readings: number };
  /** The engine_parameters rows, key → value (2026-10-09). Absent: the config defaults apply, as when the table is empty. */
  engineParameters?: Record<string, Json>;
}

export interface MemoryEngineStore extends EngineStore {
  readonly people: Person[];
  /** The story clusters every tick confirmed, in order (Part B). */
  readonly stories: StoryClusterRecord[];
  readonly signals: NonNullable<MemoryEngineSeed["signals"]>;
  readonly ticks: TickPersistence[];
  readonly scoreHistory: Array<{ personId: string; score: number; tickNumber: number; recordedAt: Date }>;
  readonly scoreEvents: Array<TickPersistence["events"][number] & { tickNumber: number }>;
  readonly processedSignals: TickPersistence["signals"];
  /** The allegation classifications the ticks recorded (2026-10-09). */
  readonly allegationHolds: TickPersistence["allegations"];
}

/**
 * The engine_parameters rows as the tick reads them (2026-10-09). A value
 * that is not a positive finite number reads as unset, so a malformed row
 * leaves the config default in force rather than stopping the Engine.
 */
export function readEngineParameters(rows: Array<{ key: string; value: Json }>): EngineParameters {
  const gravity = rows.find((row) => row.key === "gravity_rate")?.value;
  const rate = typeof gravity === "number" ? gravity : typeof gravity === "string" ? Number(gravity) : Number.NaN;
  return { gravityRatePerHour: Number.isFinite(rate) && rate > 0 ? rate : null };
}

function isArticlePayload(payload: unknown): boolean {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).kind === "article";
}
function metricKey(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  return record.kind === "metric" && typeof record.metric === "string" ? record.metric : null;
}
function metricSigma(payload: unknown): number | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const sigma = (payload as Record<string, unknown>).sigma;
  return typeof sigma === "number" && Number.isFinite(sigma) ? sigma : null;
}

export function createMemoryEngineStore(seed: MemoryEngineSeed): MemoryEngineStore {
  const people = seed.people.map((p) => ({ ...p }));
  const signals = (seed.signals ?? []).map((s) => ({ ...s }));
  const ticks: TickPersistence[] = [];
  const stories: StoryClusterRecord[] = [];
  const scoreHistory: MemoryEngineStore["scoreHistory"] = [];
  const scoreEvents: MemoryEngineStore["scoreEvents"] = [];
  const processedSignals: TickPersistence["signals"] = [];
  const allegationHolds: TickPersistence["allegations"] = [];
  let lastTickNumber = seed.lastTickNumber ?? 0;

  return {
    people,
    signals,
    ticks,
    stories,
    scoreHistory,
    scoreEvents,
    processedSignals,
    allegationHolds,

    async loadTickContext(now, config) {
      const depthSince = now.getTime() - config.spread.depthWindowHours * 3600 * 1000;
      const activeIds = new Set(people.filter((p) => p.is_active).map((p) => p.id));
      const unprocessed = signals
        .filter((s) => !s.processed && activeIds.has(s.personId))
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id));
      const tuneContext = (metric: string, windowHours: number) =>
        groupNewsVolumeContext(
          signals
            .filter((s) => s.processed && activeIds.has(s.personId) && isArticlePayload(s.rawPayload) && s.occurredAt.getTime() >= now.getTime() - windowHours * 3600 * 1000)
            .map((s) => ({
              person_id: s.personId,
              impact_score: processedSignals.find((p) => p.id === s.id)?.impactScore ?? 0,
              sentiment_confidence: s.sentimentConfidence ?? null,
              occurred_at: s.occurredAt.toISOString(),
            })),
          signals
            .filter((s) => s.processed && activeIds.has(s.personId) && metricKey(s.rawPayload) === metric)
            .map((s) => ({
              person_id: s.personId,
              impact_score: processedSignals.find((p) => p.id === s.id)?.impactScore ?? 0,
              occurred_at: s.occurredAt.toISOString(),
              sigma: metricSigma(s.rawPayload),
            })),
          activeIds,
          now,
        );
      return {
        now,
        people: people.filter((p) => p.is_active).map((p) => ({ ...p })),
        signals: unprocessed.slice(0, config.tick.loadCeiling),
        backlog: unprocessed.length,
        lastServedAtByPerson: lastServedByPerson(
          signals
            .filter((s) => s.processed && s.processedAt)
            .map((s) => ({ person_id: s.personId, processed_at: s.processedAt!.toISOString(), kind: isFreeSignal(s) ? "metric" : "event" })),
        ),
        openCapitalCentsByPerson: new Map(Object.entries(seed.openCapitalCents ?? {})),
        signalActivityByPerson: aggregateSignalActivity(
          signals
            .filter((s) => s.processed && s.processedAt && s.processedAt.getTime() >= depthSince)
            .map((s) => ({ person_id: s.personId, sentiment_confidence: s.sentimentConfidence ?? null })),
        ),
        signalVolumeByPerson: new Map(Object.entries(seed.signalVolume ?? {})),
        // Phase 31: the stories this store has already scored inside the window, as the Supabase store reads them back.
        ...(config.signalQuality.enabled
          ? {
              recentStoriesByPerson: groupRecentStories(
                signals
                  .filter((s) => s.processed && activeIds.has(s.personId) && s.occurredAt.getTime() >= now.getTime() - config.signalQuality.storyWindowHours * 3600 * 1000)
                  .map((s) => ({
                    id: s.id,
                    person_id: s.personId,
                    headline: s.headline,
                    impact_score: processedSignals.find((p) => p.id === s.id)?.impactScore ?? 0,
                    occurred_at: s.occurredAt.toISOString(),
                  })),
                activeIds,
              ),
            }
          : {}),
        // The news-volume tune's inputs (variant C), from what this store has scored, as the Supabase store reads them back.
        ...(config.companyNewsVolume.enabled ? { companyNewsVolumeByPerson: tuneContext(config.companyNewsVolume.metric, config.companyNewsVolume.windowHours) } : {}),
        engineParameters: readEngineParameters(Object.entries(seed.engineParameters ?? {}).map(([key, value]) => ({ key, value }))),
        ...(config.newsVolume.enabled
          ? {
              newsVolumeByPerson: groupNewsVolumeContext(
                signals
                  .filter((s) => s.processed && activeIds.has(s.personId) && isArticlePayload(s.rawPayload) && s.occurredAt.getTime() >= now.getTime() - config.newsVolume.windowHours * 3600 * 1000)
                  .map((s) => ({
                    person_id: s.personId,
                    impact_score: processedSignals.find((p) => p.id === s.id)?.impactScore ?? 0,
                    sentiment_confidence: s.sentimentConfidence ?? null,
                    occurred_at: s.occurredAt.toISOString(),
                  })),
                signals
                  .filter((s) => s.processed && activeIds.has(s.personId) && metricKey(s.rawPayload) === config.newsVolume.metric)
                  .map((s) => ({
                    person_id: s.personId,
                    impact_score: processedSignals.find((p) => p.id === s.id)?.impactScore ?? 0,
                    occurred_at: s.occurredAt.toISOString(),
                    sigma: metricSigma(s.rawPayload),
                  })),
                activeIds,
                now,
              ),
            }
          : {}),
        tradeEvents: [...(seed.tradeEvents ?? [])],
        moodWindow: seed.moodWindow
          ? { totalImpact: seed.moodWindow.totalImpact, totalByPerson: new Map(Object.entries(seed.moodWindow.totalByPerson)), readings: seed.moodWindow.readings }
          : readMoodWindowHistory(
              // The same reconstruction the Supabase store does, over the ticks
              // this store has recorded inside the window.
              scoreEvents
                .filter((event) => {
                  if (event.force !== "signals") return false;
                  const at = ticks.find((tick) => tick.expectedTickNumber === event.tickNumber)?.startedAt;
                  return at ? at.getTime() >= now.getTime() - config.marketMood.windowMinutes * 60 * 1000 : false;
                })
                .map((event) => ({ person_id: event.personId, impact: event.impact, tick_number: event.tickNumber })),
              activeIds,
            ),
        inversePairs: [...(seed.inversePairs ?? [])],
        lastTickNumber,
      };
    },

    async applyTick(tick) {
      if (tick.expectedTickNumber !== lastTickNumber + 1) {
        throw new Error(`stale tick (computed for tick ${tick.expectedTickNumber}, next tick is ${lastTickNumber + 1})`);
      }
      const tickNumber = lastTickNumber + 1;
      lastTickNumber = tickNumber;
      ticks.push(tick);
      stories.push(...tick.stories);

      let peopleUpdated = 0;
      for (const update of tick.people) {
        const person = people.find((p) => p.id === update.id);
        if (!person) continue;
        person.current_score = update.score;
        person.spread = update.spread;
        person.target_attention = update.targetAttention;
        person.target_direction = update.targetDirection;
        person.target_offset = update.targetOffset;
        person.last_tick_at = tick.finishedAt.toISOString();
        peopleUpdated += 1;
        scoreHistory.push({ personId: update.id, score: update.score, tickNumber, recordedAt: tick.finishedAt });
      }

      let signalsProcessed = 0;
      for (const update of tick.signals) {
        const signal = signals.find((s) => s.id === update.id && !s.processed);
        if (!signal) continue;
        signal.processed = true;
        signal.processedAt = tick.finishedAt;
        signal.sentimentConfidence = update.sentimentConfidence;
        processedSignals.push(update);
        signalsProcessed += 1;
      }

      const events = tick.events.filter((e) => e.impact !== 0);
      for (const event of events) scoreEvents.push({ ...event, tickNumber });
      allegationHolds.push(...tick.allegations);

      return { tickNumber, peopleUpdated, signalsProcessed, scoreEvents: events.length };
    },
  };
}
