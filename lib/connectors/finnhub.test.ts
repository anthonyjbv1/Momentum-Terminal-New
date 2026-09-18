import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";

import {
  COMPANY_NEWS_VOLUME_METRIC,
  DAILY_CLOSE_METRIC,
  PRICE_DERIVED_METRICS,
  countArticles,
  finnhubConnector,
  insiderSignal,
  matchesInsider,
  readFinnhubConfig,
  readInsiderFilings,
  readInsiderNames,
} from "./finnhub";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const musk = makePerson({ slug: "elon-musk", display_name: "Elon Musk", category: "executive" });
const SYMBOL = "TSLA";

/** The transaction price the fixtures carry. It must appear nowhere this connector produces. */
const TRANSACTION_PRICE = 421.37;

interface Call {
  url: string;
}

interface Options {
  articles?: Array<{ id?: number; datetime?: number; headline?: string }>;
  insiders?: Array<Record<string, unknown>>;
  quote?: Record<string, unknown>;
  newsStatus?: number;
  quoteStatus?: number;
  /** Replaces the company-news body with something that is not an array. */
  newsBody?: unknown;
}

const hoursAgo = (h: number) => Math.floor((NOW.getTime() - h * 3_600_000) / 1000);

function finnhubFetch(options: Options = {}) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url });
    if (url.includes("/company-news")) {
      if (options.newsStatus && options.newsStatus !== 200) return Response.json({}, { status: options.newsStatus });
      return Response.json(options.newsBody !== undefined ? options.newsBody : (options.articles ?? []));
    }
    if (url.includes("/stock/insider-transactions")) return Response.json({ data: options.insiders ?? [], symbol: SYMBOL });
    if (url.includes("/quote")) {
      if (options.quoteStatus && options.quoteStatus !== 200) return Response.json({}, { status: options.quoteStatus });
      return Response.json(options.quote ?? { c: 430.1, pc: 425.5, h: 431, l: 420, o: 422, t: 1_789_000_000 });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return Object.assign(impl, { calls, urls: (fragment: string) => calls.filter((call) => call.url.includes(fragment)).map((call) => call.url) });
}

const context = (
  fetch: typeof globalThis.fetch,
  options: { config?: Record<string, unknown>; personConfig?: Record<string, unknown>; latest?: Record<string, { value: number; recordedAt: Date }> } = {},
) => {
  const recorded: Array<{ metricKey: string; value: number }> = [];
  const notes: string[] = [];
  return {
    source: makeSource({ name: "finnhub", tier: 1 }),
    config: (options.config ?? {}) as Record<string, never>,
    personConfig: (options.personConfig ?? { insider_names: ["Musk Elon"] }) as Record<string, never>,
    snapshots: {
      latest: async (metricKey: string) => {
        const hit = options.latest?.[metricKey];
        return hit ? { metricKey, value: hit.value, recordedAt: hit.recordedAt } : null;
      },
      record: (metricKey: string, value: number) => void recorded.push({ metricKey, value }),
    },
    now: NOW,
    fetch,
    note: (message: string) => void notes.push(message),
    recorded,
    notes,
  };
};

/** A Form 4 line as Finnhub returns it — transactionPrice included, as the real response has it. */
function line(overrides: Record<string, unknown> = {}) {
  return {
    name: "Musk Elon",
    share: 411_000_000,
    change: -500_000,
    filingDate: "2026-09-16",
    transactionDate: "2026-09-14",
    transactionCode: "S",
    transactionPrice: TRANSACTION_PRICE,
    isDerivative: false,
    currency: "USD",
    symbol: SYMBOL,
    ...overrides,
  };
}

describe("readFinnhubConfig", () => {
  it("falls back to the shipped defaults and takes what the row sets", () => {
    expect(readFinnhubConfig({})).toEqual({
      host: "https://finnhub.io/api/v1",
      news_window_hours: 24,
      insider_lookback_days: 45,
      insider_codes: ["P", "S"],
      daily_close_hours: 20,
    });
    expect(readFinnhubConfig({ news_window_hours: 48, insider_codes: ["p", "s", "m"], host: "https://example.test/v1/" })).toMatchObject({
      news_window_hours: 48,
      insider_codes: ["P", "S", "M"],
      host: "https://example.test/v1",
    });
    // Malformed entries leave the default alone rather than widening anything.
    expect(readFinnhubConfig({ insider_codes: [], news_window_hours: -3 })).toMatchObject({ insider_codes: ["P", "S"], news_window_hours: 24 });
  });
});

