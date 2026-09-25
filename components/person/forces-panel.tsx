import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
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
 * The five forces over the last hour, in two groups (Phase 29c): MOVING THE
 * SCORE — Gravity, Signals, Market Mood — each with how many points it added
 * to the score across the span, drawn as a diverging bar from a centre line;
 * and MOVING THE MARKET — Trading Activity, Conviction — each with what it
 * reads. Monochrome except the score bars and figures, which take the colour
 * of their direction. A force the Engine has never run shows as present and
 * idle; a force that ran and did nothing shows a flat zero.
 *
 * The span is FORCES_WINDOW_MINUTES and both the caption and the header say
 * so, because a figure and the words beside it must describe the same thing:
 * this panel read the latest TICK until Phase 21, and a tick of Gravity or
 * Market Mood is too small to render at two decimals.
 *
 * THE MARKET FORCES ADD NOTHING TO THE SCORE (Phase 29). They read
 * participant activity, and nothing derived from participant activity may
 * feed the index. A points figure of 0.00 would be true and useless; instead
 * each shows what it reads, in the words the code earns:
 *
 *   Trading Activity  the hour's buying and selling. Buys push the premium up
 *                     and sells push it down (lib/trading/market.ts), so the
 *                     flow is what moves the market price — on a curved
 *                     market. On a flat one the market price is the score.
 *   Conviction        open capital over the allocation cap. It does not move
 *                     the market price: it is one of the inputs that TIGHTEN
 *                     the spread (lib/engine/spread.ts), never widen it.
 *
 * forces-panel.test.ts holds every one of those sentences to the code.
 */
export interface ForcesPanelProps {
  forces: ForceReading[];
  /** What the two market forces read right now. */
  market: MarketReadings;
  latestTick: PersonProfile["latestTick"];
  /** Whether the person's market walks a curve (a depth resolves). False on a flat market, where trading does not move the market price. */
  curved: boolean;
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

/** The two groups, in the order the panel draws them. */
export const FORCE_GROUPS = [
  { role: "score", title: "Moving the score" },
  { role: "market", title: "Moving the market" },
] as const satisfies readonly { role: ForceReading["role"]; title: string }[];

/** Within "Moving the market", Trading Activity first: it is the one that moves the price. */
const MARKET_ORDER: Record<string, number> = { trading_activity: 0, conviction: 1 };

export function forcesInGroup(forces: ForceReading[], role: ForceReading["role"]): ForceReading[] {
  const members = forces.filter((force) => force.role === role);
  return role === "market" ? [...members].sort((a, b) => (MARKET_ORDER[a.key] ?? 9) - (MARKET_ORDER[b.key] ?? 9)) : members;
}

/** The line under a force's name. On a flat market Trading Activity says what the code does there: nothing to the price. */
export function forceDescription(force: Pick<ForceReading, "key" | "description">, curved: boolean): string {
  if (force.key === "trading_activity" && !curved) return "Buy and sell flow · the market price stays at the score";
  return force.description;
}

/** Bars are scaled to the strongest score force in the window, never below one point, so a quiet hour stays quiet. */
function barScale(forces: ForceReading[]): number {
  return Math.max(1, ...forces.filter((force) => force.role === "score").map((force) => Math.abs(force.impact ?? 0)));
}

/** A dollar volume the way the panel says it: whole dollars once there are any, cents only when they carry the amount. */
export function formatVolume(cents: number): string {
  const whole = cents >= 1_000 || cents % 100 === 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(
    whole ? Math.round(cents / 100) : cents / 100,
  );
}

/**
 * The larger side's share of the volume, as a whole percentage that never
 * rounds the other side away: 99.6% buying with one sell reads 99%, not 100%.
 */
function majorityPercent(major: number, minor: number): number {
  const percent = Math.round((major / (major + minor)) * 100);
  return minor > 0 ? Math.min(99, percent) : percent;
}

/** A market force's reading: one phrase, in the sheet's sentence type (Inter, tabular figures). `quiet` when there is nothing to read. */
export function marketReadingText(force: Pick<ForceReading, "key">, market: MarketReadings): { text: string; quiet: boolean } {
  if (force.key === "conviction") {
    const { concentration, openCapitalCents } = market.conviction;
    if (concentration === null) return { text: "No allocation cap", quiet: true };
    if (openCapitalCents <= 0) return { text: "Nothing committed", quiet: true };
    return { text: `${Math.max(1, Math.round(Math.min(1, Math.max(0, concentration)) * 100))}% of cap committed`, quiet: false };
  }
  const { buyCents, sellCents, trades, windowMinutes } = market.tradingActivity;
  const span = forcesWindowLabel(windowMinutes);
  if (trades === 0 || buyCents + sellCents <= 0) return { text: span === "hour" ? "No trades this hour" : `No trades in the last ${span}`, quiet: true };
  const split = buyCents >= sellCents ? `${majorityPercent(buyCents, sellCents)}% buying` : `${majorityPercent(sellCents, buyCents)}% selling`;
  return { text: `${split} · ${formatVolume(buyCents + sellCents)} traded`, quiet: false };
}

/** The caption under the panel: what each group's figures are, and what each market force does — no more than the code does. */
export function forcesFootnote(span: string, curved: boolean): string[] {
  return [
    `Moving the score: the points each force added to the Momentum Score over the last ${span}. Positive lifts it, negative lowers it.`,
    curved
      ? `Moving the market: trading never touches the score. The ${span}’s buying pushes the market price up and selling pushes it down; capital held open tightens the spread.`
      : `Moving the market: trading never touches the score, and on this market it does not move the price either, which stays at the score. Capital held open tightens the spread.`,
  ];
}

export function ForcesPanel({ forces, market, latestTick, curved, className }: ForcesPanelProps) {
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

      {FORCE_GROUPS.map((group) => (
        <div key={group.role} className="flex flex-col gap-2">
          <h3 className="px-1 text-sm font-medium text-fg-secondary">{group.title}</h3>
          <Card className="divide-y divide-line">
            {forcesInGroup(forces, group.role).map((force) =>
              force.role === "market" ? (
                <MarketRow key={force.key} force={force} market={market} curved={curved} idle={latestTick === null} />
              ) : (
                <ForceRow key={force.key} force={force} scale={scale} />
              ),
            )}
          </Card>
        </div>
      ))}

      <div className="flex flex-col gap-1.5 px-1 text-xs text-fg-faint">
        {forcesFootnote(span, curved).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
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

/**
 * A market force: no bar, no points. The name and the reading share the top
 * line and the description runs the full width beneath, so on a phone neither
 * is cut: the reading is a phrase, and it needs the room a figure does not.
 */
function MarketRow({ force, market, curved, idle }: { force: ForceReading; market: MarketReadings; curved: boolean; idle: boolean }) {
  const reading = marketReadingText(force, market);
  return (
    <div className="flex flex-col gap-0.5 px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <p className={cn("text-sm font-medium", idle ? "text-fg-muted" : "text-fg")}>{force.label}</p>
        <span className={cn("text-sm font-medium tabular-nums", reading.quiet ? "text-fg-faint" : "text-fg-secondary")}>{reading.text}</span>
      </div>
      <p className="text-xs text-fg-muted">{forceDescription(force, curved)}</p>
    </div>
  );
}
