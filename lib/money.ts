/**
 * Money helpers. Every amount in the database is an integer number of cents
 * (bigint). These helpers exist so that display code never does its own
 * floating-point arithmetic.
 */

/** 100000 -> "$1,000.00". Display only; never store the result. */
export function formatCents(cents: number | bigint, currency = "USD", locale = "en-US"): string {
  const value = typeof cents === "bigint" ? Number(cents) : cents;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Amount is not an integer number of cents: ${String(cents)}`);
  }

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

/** "12.34" -> 1234. Throws on anything that is not a plain decimal amount. */
export function parseDollarsToCents(input: string): number {
  const match = /^\s*(-)?\$?(\d+)(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!match) throw new Error(`Invalid amount: ${input}`);
  const [, sign, dollars, fraction = ""] = match;
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  return sign ? -cents : cents;
}