describe("matchesInsider", () => {
  it("matches the SEC's surname-first spelling through case and middle initials", () => {
    expect(matchesInsider("Musk Elon", ["Musk Elon"])).toBe(true);
    expect(matchesInsider("ELLISON LAWRENCE J", ["Ellison Lawrence"])).toBe(true);
    expect(matchesInsider("Dell Michael S", ["Dell Michael"])).toBe(true);
    expect(matchesInsider("Huang Jen-Hsun", ["Huang Jen Hsun"])).toBe(true);
    expect(matchesInsider("Zuckerberg Mark", ["Zuckerberg Mark", "Chan Priscilla"])).toBe(true);
  });

  it("refuses a different insider at the same company, which is the whole point of the filter", () => {
    // Tesla's CFO is not a Musk event, and neither is his brother.
    expect(matchesInsider("Taneja Vaibhav", ["Musk Elon"])).toBe(false);
    expect(matchesInsider("Musk Kimbal", ["Musk Elon"])).toBe(false);
    expect(matchesInsider("Denholm Robyn M", ["Musk Elon"])).toBe(false);
    expect(matchesInsider("Musk Elon", [])).toBe(false);
  });

  it("reads the configured names off the mapping, and nothing from a malformed one", () => {
    expect(readInsiderNames({ insider_names: ["Musk Elon", " ", ""] })).toEqual(["Musk Elon"]);
    expect(readInsiderNames({ insider_names: "Musk Elon" })).toEqual([]);
    expect(readInsiderNames(undefined)).toEqual([]);
  });
});

describe("countArticles", () => {
  it("counts what fell inside the window by each item's own timestamp, so the count does not measure the poll's hour", () => {
    const articles = [
      { id: 1, datetime: hoursAgo(2) },
      { id: 2, datetime: hoursAgo(20) },
      { id: 3, datetime: hoursAgo(30) }, // outside a 24-hour window
      { id: 4, datetime: hoursAgo(-1) }, // stamped in the future
      { id: 5 },
    ];
    expect(countArticles(articles, NOW, 24)).toBe(2);
    expect(countArticles(articles, NOW, 48)).toBe(3);
  });

  it("counts one article once, however many times the feed repeats it", () => {
    const repeated = [{ id: 7, datetime: hoursAgo(1) }, { id: 7, datetime: hoursAgo(1) }, { id: 8, datetime: hoursAgo(1) }];
    expect(countArticles(repeated, NOW, 24)).toBe(2);
  });
});

describe("readInsiderFilings", () => {
  const names = ["Musk Elon"];

  it("keeps only the tracked person's filings, and only the codes that are a decision", () => {
    const rows = [
      line(),
      line({ name: "Taneja Vaibhav", change: -9_000 }),
      line({ transactionCode: "A", change: 300_000, filingDate: "2026-09-10" }), // award
      line({ transactionCode: "M", change: 100_000, filingDate: "2026-09-11" }), // option exercise
      line({ transactionCode: "F", change: -40_000, filingDate: "2026-09-12" }), // tax withholding
      line({ transactionCode: "G", change: -1_000_000, filingDate: "2026-09-13" }), // gift
    ];
    const filings = readInsiderFilings(rows, names, ["P", "S"]);
    expect(filings.map((filing) => [filing.code, filing.shares])).toEqual([["S", -500_000]]);
  });

  it("folds one Form 4's lines into one decision: five sales at five prices are one sale", () => {
    const rows = [
      line({ change: -100_000 }),
      line({ change: -150_000, transactionPrice: 422.1 }),
      line({ change: -250_000, transactionPrice: 423.9 }),
      line({ change: 40_000, transactionCode: "P", filingDate: "2026-09-17" }),
    ];
    const filings = readInsiderFilings(rows, names, ["P", "S"]);
    expect(filings.map((filing) => [filing.filedAt.toISOString().slice(0, 10), filing.code, filing.shares])).toEqual([
      ["2026-09-16", "S", -500_000],
      ["2026-09-17", "P", 40_000],
    ]);
  });

  it("drops a filing whose lines net to nothing, and one it cannot date", () => {
    expect(readInsiderFilings([line({ change: 100 }), line({ change: -100 })], names, ["P", "S"])).toEqual([]);
    expect(readInsiderFilings([line({ filingDate: null, transactionDate: null })], names, ["P", "S"])).toEqual([]);
    expect(readInsiderFilings([line({ change: 0 })], names, ["P", "S"])).toEqual([]);
  });
});

