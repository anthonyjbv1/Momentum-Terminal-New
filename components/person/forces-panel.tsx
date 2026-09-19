import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/home/relative-time";
import { FORCES_WINDOW_MINUTES, FORCE_IMPACT_DECIMALS, forcesWindowLabel, formatSigned, type ForceReading, type PersonProfile } from "@/lib/person/profile-model";
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
 */
export interface ForcesPanelProps {
  forces: ForceReading[];
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

/** Bars are scaled to the strongest force in the window, never below one point, so a quiet hour stays quiet. */
function barScale(forces: ForceReading[]): number {
  return Math.max(1, ...forces.map((force) => Math.abs(force.impact ?? 0)));
}

export function ForcesPanel({ forces, latestTick, className }: ForcesPanelProps) {
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
        {forces.map((force) => (
          <ForceRow key={force.key} force={force} scale={scale} />
        ))}
      </Card>

      <p className="px-1 text-xs text-fg-faint">Points each force added to the score over the last {span}. Positive lifts the score, negative lowers it.</p>
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
