import type { EngineConfig } from "@/lib/engine/config";
import type {
  EngineSignal,
  SignalActivity,
  TickContext,
  TickPersistence,
  TickPersistenceResult,
  TradeEvent,
} from "@/lib/engine/types";
import type { InversePair, Person, TypedSupabaseClient } from "@/types";
import type { Json } from "@/types/database";

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

// ---------------------------------------------------------------------------
// Supabase implementation
// ---------------------------------------------------------------------------

export function createSupabaseEngineStore(client: TypedSupabaseClient): EngineStore {
  return {
    async loadTickContext(now, config) {
      const depthSince = new Date(now.getTime() - config.spread.depthWindowHours * 3600 * 1000).toISOString();
      const tradesSince = new Date(now.getTime() - config.tradingActivity.historyHours * 3600 * 1000).toISOString();

      const [people, signals, positions, activity, trades, pairs, lastTick] = await Promise.all([
        client.from("people").select("*").eq("is_active", true).order("slug"),
        client
          .from("signals")
          .select("id, person_id, headline, raw_payload, occurred_at, created_at, source:data_sources!inner(name, tier)")
          .eq("processed", false)
          .order("created_at")
          .limit(config.tick.maxSignalsPerTick),
        client.from("positions").select("person_id, amount_cents").eq("is_open", true),
        client.from("signals").select("person_id, sentiment_confidence").eq("processed", true).gte("processed_at", depthSince),
        client.from("trade_events").select("person_id, side, amount_cents, created_at").gte("created_at", tradesSince),
        client.from("inverse_pairs").select("*"),
        client.from("engine_ticks").select("tick_number").order("tick_number", { ascending: false }).limit(1).maybeSingle(),
      ]);

      for (const [label, result] of Object.entries({ people, signals, positions, activity, trades, pairs, lastTick })) {
        if (result.error) throw new Error(`Engine failed to load ${label}: ${result.error.message}`);
      }

      const activeIds = new Set((people.data ?? []).map((p) => p.id));
      const engineSignals: EngineSignal[] = (signals.data ?? [])
        .filter((row) => activeIds.has(row.person_id))
        .map((row) => ({
          id: row.id,
          personId: row.person_id,
          headline: row.headline,
          rawPayload: row.raw_payload,
          sourceName: row.source.name,
          sourceTier: row.source.tier,
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
        openCapitalCentsByPerson: sumBy(positions.data ?? [], (p) => p.person_id, (p) => Number(p.amount_cents)),
        signalActivityByPerson: aggregateSignalActivity(activity.data ?? []),
        tradeEvents,
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
        people: tick.people.map((p) => ({ id: p.id, score: p.score, spread: p.spread })),
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
}

export interface MemoryEngineStore extends EngineStore {
  readonly people: Person[];
  readonly signals: NonNullable<MemoryEngineSeed["signals"]>;
  readonly ticks: TickPersistence[];
  readonly scoreHistory: Array<{ personId: string; score: number; tickNumber: number; recordedAt: Date }>;
  readonly scoreEvents: Array<TickPersistence["events"][number] & { tickNumber: number }>;
  readonly processedSignals: TickPersistence["signals"];
}

export function createMemoryEngineStore(seed: MemoryEngineSeed): MemoryEngineStore {
  const people = seed.people.map((p) => ({ ...p }));
  const signals = (seed.signals ?? []).map((s) => ({ ...s }));
  const ticks: TickPersistence[] = [];
  const scoreHistory: MemoryEngineStore["scoreHistory"] = [];
  const scoreEvents: MemoryEngineStore["scoreEvents"] = [];
  const processedSignals: TickPersistence["signals"] = [];
  let lastTickNumber = seed.lastTickNumber ?? 0;

  return {
    people,
    signals,
    ticks,
    scoreHistory,
    scoreEvents,
    processedSignals,

    async loadTickContext(now, config) {
      const depthSince = now.getTime() - config.spread.depthWindowHours * 3600 * 1000;
      const activeIds = new Set(people.filter((p) => p.is_active).map((p) => p.id));
      return {
        now,
        people: people.filter((p) => p.is_active).map((p) => ({ ...p })),
        signals: signals
          .filter((s) => !s.processed && activeIds.has(s.personId))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, config.tick.maxSignalsPerTick),
        openCapitalCentsByPerson: new Map(Object.entries(seed.openCapitalCents ?? {})),
        signalActivityByPerson: aggregateSignalActivity(
          signals
            .filter((s) => s.processed && s.processedAt && s.processedAt.getTime() >= depthSince)
            .map((s) => ({ person_id: s.personId, sentiment_confidence: s.sentimentConfidence ?? null })),
        ),
        tradeEvents: [...(seed.tradeEvents ?? [])],
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

      let peopleUpdated = 0;
      for (const update of tick.people) {
        const person = people.find((p) => p.id === update.id);
        if (!person) continue;
        person.current_score = update.score;
        person.spread = update.spread;
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

      return { tickNumber, peopleUpdated, signalsProcessed, scoreEvents: events.length };
    },
  };
}
