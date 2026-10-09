import "server-only";

import { cache } from "react";

import { loadCompaniesByPerson } from "@/lib/feed/enrich";
import { avatarCredit, readAvatarRecord } from "@/lib/people/avatar-model";
import { DISPLAY_COLUMNS, isDisplayable } from "@/lib/signals/display";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import {
  FORCES_WINDOW_MINUTES,
  FORCES_WINDOW_TICKS,
  RANGES,
  convictionLevelFromConcentration,
  emptyMarketReadings,
  emptySeries,
  isValidSlug,
  mergeSignals,
  readForces,
  readMarketReadings,
  toProfilePerson,
  toSeries,
  type ConvictionLevel,
  type ForceImpactRow,
  type ForceReading,
  type MarketReadings,
  type NarrativeRow,
  type ProfilePerson,
  type ProfilePersonRow,
  type ProfileSignal,
  type ScoreEventRow,
  type SeriesByRange,
  type SeriesRow,
  type SignalRow,
  type TradeEventRow,
} from "./profile-model";

/**
 * The profile page's server-side reads.
 *
 * Like Home, these go through the service-role client: the profile is a
 * public page, and anon has no RLS policies anywhere, so a signed-out visitor
 * reading with the publishable key would see nothing. Everything here is
 * per-person, bounded, and read-only; only the rendered fields reach the
 * browser.
 *
 * Every export is wrapped in React cache() AND KEYED BY THE SLUG (2026-10-02):
 * the page, its metadata, the desktop rail (a parallel route rendered in the
 * same request) and the live route share one set of queries. The rail used
 * to pass an object literal as the key, which cache() compares by identity,
 * so every rail render re-ran the signals and narratives reads.
 *
 * THE READS, IN THE ORDER THE PAGE NEEDS THEM (2026-10-02). The slug lookup
 * is one round trip (person_profile_header: the person, the avatar credit's
 * mapping configs, the quote and the newest tick) and the header renders
 * from it. The chart series, the forces and the signal list are separate
 * reads behind their own Suspense boundaries, so the slowest of them no
 * longer holds the whole page.
 */

/** Most signal / narrative items the page lists. */
const SIGNAL_LIMIT = 30;

/**
 * How many times SIGNAL_LIMIT signals are read, so the list stays full after
 * the ones a narrative carries fall out (rule 8). Production, 2026-09-26: at
 * most 23 of any person's newest 90 signals were direct evidence; 60 rows
 * leave room for that and read a third less (2026-10-02).
 */
const SIGNAL_READ_DEPTH = 2;

/**
 * THE PAYLOAD, PROJECTED (2026-10-02). The list used to read every signal's
 * whole raw_payload — a comment digest's sampled comment texts included —
 * and project it on the server. Only these keys are ever read by the card
 * copy (lib/feed/card-copy.ts projectSignalDetail / projectMedia /
 * projectGame, lib/signals/metric-language.ts readMetricPayload, the voided
 * marker), so only these keys are asked for, as JSON fields of the row, and
 * the payload the copy sees is rebuilt from them. A key the payload does not
 * carry comes back null and is left out, exactly as an absent key reads.
 */
export const PAYLOAD_KEYS = [
  "kind",
  "link",
  "outlet",
  "publisher_domain",
  "lean",
  "sampled",
  "videoTitle",
  "video_id",
  "videoId",
  "channel",
  "clip_slug",
  "clip_id",
  "title",
  "game",
  "home",
  "away",
  "home_score",
  "away_score",
  "week",
  "voided",
  "metric",
  "label",
  "sigma",
  "window_hours",
  "observed",
  "baseline",
  "samples",
] as const;

const PAYLOAD_PREFIX = "payload_";

/** The select fragment that reads the projected keys: `payload_kind:raw_payload->kind, …`. */
const PAYLOAD_SELECT = PAYLOAD_KEYS.map((key) => `${PAYLOAD_PREFIX}${key}:raw_payload->${key}`).join(", ");

/** The payload as the card copy reads it, rebuilt from the projected columns; null when no key was present. */
export function payloadFromProjection(row: Record<string, unknown>): Record<string, unknown> | null {
  const payload: Record<string, unknown> = {};
  let any = false;
  for (const key of PAYLOAD_KEYS) {
    const value = row[`${PAYLOAD_PREFIX}${key}`];
    if (value === null || value === undefined) continue;
    payload[key] = value;
    any = true;
  }
  return any ? payload : null;
}

/** The request's render time; lives in lib/render-time.ts, re-exported for the profile routes. */
export { getRenderedAt } from "@/lib/render-time";

/** What person_profile_header() returns. */
interface HeaderPayload {
  person: ProfilePersonRow & { id: string };
  avatar_configs: Array<{ avatar: unknown } | null> | null;
  quote: Record<string, unknown> | null;
  latest_tick: { tick_number: number | string; recorded_at: string } | null;
}

/** The person behind a slug and their newest tick: everything the page's header renders from. */
export interface PersonHeader {
  person: ProfilePerson;
  /** The person's newest score_history row, or null before their first tick. */
  latestTick: { tickNumber: number; at: string } | null;
}

