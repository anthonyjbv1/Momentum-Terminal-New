/**
 * THE COMPANY BEHIND A TICKER (Phase 30).
 *
 * A company-news signal names the company — "Tesla is in the news more than
 * usual" — never "Elon Musk's company". The Finnhub mapping stores the ticker
 * the connector polls (`person_data_sources.external_identifier`) and nothing
 * else, so the name is resolved here, from the ticker, in code. Display only:
 * nothing about what is polled or scored reads this table.
 *
 * `lib/people/company.db.test.ts` reads the seeded mappings and fails if an
 * active Finnhub mapping's ticker has no row here, so a new executive cannot
 * reach the Feed as "X's company".
 */
export const COMPANY_BY_TICKER: Readonly<Record<string, string>> = {
  TSLA: "Tesla",
  AMZN: "Amazon",
  NVDA: "Nvidia",
  ORCL: "Oracle",
  GOOGL: "Alphabet",
  GOOG: "Alphabet",
  META: "Meta",
  DELL: "Dell Technologies",
  "BRK.B": "Berkshire Hathaway",
  "BRK.A": "Berkshire Hathaway",
  "BRK-B": "Berkshire Hathaway",
  "BRK-A": "Berkshire Hathaway",
};

/** The company a ticker names, or null when the table does not know it. Case and surrounding space are forgiven. */
export function companyForTicker(ticker: string | null | undefined): string | null {
  if (!ticker) return null;
  return COMPANY_BY_TICKER[ticker.trim().toUpperCase()] ?? null;
}
