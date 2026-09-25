import { getFinnhubKeyOrNull } from "@/lib/env";

import { ConnectorError, type DataConnector, type MetricReading, type RawSignal } from "./types";

/**
 * Finnhub connector — the public company an executive is identified with.
 *
 * external_identifier is the TICKER ("TSLA"); FINNHUB_API_KEY comes from the
 * server environment, and when it is unset the connector reports itself
 * unavailable and the runner marks the source inactive for the run.
 *
 * NO SECURITY PRICE CONTRIBUTES TO ANY SCORE. This is the constraint the whole
 * module is built around, and it is a regulatory one rather than a modelling
 * preference: the platform's positioning rests on its indexes deriving no value
 * from any registered financial instrument, which is what defeats a
 * security-based swap reading under Exchange Act 3(a)(68)(A). If a person's
 * Momentum Score moved because their company's stock moved, a tradeable
 * instrument here would derive part of its value from a single registered
 * security, per person and directly.
 *
 * So the two things this connector SCORES carry no price:
 *
 *   company_news_volume_24h  a COUNT of articles Finnhub carries about the
 *                            company in the trailing window, baselined against
 *                            the person's own trailing fortnight — the same
 *                            shape as news_volume_24h, and a count is not a
 *                            price. The headlines themselves are never stored:
 *                            they are about the company rather than the person,
 *                            the two news doors already cover the person by
 *                            name, and a stored "TSLA climbs 5%" headline would
 *                            walk a price back in through the sentiment scorer.
 *
 *   insider filings          EVENTS, one per Form 4 the TRACKED PERSON filed,
 *                            carrying the direction and the SHARE COUNT and
 *                            never the transaction price or any dollar value.
 *                            See INSIDER FILINGS below for why an event rather
 *                            than a metric, and why only two transaction codes.
 *
 * And the one price it reads is OBSERVE-ONLY: daily_close is returned as a
 * reading, and the runner records it as a raw snapshot and stops there because
 * the source row lists it in config.observe_only (lib/ingest/runner.ts). No
 * observation row, no signal, no force, no memory, no score history. The series
 * still fills, so the baseline is ready the day counsel clears it, and turning
 * it on is a row update rather than a deploy: drop the key from
 * config.observe_only and declare it in config.metrics. Observe-only rather
 * than a flag defaulting on, because a flag stops future contribution and does
 * not undo history — a score that moved on a stock price stays moved in
 * score_history, in the drifting target's state and in the person's memory.
 * This way there is no trail to unwind.
 *
 * INSIDER FILINGS: an event, and why.
 *
 * A Form 4 is discrete, dated, disclosed on a known day and carries a
 * direction, which is the shape of an event and not of a level. As a metric it
 * would fail the test Phase 10 set: filings arrive in clusters (a 10b5-1 plan
 * files on consecutive days and then nothing for a month), so a per-poll count
 * has a distribution set by the filing calendar, and its sigma would describe
 * the plan rather than the person.
 *
 * Two filters decide whether a filing is about the person at all:
 *
 *   WHOSE. Finnhub returns every insider at the company. "Tesla's CFO sold
 *   shares" is not a Musk event. Only filings whose insider name matches the
 *   mapping's config.insider_names become signals; a person with no configured
 *   name produces none, and the poll says so through the note channel rather
 *   than attributing the company's filings to them.
 *
 *   WHICH CODE. P (open-market purchase) and S (open-market sale) are decisions
 *   an insider took. A (award), M (option exercise), F (shares withheld for
 *   tax), G (gift) are compensation and estate mechanics; scoring an award as
 *   positive would mean the board paying the CEO moved the CEO's score.
 *   config.insider_codes is the list, and it ships as P and S.
 *
 * One signal per (filing date, code): a Form 4 that reports a sale in five
 * lines at five prices is one decision, so the share counts are summed and the
 * prices are never read.
 */

export const FINNHUB_SOURCE_NAME = "finnhub";
const DEFAULT_HOST = "https://finnhub.io/api/v1";

