/** Compact age stamp for feed items: "now", "3m", "2h", "5d". */
export function relativeTime(timestamp: string, now: number = Date.now()): string {
  const elapsed = now - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 0) return "now";

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  return `${Math.floor(hours / 24)}d`;
}
