/**
 * THE FALLBACK WARNING (2026-10-09), for the health check. A tick that could
 * not reach the model scores its signals by the rules fallback and commits
 * them: a real answer, and a quiet one. On 2026-10-09 every sentiment call
 * failed from 17:16 to 17:46 UTC ("Your credit balance is too low") and
 * thirteen signals were scored by the rules before anyone noticed. The
 * health check now says so, per tick, with the provider's reason from the
 * usage ledger. Pure; the route feeds it the recent ticks and the failed
 * calls recorded against them.
 */

export interface TickScoringRow {
  tickNumber: number;
  startedAt: string;
  /** engine_ticks.summary.scoring, as the tick wrote it. */
  scoring: { fallbacks?: number; llmScored?: number; llmCalls?: number; attempted?: number } | null;
}

export interface FailedCallRow {
  tickNumber: number | null;
  error: string | null;
}

export interface FallbackTick {
  tickNumber: number;
  startedAt: string;
  fallbacks: number;
  llmScored: number;
  reasons: string[];
}

const REASON_MAX = 160;

/** The reason as the ledger recorded it, trimmed to one line; a JSON body is cut at its message where it can be. */
export function fallbackReason(error: string | null): string {
  const text = (error ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "no reason recorded";
  const message = /"message"\s*:\s*"([^"]+)"/.exec(text);
  const head = text.split(":")[0].trim();
  const reason = message ? `${head}: ${message[1]}` : text;
  return reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason;
}

export function fallbackStatus(ticks: TickScoringRow[], failures: FailedCallRow[]): { ticks: FallbackTick[]; warnings: string[] } {
  const reasonsByTick = new Map<number, Set<string>>();
  for (const failure of failures) {
    if (failure.tickNumber === null) continue;
    const set = reasonsByTick.get(failure.tickNumber) ?? new Set<string>();
    set.add(fallbackReason(failure.error));
    reasonsByTick.set(failure.tickNumber, set);
  }
  const fallbackTicks: FallbackTick[] = ticks
    .filter((tick) => (tick.scoring?.fallbacks ?? 0) > 0)
    .map((tick) => ({ tickNumber: tick.tickNumber, startedAt: tick.startedAt, fallbacks: tick.scoring?.fallbacks ?? 0, llmScored: tick.scoring?.llmScored ?? 0, reasons: [...(reasonsByTick.get(tick.tickNumber) ?? [])] }))
    .sort((a, b) => b.tickNumber - a.tickNumber);
  const warnings = fallbackTicks.map((tick) => {
    const reasons = tick.reasons.length > 0 ? tick.reasons.join("; ") : "no failed call recorded for the tick (the model omitted the signal, or the response did not match the schema)";
    return `tick ${tick.tickNumber} (${tick.startedAt}): ${tick.fallbacks} signal${tick.fallbacks === 1 ? "" : "s"} scored by the rules fallback instead of the model (${tick.llmScored} by the model); ${reasons}`;
  });
  if (fallbackTicks.length > 1) {
    const total = fallbackTicks.reduce((sum, tick) => sum + tick.fallbacks, 0);
    warnings.unshift(`${fallbackTicks.length} of the last ${ticks.length} scoring ticks fell back to the rules scorer (${total} signals); the model was not reached`);
  }
  return { ticks: fallbackTicks, warnings };
}