/**
 * EVERY metric key this connector derives from a security price. The source row
 * must list all of them in config.observe_only; a database test asserts exactly
 * that, so a price metric added here without the matching row change fails the
 * suite rather than reaching a score.
 */
export const PRICE_DERIVED_METRICS = ["daily_close"] as const;

/** Yesterday's official close, read once a day. Observe-only: recorded, displayed, never scored. */
export const DAILY_CLOSE_METRIC = "daily_close";
/** Articles Finnhub carried about the company in the trailing window. A count, baselined per person. */
export const COMPANY_NEWS_VOLUME_METRIC = "company_news_volume_24h";
/** Where a poll's insider-filing account is written: source_polls.detail -> 'insider_filings'. */
export const INSIDER_DETAIL_KEY = "insider_filings";

/** Signal kind of an insider filing, so the Feed and the Engine can tell it from an article. */
export const INSIDER_FILING_KIND = "insider_filing";

export interface FinnhubConnectorConfig {
  host: string;
  /** Trailing window the company-news count covers. */
  news_window_hours: number;
  /** How far back the insider-filing read looks. */
  insider_lookback_days: number;
  /** Transaction codes that count as a decision. Anything else is compensation or estate mechanics. */
  insider_codes: string[];
  /** The close is re-read only when the last snapshot is older than this, so it costs one call a day. */
  daily_close_hours: number;
}

const DEFAULT_CONFIG: FinnhubConnectorConfig = {
  host: DEFAULT_HOST,
  news_window_hours: 24,
  insider_lookback_days: 45,
  insider_codes: ["P", "S"],
  daily_close_hours: 20,
};

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : fallback;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringListOr(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string") ? (value as string[]) : fallback;
}

export function readFinnhubConfig(config: Record<string, unknown>): FinnhubConnectorConfig {
  return {
    host: stringOr(config.host, DEFAULT_CONFIG.host),
    news_window_hours: positiveOr(config.news_window_hours, DEFAULT_CONFIG.news_window_hours),
    insider_lookback_days: positiveOr(config.insider_lookback_days, DEFAULT_CONFIG.insider_lookback_days),
    insider_codes: stringListOr(config.insider_codes, DEFAULT_CONFIG.insider_codes).map((code) => code.trim().toUpperCase()),
    daily_close_hours: positiveOr(config.daily_close_hours, DEFAULT_CONFIG.daily_close_hours),
  };
}

