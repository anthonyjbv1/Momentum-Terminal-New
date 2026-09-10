import Link from "next/link";

import { categoryLabel, type HomeBoard } from "@/lib/home/board-model";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DirectionIndicator } from "@/components/ui/direction-indicator";
import { SectionHeader } from "@/components/ui/page-header";
import { ScoreDisplay } from "@/components/ui/score-display";

/**
 * The Feed's desktop rail: a glance at the board while you scroll the wire.
 * The four biggest movers of the last hour (or, before the Engine's first
 * tick, the top of the ranking), each a link to its person. Reads what Home
 * reads; shows less of it.
 */
export function BoardGlance({ board }: { board: HomeBoard }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={board.hasMovement ? "Top movers" : "Leading the board"}
        meta={
          board.hasMovement ? (
            "Last hour"
          ) : (
            <Badge tone="warning" dot>
              Awaiting first tick
            </Badge>
          )
        }
      />

      <Card className="flex flex-col divide-y divide-line">
        {board.movers.map((person) => (
          <Link
            key={person.id}
            href={`/person/${person.slug}`}
            className="flex items-center gap-3 px-5 py-3.5 transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
          >
            <span className="num w-5 shrink-0 text-xs text-fg-faint">{person.rank}</span>
            <Avatar name={person.displayName} src={person.avatarUrl} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-fg">{person.displayName}</span>
              <span className="truncate text-xs text-fg-muted">{categoryLabel(person.category)}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-0.5">
              <ScoreDisplay score={person.score} size="sm" />
              <DirectionIndicator change={person.change} size="sm" />
            </span>
          </Link>
        ))}
      </Card>

      <Link href="/" className="px-1 text-xs text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline">
        See the whole board
      </Link>
    </div>
  );
}
