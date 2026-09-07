/** Number formatting helpers for human-readable signal headlines. */

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const integerFormatter = new Intl.NumberFormat("en-US");

/** 516000000 -> "516M", 45100000 -> "45.1M", 2310000000 -> "2.31B". */
export function formatCompactNumber(value: number): string {
  return compactFormatter.format(value);
}

/** 1234567 -> "1,234,567". */
export function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

/** 0.0052 -> "+0.52%", -0.031 -> "-3.1%". */
export function formatSignedPercent(ratio: number): string {
  const percent = ratio * 100;
  const digits = Math.abs(percent) < 1 ? 2 : 1;
  const sign = percent > 0 ? "+" : "";
  return `${sign}${percent.toFixed(digits)}%`;
}

/** ["a"] -> "a", ["a","b"] -> "a and b", ["a","b","c"] -> "a, b and c". */
export function joinNaturally(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