describe("insiderSignal", () => {
  it("says the direction and the share count, dated to the day it became public", () => {
    const [filing] = readInsiderFilings([line()], ["Musk Elon"], ["P", "S"]);
    const signal = insiderSignal(musk, SYMBOL, filing);
    expect(signal.headline).toBe("Elon Musk reported an open-market sale of 500,000 TSLA shares in a Form 4 filed 2026-09-16.");
    expect(signal.occurredAt.toISOString()).toBe("2026-09-16T00:00:00.000Z");
    expect(signal.dedupeKey).toBe("finnhub:insider:TSLA:2026-09-16:S");
    expect(signal.rawPayload).toMatchObject({ kind: "insider_filing", source: "finnhub", symbol: "TSLA", transaction_code: "S", direction: -1, shares: 500_000 });
    const purchase = insiderSignal(musk, SYMBOL, readInsiderFilings([line({ change: 250_000, transactionCode: "P" })], ["Musk Elon"], ["P", "S"])[0]);
    expect(purchase.headline).toBe("Elon Musk reported an open-market purchase of 250,000 TSLA shares in a Form 4 filed 2026-09-16.");
    expect(purchase.rawPayload).toMatchObject({ direction: 1, shares: 250_000 });
  });

  it("CARRIES NO PRICE: not the transaction price, not a dollar value, nothing a reader or the scorer could turn back into one", () => {
    const [filing] = readInsiderFilings([line(), line({ change: -150_000, transactionPrice: 422.1 })], ["Musk Elon"], ["P", "S"]);
    const signal = insiderSignal(musk, SYMBOL, filing);
    const serialised = `${signal.headline} ${JSON.stringify(signal.rawPayload)}`;
    for (const priced of [TRANSACTION_PRICE, 422.1, 500_000 * TRANSACTION_PRICE]) {
      expect(serialised, `carries ${priced}`).not.toContain(String(priced));
    }
    expect(serialised).not.toMatch(/price|\$|usd/i);
    expect(Object.keys(signal.rawPayload)).not.toContain("transactionPrice");
  });
});