/** The insider names of the tracked person, from the mapping's config. Empty means the person files under no name we know. */
export function readInsiderNames(personConfig: Record<string, unknown> | undefined): string[] {
  const raw = personConfig?.insider_names;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

/**
 * Whether a filing's insider is one of the configured names. Form 4 names come
 * through as "Musk Elon", "ELLISON LAWRENCE J", "Dell Michael S" — surname
 * first, sometimes with a middle initial, in any case — so a configured name
 * matches when every one of its words appears in the filing's, which accepts
 * the middle initial and rejects a different Musk.
 */
export function matchesInsider(filingName: string, names: string[]): boolean {
  const haystack = ` ${filingName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  return names.some((name) => {
    const words = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every((word) => haystack.includes(` ${word} `));
  });
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

async function call<T>(path: string, config: FinnhubConnectorConfig, key: string, fetchImpl: typeof fetch): Promise<T> {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetchImpl(`${config.host}${path}${separator}token=${encodeURIComponent(key)}`, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new ConnectorError(`Finnhub responded ${response.status} for ${path.split("?")[0]}`, {
      status: response.status,
      // 429 is the free tier's 60-a-minute ceiling; the next poll is the retry.
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  return (await response.json()) as T;
}

/** YYYY-MM-DD in UTC, which is what Finnhub's from/to parameters take. */
export function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

interface RawArticle {
  id?: number;
  datetime?: number;
  headline?: string;
}

/**
 * Articles about the company published inside the window. Finnhub's from/to are
 * whole days, so the response is trimmed to the window by each item's own
 * timestamp and de-duplicated by id: a count that depended on the poll's hour
 * would measure the schedule.
 */
export function countArticles(articles: RawArticle[], now: Date, windowHours: number): number {
  const since = now.getTime() - windowHours * 3_600_000;
  const seen = new Set<number>();
  let count = 0;
  for (const article of articles) {
    if (typeof article.datetime !== "number" || !Number.isFinite(article.datetime)) continue;
    const at = article.datetime * 1000;
    if (at < since || at > now.getTime()) continue;
    if (typeof article.id === "number") {
      if (seen.has(article.id)) continue;
      seen.add(article.id);
    }
    count += 1;
  }
  return count;
}

export interface InsiderFiling {
  insider: string;
  /** Filing date (when it became public), the day the news attaches to. */
  filedAt: Date;
  transactionDate: string | null;
  code: string;
  /** Signed share count: positive bought, negative sold. Never a price, never a value. */
  shares: number;
}

interface RawInsider {
  name?: unknown;
  change?: unknown;
  filingDate?: unknown;
  transactionDate?: unknown;
  transactionCode?: unknown;
}

/** Why one of the tracked person's own Form 4 lines did not become part of a signal. */
export type InsiderDropReason = "code_not_scored" | "no_share_change" | "no_filing_date" | "net_zero";

/** One of the tracked person's own lines, and what became of it. Share counts only: no price is ever read. */
export interface InsiderRowOutcome {
  insider: string;
  filed: string | null;
  code: string;
  shares: number | null;
  outcome: "kept" | "dropped";
  reason: InsiderDropReason | null;
}

/**
 * EVERY INSIDER LINE FINNHUB RETURNED, ACCOUNTED FOR (Phase 29d). Before this,
 * lines that did not become signals were dropped without a count, so "no
 * insider signal ever" could not be told apart from "no filing ever", "filed
 * under a name we do not match" or "filed only awards and exercises". Now:
 *
 *   fetched          every line for the company in the window
 *   otherInsiders    lines whose insider is not the tracked person, counted,
 *                    with the distinct names (so a name we fail to match
 *                    shows up here)
 *   rows             each of the tracked person's own lines: kept, or dropped
 *                    with the reason — a code that is not scored (awards,
 *                    exercises, withholding: not a decision), no share count,
 *                    no date, or a filing whose lines cancel out
 *   filings          what becomes signals: one per (filing date, code)
 *
 * Everything about the price — Finnhub's transactionPrice — is dropped here
 * and never read again, and none of it reaches the account.
 */
export interface InsiderAccount {
  fetched: number;
  otherInsiderRows: number;
  otherInsiders: string[];
  rows: InsiderRowOutcome[];
  filings: InsiderFiling[];
}

/** Most distinct other insiders' names an account carries. */
const OTHER_INSIDER_NAMES = 20;

export function accountInsiderFilings(rows: RawInsider[], names: string[], codes: string[]): InsiderAccount {
  const wanted = new Set(codes.map((code) => code.toUpperCase()));
  const byFiling = new Map<string, { filing: InsiderFiling; lines: InsiderRowOutcome[] }>();
  const outcomes: InsiderRowOutcome[] = [];
  const others = new Set<string>();
  let otherInsiderRows = 0;
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name : "";
    if (!name || !matchesInsider(name, names)) {
      otherInsiderRows += 1;
      if (name && others.size < OTHER_INSIDER_NAMES) others.add(name);
      continue;
    }
    const code = typeof row.transactionCode === "string" ? row.transactionCode.trim().toUpperCase() : "";
    const change = typeof row.change === "number" && Number.isFinite(row.change) ? row.change : null;
    const filedRaw = typeof row.filingDate === "string" ? row.filingDate : typeof row.transactionDate === "string" ? row.transactionDate : null;
    const filedAt = filedRaw ? new Date(`${filedRaw.slice(0, 10)}T00:00:00.000Z`) : null;
    const filed = filedAt && !Number.isNaN(filedAt.getTime()) ? filedRaw!.slice(0, 10) : null;
    const line: InsiderRowOutcome = { insider: name, filed, code, shares: change, outcome: "dropped", reason: null };
    outcomes.push(line);
    if (!wanted.has(code)) {
      line.reason = "code_not_scored";
      continue;
    }
    if (change === null || change === 0) {
      line.reason = "no_share_change";
      continue;
    }
    if (!filed || !filedAt) {
      line.reason = "no_filing_date";
      continue;
    }
    line.outcome = "kept";
    const key = `${filed}|${code}`;
    const existing = byFiling.get(key);
    if (existing) {
      existing.filing.shares += change;
      existing.lines.push(line);
    } else {
      byFiling.set(key, {
        filing: { insider: name, filedAt, transactionDate: typeof row.transactionDate === "string" ? row.transactionDate.slice(0, 10) : null, code, shares: change },
        lines: [line],
      });
    }
  }
  // A filing whose lines cancel out reported no net decision.
  const filings: InsiderFiling[] = [];
  for (const { filing, lines } of byFiling.values()) {
    if (filing.shares === 0) {
      for (const line of lines) {
        line.outcome = "dropped";
        line.reason = "net_zero";
      }
    } else filings.push(filing);
  }
  filings.sort((a, b) => a.filedAt.getTime() - b.filedAt.getTime());
  return { fetched: rows.length, otherInsiderRows, otherInsiders: [...others].sort(), rows: outcomes, filings };
}

/**
 * The tracked person's decisions, one per (filing date, code), share counts
 * summed across the filing's lines: the filings of accountInsiderFilings.
 */
export function readInsiderFilings(rows: RawInsider[], names: string[], codes: string[]): InsiderFiling[] {
  return accountInsiderFilings(rows, names, codes).filings;
}

/** How a transaction code reads in a sentence. */
const CODE_PHRASE: Record<string, string> = { P: "an open-market purchase", S: "an open-market sale" };

/**
 * The signal for one filing. The headline carries the direction and the share
 * count and NOTHING priced: no transaction price, no dollar value, nothing a
 * reader or the sentiment scorer could turn back into one.
 */
export function insiderSignal(person: { display_name: string }, symbol: string, filing: InsiderFiling): RawSignal {
  const shares = Math.abs(Math.round(filing.shares));
  const phrase = CODE_PHRASE[filing.code] ?? (filing.shares > 0 ? "a purchase" : "a sale");
  const filed = isoDate(filing.filedAt);
  return {
    headline: `${person.display_name} reported ${phrase} of ${shares.toLocaleString("en-US")} ${symbol} shares in a Form 4 filed ${filed}.`,
    occurredAt: filing.filedAt,
    dedupeKey: `${FINNHUB_SOURCE_NAME}:insider:${symbol}:${filed}:${filing.code}`,
    rawPayload: {
      kind: INSIDER_FILING_KIND,
      source: FINNHUB_SOURCE_NAME,
      symbol,
      insider: filing.insider,
      transaction_code: filing.code,
      direction: filing.shares > 0 ? 1 : -1,
      shares,
      filing_date: filed,
      transaction_date: filing.transactionDate,
    },
  };
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

function requireKey(): string {
  const key = getFinnhubKeyOrNull();
  if (!key) throw new ConnectorError("FINNHUB_API_KEY is not set");
  return key;
}

function requireSymbol(person: { slug: string }, identifier: string): string {
  const trimmed = identifier.trim().toUpperCase();
  if (!trimmed) throw new ConnectorError(`No ticker configured for ${person.slug}`);
  return trimmed;
}

export const finnhubConnector: DataConnector = {
  name: FINNHUB_SOURCE_NAME,

  available() {
    return getFinnhubKeyOrNull() ? { ok: true } : { ok: false, reason: "FINNHUB_API_KEY is not set" };
  },

  /** Events: the tracked person's own Form 4 decisions, and nothing else the company filed. */
  async fetchForPerson(person, identifier, context): Promise<RawSignal[]> {
    if (typeof window !== "undefined") throw new Error("The Finnhub connector is server-only.");
    const key = requireKey();
    const config = readFinnhubConfig(context.config as Record<string, unknown>);
    const symbol = requireSymbol(person, identifier);
    const names = readInsiderNames(context.personConfig as Record<string, unknown> | undefined);
    if (names.length === 0) {
      // Never attribute the company's filings to the person: say so instead.
      context.note?.(`no config.insider_names on the ${person.slug} mapping, so no Form 4 of ${symbol} was attributed to them; the company-news count is unaffected`);
      context.detail?.(INSIDER_DETAIL_KEY, { symbol, fetched: null, reason: "no_insider_names" });
      return [];
    }

    const from = isoDate(new Date(context.now.getTime() - config.insider_lookback_days * 86_400_000));
    const body = await call<{ data?: RawInsider[] }>(
      `/stock/insider-transactions?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${isoDate(context.now)}`,
      config,
      key,
      context.fetch,
    );
    const account = accountInsiderFilings(body.data ?? [], names, config.insider_codes);
    // The whole account onto the poll row and the run log (Phase 29d), kept or not.
    context.detail?.(INSIDER_DETAIL_KEY, {
      symbol,
      from,
      to: isoDate(context.now),
      names,
      codes: config.insider_codes,
      fetched: account.fetched,
      other_insider_rows: account.otherInsiderRows,
      other_insiders: account.otherInsiders,
      rows: account.rows.map((row) => ({ insider: row.insider, filed: row.filed, code: row.code, shares: row.shares, outcome: row.outcome, reason: row.reason })),
      filings_kept: account.filings.length,
    });
    return account.filings.map((filing) => insiderSignal(person, symbol, filing));
  },

  /**
   * Metrics. The company-news count is the one that scores. The daily close is
   * returned too, and the runner records it as a raw snapshot and stops,
   * because the source row lists it in config.observe_only.
   */
  async fetchMetrics(person, identifier, context): Promise<MetricReading[]> {
    if (typeof window !== "undefined") throw new Error("The Finnhub connector is server-only.");
    const key = requireKey();
    const config = readFinnhubConfig(context.config as Record<string, unknown>);
    const symbol = requireSymbol(person, identifier);
    const readings: MetricReading[] = [];

    // 1. The count that scores ------------------------------------------------
    // Finnhub's from/to are whole days, so the window is asked for generously
    // and trimmed by each article's own timestamp.
    const days = Math.ceil(config.news_window_hours / 24) + 1;
    const articles = await call<RawArticle[]>(
      `/company-news?symbol=${encodeURIComponent(symbol)}&from=${isoDate(new Date(context.now.getTime() - days * 86_400_000))}&to=${isoDate(context.now)}`,
      config,
      key,
      context.fetch,
    );
    if (!Array.isArray(articles)) {
      throw new ConnectorError(`Finnhub company-news for ${symbol} (${person.slug}) answered with ${typeof articles} rather than an array of articles; nothing was recorded.`);
    }
    readings.push({ metricKey: COMPANY_NEWS_VOLUME_METRIC, value: countArticles(articles, context.now, config.news_window_hours) });

    // 2. The close, observe-only ----------------------------------------------
    // Read once a day, and its failure never costs the count above: the price is
    // the one figure here that contributes nothing, so it must never be the
    // reason a scoring metric goes missing (the Phase 16 lesson).
    const previous = await context.snapshots.latest(DAILY_CLOSE_METRIC);
    const due = !previous || context.now.getTime() - previous.recordedAt.getTime() >= config.daily_close_hours * 3_600_000;
    if (due) {
      try {
        const quote = await call<{ pc?: unknown }>(`/quote?symbol=${encodeURIComponent(symbol)}`, config, key, context.fetch);
        // `pc` is the previous session's official close: stable all day, which
        // is what makes one reading a day a clean series rather than a sample
        // of whatever minute the cron fired.
        const close = typeof quote.pc === "number" && Number.isFinite(quote.pc) && quote.pc > 0 ? quote.pc : null;
        if (close === null) context.note?.(`Finnhub quote for ${symbol} carried no previous close; the observe-only daily close was not recorded this poll`);
        else readings.push({ metricKey: DAILY_CLOSE_METRIC, value: close });
      } catch (error) {
        context.note?.(`Finnhub quote for ${symbol} failed (${error instanceof Error ? error.message : String(error)}); the observe-only daily close was not recorded this poll and the company-news count was unaffected`);
      }
    }

    return readings;
  },
};
