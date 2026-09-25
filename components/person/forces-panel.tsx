import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
import { formatCents } from "@/lib/money";
import {
  FORCES_WINDOW_MINUTES,
  FORCE_IMPACT_DECIMALS,
  forcesWindowLabel,
  formatSigned,
  type ForceReading,
  type MarketReadings,
  type PersonProfile,
} from "@/lib/person/profile-model";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";

/**
 * The five forces over the last hour: name, what it measures, and how many
 * points it added to the score across the span, drawn as a diverging bar from
 * a centre line. Monochrome except the bar and the figure, which take the
 * colour of their direction. A force the Engine has never run shows as present
 * and idle; a force that ran and did nothing shows a flat zero.
 *
 * The span is FORCES_WINDOW_MINUTES and both the caption and the header say
 * so, because a figure and the words beside it must describe the same thing:
 * this panel read the latest TICK until Phase 21, and a tick of Gravity or
 * Market Mood is too small to render at two decimals.
 *
 * TWO OF THE FIVE MOVE THE MARKET PRICE (Phase 29). Conviction and Trading
 * Activity read participant activity, and nothing derived from participant
 * activity may feed the index, so they add exactly nothing to the score. A
 * points figure of 0.00 would be true and useless; instead each shows what
 * it reads — how much of the allocation cap is committed, the net flow over
 * the hour — with a MARKET tag, and the caption says which is which.
 */
export interface ForcesPanelProps {
  forces: ForceReading[];
  /** What the two market forces read right now. */
  market: MarketReadings;
  latestTick: PersonProfile["latestTick"];
  className?: string;
}

const fillTones = {
  heating: "bg-positive",
  cooling: "bg-negative",
  neutral: "bg-neutral",
} as const;

const figureTones = {
  heating: "text-positive",
  cooling: "text-negative",
  neutral: "text-fg-muted",
} as const;

/** Bars are scaled to the strongest score force in the window, never below one point, so a quiet hour stays quiet. */
function barScale(forces: ForceReading[]): number {
  return Math.max(1, ...forces.filter((force) => force.role === "score").map((force) => Math.abs(force.impact ?? 0)));
}

/** The market reading for a market force, as the figure and the line under it. */
export function marketReadingText(force: ForceReading, market: MarketReadings): { figure: string; detail: string } {
  if (force.key === "conviction") {
    const concentration = market.conviction.concentration;
    if (concentration === null) return { figure: "—", detail: "no allocation cap" };
    return { figure: `${Math.round(Math.min(1, Math.max(0, concentration)) * 100)}%`, detail: "of the allocation cap committed" };
  }
  const { netFlowCents, trades, windowMinutes } = market.tradingActivity;
  const span = forcesWindowLabel(windowMinutes);
  if (trades === 0) return { figure: "—", detail: `no trades in the last ${span}` };
  const sign = netFlowCents > 0 ? "+" : netFlowCents < 0 ? "−" : "";
  return { figure: `${sign}${formatCents(Math.abs(netFlowCents))}`, detail: `net flow · ${trades} ${trades === 1 ? "trade" : "trades"} in the last ${span}` };
}

export function ForcesPanel({ forces, market, latestTick, className }: ForcesPanelProps) {
  const scale = barScale(forces);
  const span = forcesWindowLabel(FORCES_WINDOW_MINUTES);

  return (
    <section aria-labelledby="forces-heading" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader
        title="The five forces"
        meta={
          latestTick ? (
            <>
              Last {span} · ticked{" "}
              <time dateTime={latestTick.at} className="num">
                {relativeTime(latestTick.at)}
              </time>
            </>
          ) : (
            <Badge tone="warning" dot>
              Idle
            </Badge>
          )
        }
      />
      <h2 id="forces-heading" className="sr-only">
        The five forces
      </h2>

      <Card className="divide-y divide-line">
        {forces.map((force) => (force.role === "market" ? <MarketRow key={force.key} force={force} market={market} idle={latestTick === null} /> : <ForceRow key={force.key} force={force} scale={scale} />))}
      </Card>

      <p className="px-1 text-xs text-fg-faint">
        Points each score force added to the Momentum Score over the last {span}. Positive lifts the score, negative lowers it. Conviction and Trading Activity
        move the <span className="text-fg-muted">market price</span>, not the score: they show what they read.
      </p>
    </section>
  );
}

function ForceRow({ force, scale }: { force: ForceReading; scale: number }) {
  const idle = force.impact === null;
  const magnitude = idle ? 0 : Math.min(1, Math.abs(force.impact ?? 0) / scale);
  const halfWidth = `${(magnitude * 50).toFixed(2)}%`;

  return (
    <div className="flex items-center gap-4 px-5 py-4 sm:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cn("text-sm font-medium", idle ? "text-fg-muted" : "text-fg")}>{force.label}</p>
        <p className="truncate text-xs text-fg-muted">{force.description}</p>
      </div>

      <div className="relative hidden h-1.5 w-40 shrink-0 rounded-full bg-surface-raised sm:block lg:w-48" aria-hidden>
        <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-line-strong" />
        {magnitude > 0 ? (
          <span
            className={cn("absolute top-0 h-full rounded-full", fillTones[force.direction])}
            style={force.direction === "cooling" ? { right: "50%", width: halfWidth } : { left: "50%", width: halfWidth }}
          />
        ) : null}
      </div>

      <div className="w-16 shrink-0 text-right">
        {idle ? (
          <span className="text-label text-fg-faint">Idle</span>
        ) : (
          <span className={cn("num text-sm font-medium", figureTones[force.direction])}>{formatSigned(force.impact ?? 0, FORCE_IMPACT_DECIMALS)}</span>
        )}
      </div>
    </div>
  );
}

/** A market force: no bar, no points; the reading and the word MARKET where the figure would be. */
function MarketRow({ force, market, idle }: { force: ForceReading; market: MarketReadings; idle: boolean }) {
  const reading = marketReadingText(force, market);
  return (
    <div className="flex items-center gap-4 px-5 py-4 sm:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cn("flex items-center gap-2 text-sm font-medium", idle ? "text-fg-muted" : "text-fg")}>
          {force.label}
          <Badge tone="outline" className="h-5 px-2 text-2xs uppercase tracking-wide">
            Market
          </Badge>
        </p>
        <p className="truncate text-xs text-fg-muted">{force.description}</p>
      </div>

      <div className="flex min-w-0 shrink-0 flex-col items-end gap-0.5 text-right">
        <span className={cn("num text-sm font-medium", reading.figure === "—" ? "text-fg-faint" : "text-fg-secondary")}>{reading.figure}</span>
        <span className="hidden max-w-56 truncate text-2xs text-fg-faint sm:block">{reading.detail}</span>
      </div>
    </div>
  );
}