/**
 * The slug lookup, in one round trip (2026-10-02): the people row (the
 * market's STATE: inventory, premium, mode, halt), the avatar credit from
 * the person's platform mapping, the market's PARAMETERS from trade_quote()
 * (the tier's depth and premium cap with any per-person override, resolved
 * exactly as place_order() resolves them, so the book the sheet previews on
 * is the book the server prices on) and the newest tick. Null when there is
 * no active person by that name.
 */
export const getPersonHeader = cache(async (slug: string): Promise<PersonHeader | null> => {
  if (!isValidSlug(slug)) return null;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("person_profile_header", { p_slug: slug });
  if (error) throw new Error(`Could not load person: ${error.message}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const header = data as unknown as HeaderPayload;
  const base = header.person;
  const credit = avatarCreditFrom(header.avatar_configs ?? [], base.avatar_url);
  // The parameters are an enhancement to the preview; the server enforces them regardless.
  if (!header.quote) console.warn("[person] trade_quote returned nothing, previewing on a flat market");
  const params = header.quote ?? {};
  const person = toProfilePerson({
    ...base,
    avatar_credit: credit,
    depth_units: (params.depth_units as number | string | null | undefined) ?? null,
    premium_cap_cents: (params.premium_cap_cents as number | string | null | undefined) ?? null,
  });
  const tick = header.latest_tick;
  const tickNumber = tick ? Number(tick.tick_number) : Number.NaN;
  return { person, latestTick: tick && Number.isFinite(tickNumber) ? { tickNumber, at: tick.recorded_at } : null };
});

/** The person behind a slug, or null when there is no active person by that name. */
export const getPersonBySlug = cache(async (slug: string): Promise<ProfilePerson | null> => (await getPersonHeader(slug))?.person ?? null);

/**
 * The credit for a platform avatar (2026-09-29): the record on the person's
 * YouTube or Twitch mapping, when it is the picture the person row shows.
 * Null for initials, and when the record and the row disagree.
 */
function avatarCreditFrom(configs: Array<{ avatar: unknown } | null>, avatarUrl: string | null) {
  if (!avatarUrl) return null;
  for (const config of configs) {
    const record = readAvatarRecord((config ?? null) as Parameters<typeof readAvatarRecord>[0]);
    if (record && record.url === avatarUrl) return avatarCredit(record);
  }
  return null;
}

/**
 * Score and market-price history for every chart range, each downsampled by
 * the database. Empty for an unknown slug. A failed range reads as empty:
 * the chart is an enhancement, the page still renders.
 */
export const getPersonSeries = cache(async (slug: string): Promise<SeriesByRange> => {
  const header = await getPersonHeader(slug);
  const series = emptySeries();
  if (!header) return series;

  const supabase = createSupabaseAdminClient();
  const now = Date.now();
  const results = await Promise.all(
    RANGES.map((range) =>
      supabase.rpc("person_market_series", {
        p_person_id: header.person.id,
        p_since: range.windowMs === null ? undefined : new Date(now - range.windowMs).toISOString(),
        p_points: range.points,
      }),
    ),
  );
  RANGES.forEach((range, index) => {
    const result = results[index];
    if (result.error) {
      console.warn(`[person] person_market_series(${range.key}) failed:`, result.error.message);
      return;
    }
    series[range.key] = toSeries((result.data ?? []) as SeriesRow[]);
  });
  return series;
});

/** The five forces, the market readings behind the two market forces, and the CONVICTION level. */
export interface PersonReadings {
  forces: ForceReading[];
  conviction: ConvictionLevel | null;
  /** What the two market forces read right now (Phase 29). */
  market: MarketReadings;
  latestTick: PersonHeader["latestTick"];
}

/**
 * The forces panel's reads (2026-10-02, split out of the old getPersonProfile):
 * every force row of the window, the newest tick's rows for the working,
 * open paper capital and the tape. Null for an unknown slug.
 */
export const getPersonReadings = cache(async (slug: string): Promise<PersonReadings | null> => {
  const header = await getPersonHeader(slug);
  if (!header) return null;
  const { person, latestTick } = header;

  const supabase = createSupabaseAdminClient();
  const windowStart = new Date(Date.now() - FORCES_WINDOW_MINUTES * 60_000).toISOString();
  const [windowResult, eventsResult, capitalResult, tradesResult] = await Promise.all([
    // Every force row of the last FORCES_WINDOW_TICKS ticks, which is what the
    // panel adds up: bounded by tick number (2026-10-02), the column the
    // person's score_events are indexed on, from the newest tick the header
    // read. At most four rows a tick bounds the window at 480; the limit is
    // the ceiling, not a page. Force and impact only — the working is read
    // once, below, not 480 times. Nothing before the first tick.
    latestTick
      ? supabase
          .from("score_events")
          .select("force, impact")
          .eq("person_id", person.id)
          .gt("tick_number", latestTick.tickNumber - FORCES_WINDOW_TICKS)
          .lte("tick_number", latestTick.tickNumber)
          .limit(1_000)
      : Promise.resolve({ data: [] as ForceImpactRow[], error: null }),
    // The latest tick's rows, for the working each force recorded there.
    supabase
      .from("score_events")
      .select("force, impact, tick_number, details")
      .eq("person_id", person.id)
      .order("tick_number", { ascending: false })
      .order("id")
      .limit(12),
    // THE MARKET READINGS (Phase 29). Conviction reads open paper capital on
    // the person — the same rows and the same column the Engine sums — and
    // Trading Activity reads the tape over the display window. Neither
    // touches the score; both move the market price, and the panel says so.
    supabase.from("positions").select("amount_cents").eq("person_id", person.id).eq("is_open", true).limit(5_000),
    supabase.from("trade_events").select("side, amount_cents").eq("person_id", person.id).gte("created_at", windowStart).limit(5_000),
  ]);

  if (windowResult.error) console.warn("[person] score_events window read failed:", windowResult.error.message);
  if (eventsResult.error) console.warn("[person] score_events read failed:", eventsResult.error.message);
  if (capitalResult.error) console.warn("[person] positions read failed:", capitalResult.error.message);
  if (tradesResult.error) console.warn("[person] trade_events read failed:", tradesResult.error.message);

  const forces = readForces((windowResult.data ?? []) as ForceImpactRow[], (eventsResult.data ?? []) as ScoreEventRow[], latestTick?.tickNumber ?? null);

  const openCapitalCents = (capitalResult.data ?? []).reduce((total, row) => total + Number(row.amount_cents), 0);
  const market =
    capitalResult.error && tradesResult.error
      ? emptyMarketReadings()
      : readMarketReadings(openCapitalCents, person.maxAllocationCents, (tradesResult.data ?? []) as TradeEventRow[]);

  return {
    forces,
    // Read from the concentration itself: the Conviction force no longer
    // writes score_events (it moves the market price, not the score), so the
    // level comes straight from the capital rather than from an audit row.
    conviction: latestTick === null ? null : convictionLevelFromConcentration(market.conviction.concentration ?? 0),
    market,
    latestTick,
  };
});

/**
 * The person's newest signals and Engine narratives, merged newest first,
 * rendered through the shared card copy (Phase 30) exactly as the Feed
 * renders them: a metric from its payload rather than the stored headline
 * (Phase 21+), an article by its title and outlet, a template narrative
 * un-nested. The company behind a company-news metric comes from the
 * person's Finnhub mapping. Empty for an unknown slug.
 */
export const getPersonSignals = cache(async (slug: string): Promise<ProfileSignal[]> => {
  const header = await getPersonHeader(slug);
  if (!header) return [];
  const { person } = header;

  const supabase = createSupabaseAdminClient();
  const [signals, narratives, companies] = await Promise.all([
    // Read deeper than the list shows: a signal a narrative links as direct
    // evidence is not an item of its own (rule 8) and falls out in the merge.
    supabase
      .from("signals")
      .select(`id, headline, occurred_at, impact_score, sentiment_label, sentiment_confidence, processed, ${DISPLAY_COLUMNS}, ${PAYLOAD_SELECT}, data_sources(display_name), narrative_signals(relation)`)
      .eq("person_id", person.id)
      .is("voided_at", null)
      .is("hidden_at", null)
      .eq("allegation_held", false)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SIGNAL_LIMIT * SIGNAL_READ_DEPTH),
    supabase
      .from("narratives")
      .select(
        `id, text, created_at, score_before, score_after, narrative_signals(relation, signals(id, headline, occurred_at, impact_score, ${DISPLAY_COLUMNS}, ${PAYLOAD_SELECT}, data_sources(display_name), people(display_name)))`,
      )
      .eq("person_id", person.id)
      .is("voided_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SIGNAL_LIMIT),
    loadCompaniesByPerson(),
  ]);

  if (signals.error) console.warn("[person] signals read failed:", signals.error.message);
  if (narratives.error) console.warn("[person] narratives read failed:", narratives.error.message);

  // The projected keys become the payload the card copy reads; a voided
  // signal (a false input the operator struck) is neither a card nor evidence.
  const liveSignals = ((signals.data ?? []) as unknown as Array<SignalRow & Record<string, unknown>>)
    .map((row) => ({ ...row, raw_payload: payloadFromProjection(row) }))
    .filter((row) => isDisplayable(row));
  const liveNarratives = ((narratives.data ?? []) as unknown as NarrativeRow[]).map((row) => ({
    ...row,
    narrative_signals: (row.narrative_signals ?? [])
      .map((link) => ({
        ...link,
        signals: link.signals ? { ...link.signals, raw_payload: payloadFromProjection(link.signals as unknown as Record<string, unknown>) } : link.signals,
      }))
      .filter((link) => isDisplayable(link.signals)),
  }));

  return mergeSignals(liveSignals, liveNarratives, SIGNAL_LIMIT, { name: person.displayName, category: person.category, company: companies.get(person.id) ?? null });
});