describe("finnhubConnector", () => {
  const saved = process.env.FINNHUB_API_KEY;
  beforeEach(() => {
    process.env.FINNHUB_API_KEY = "test-key";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = saved;
  });

  it("is unavailable, with a reason, when the key is missing", () => {
    delete process.env.FINNHUB_API_KEY;
    expect(finnhubConnector.available?.()).toEqual({ ok: false, reason: "FINNHUB_API_KEY is not set" });
    process.env.FINNHUB_API_KEY = "test-key";
    expect(finnhubConnector.available?.()).toEqual({ ok: true });
  });

  it("counts the company's news as the metric that scores, and sends the key", async () => {
    const fetch = finnhubFetch({ articles: [{ id: 1, datetime: hoursAgo(1) }, { id: 2, datetime: hoursAgo(5) }, { id: 3, datetime: hoursAgo(40) }] });
    const ctx = context(fetch);
    const readings = await finnhubConnector.fetchMetrics?.(musk, SYMBOL, ctx);
    expect(readings?.find((reading) => reading.metricKey === COMPANY_NEWS_VOLUME_METRIC)).toEqual({ metricKey: COMPANY_NEWS_VOLUME_METRIC, value: 2 });
    expect(fetch.urls("/company-news")[0]).toContain("symbol=TSLA");
    expect(fetch.urls("/company-news")[0]).toContain("token=test-key");
  });

  it("NEVER stores a company headline: the count is the whole of what news contributes", async () => {
    const fetch = finnhubFetch({
      articles: [{ id: 1, datetime: hoursAgo(1), headline: "Tesla stock climbs 5% after delivery beat" }],
      insiders: [],
    });
    const ctx = context(fetch);
    const readings = (await finnhubConnector.fetchMetrics?.(musk, SYMBOL, ctx)) ?? [];
    const events = await finnhubConnector.fetchForPerson(musk, SYMBOL, ctx);
    expect(events).toEqual([]);
    expect(JSON.stringify(readings)).not.toContain("climbs");
  });

  it("returns the daily close as a reading the RUNNER makes observe-only, and reads it once a day", async () => {
    const fetch = finnhubFetch({ quote: { c: 430.1, pc: 425.5 } });
    const first = context(fetch);
    const readings = (await finnhubConnector.fetchMetrics?.(musk, SYMBOL, first)) ?? [];
    expect(readings.find((reading) => reading.metricKey === DAILY_CLOSE_METRIC)).toEqual({ metricKey: DAILY_CLOSE_METRIC, value: 425.5 });
    expect(fetch.urls("/quote")).toHaveLength(1);

    // Read three hours ago: not due, and no call is spent.
    const fresh = context(fetch, { latest: { [DAILY_CLOSE_METRIC]: { value: 425.5, recordedAt: new Date(NOW.getTime() - 3 * 3_600_000) } } });
    const again = (await finnhubConnector.fetchMetrics?.(musk, SYMBOL, fresh)) ?? [];
    expect(again.map((reading) => reading.metricKey)).toEqual([COMPANY_NEWS_VOLUME_METRIC]);
    expect(fetch.urls("/quote")).toHaveLength(1);

    // Yesterday: due again.
    const stale = context(fetch, { latest: { [DAILY_CLOSE_METRIC]: { value: 425.5, recordedAt: new Date(NOW.getTime() - 25 * 3_600_000) } } });
    await finnhubConnector.fetchMetrics?.(musk, SYMBOL, stale);
    expect(fetch.urls("/quote")).toHaveLength(2);
  });

  it("every price-derived key it can produce is exactly the observe-only list it declares", async () => {
    const fetch = finnhubFetch();
    const readings = (await finnhubConnector.fetchMetrics?.(musk, SYMBOL, context(fetch))) ?? [];
    const priced = new Set<string>(PRICE_DERIVED_METRICS);
    // Nothing it returns is priced except the keys it has declared as such; a
    // database test then asserts those are the source row's observe_only list.
    expect(readings.filter((reading) => priced.has(reading.metricKey)).map((reading) => reading.metricKey)).toEqual([DAILY_CLOSE_METRIC]);
    expect(readings.filter((reading) => !priced.has(reading.metricKey)).map((reading) => reading.metricKey)).toEqual([COMPANY_NEWS_VOLUME_METRIC]);
  });

  it("a failed quote never costs the count: the figure that contributes nothing cannot silence the one that does", async () => {
    const fetch = finnhubFetch({ quoteStatus: 500, articles: [{ id: 1, datetime: hoursAgo(2) }] });
    const ctx = context(fetch);
    const readings = (await finnhubConnector.fetchMetrics?.(musk, SYMBOL, ctx)) ?? [];
    expect(readings).toEqual([{ metricKey: COMPANY_NEWS_VOLUME_METRIC, value: 1 }]);
    expect(ctx.notes).toEqual([expect.stringMatching(/quote for TSLA failed .*the company-news count was unaffected/)]);
    // A quote with no previous close is the same shape of non-event.
    const empty = context(finnhubFetch({ quote: { c: 430.1 } }));
    expect(((await finnhubConnector.fetchMetrics?.(musk, SYMBOL, empty)) ?? []).map((r) => r.metricKey)).toEqual([COMPANY_NEWS_VOLUME_METRIC]);
    expect(empty.notes[0]).toMatch(/carried no previous close/);
  });

  it("fails loudly when the company-news read itself fails or answers with the wrong shape", async () => {
    await expect(finnhubConnector.fetchMetrics?.(musk, SYMBOL, context(finnhubFetch({ newsStatus: 429 })))).rejects.toThrow(/Finnhub responded 429 for \/company-news/);
    await expect(finnhubConnector.fetchMetrics?.(musk, SYMBOL, context(finnhubFetch({ newsBody: { error: "nope" } })))).rejects.toThrow(/rather than an array of articles/);
  });

  it("turns the tracked person's filings into events and asks for the configured window", async () => {
    const fetch = finnhubFetch({ insiders: [line(), line({ name: "Taneja Vaibhav", change: -9_000 })] });
    const events = await finnhubConnector.fetchForPerson(musk, SYMBOL, context(fetch));
    expect(events).toHaveLength(1);
    expect(events[0].headline).toContain("500,000 TSLA shares");
    // 45 days back from 2026-09-18.
    expect(fetch.urls("/stock/insider-transactions")[0]).toContain("from=2026-08-04&to=2026-09-18");
  });

  it("attributes nothing when the mapping names no insider, and says so instead", async () => {
    const fetch = finnhubFetch({ insiders: [line({ name: "Taneja Vaibhav" })] });
    const ctx = context(fetch, { personConfig: {} });
    expect(await finnhubConnector.fetchForPerson(musk, SYMBOL, ctx)).toEqual([]);
    expect(ctx.notes).toEqual([expect.stringMatching(/no config\.insider_names on the elon-musk mapping/)]);
    // And it did not spend a call guessing.
    expect(fetch.urls("/stock/insider-transactions")).toEqual([]);
  });

  it("refuses an empty ticker", async () => {
    await expect(finnhubConnector.fetchMetrics?.(musk, "  ", context(finnhubFetch()))).rejects.toThrow(/No ticker configured for elon-musk/);
  });
});
