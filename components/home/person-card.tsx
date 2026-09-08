"use client";

import Link from "next/link";

import { cn } from "@/lib/cn";
import { categoryLabel, type BoardPerson } from "@/lib/home/board-model";
import { Avatar } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { DirectionIndicator } from "@/components/ui/direction-indicator";
import { ScoreDisplay } from "@/components/ui/score-display";

import { Sparkline } from "./sparkline";

/**
 * The two ways a person appears on Home.
 *
 * `PersonCard` is the featured treatment at the top of the board; `PersonRow`
 * is the dense ranked list beneath it. Both carry `data-person-id` so the
 * impression observer can find them, and both route to the person's page.
 *
 * Colour discipline: the score is plain white and the sparkline is grey. The
 * direction indicator is the only element on either that may be green or red.
 */

export interface PersonCardProps {
  person: BoardPerson;
  /** Fired on tap so the board can log the interaction. */
  onOpen?: (person: BoardPerson) => void;
}

export function PersonCard({ person, onOpen }: PersonCardProps) {
  return (
    <Link
      href={`/person/${person.slug}`}
      data-person-id={person.id}
      onClick={() => onOpen?.(person)}
      aria-label={`${person.displayName}, momentum score ${person.score.toFixed(1)}`}
      className="rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Card interactive className="flex h-full flex-col gap-5 p-5">
        <div className="flex items-start justify-between gap-3">
          <Avatar name={person.displayName} src={person.avatarUrl} size="md" />
          <span className="num text-sm text-fg-faint">#{person.rank}</span>
        </div>

        <div className="flex flex-col gap-0.5">
          <p className="truncate font-semibold tracking-tight text-fg">{person.displayName}</p>
          <p className="text-sm text-fg-muted">{categoryLabel(person.category)}</p>
        </div>

        <div className="mt-auto flex flex-col gap-3">
          <ScoreDisplay score={person.score} change={person.change} size="lg" />
          <Sparkline points={person.sparkline} className="h-6 w-full" />
        </div>
      </Card>
    </Link>
  );
}

export function PersonRow({ person, onOpen }: PersonCardProps) {
  return (
    <Link
      href={`/person/${person.slug}`}
      data-person-id={person.id}
      onClick={() => onOpen?.(person)}
      aria-label={`${person.displayName}, momentum score ${person.score.toFixed(1)}`}
      className={cn(
        "flex items-center gap-4 px-5 py-4 transition-colors first:rounded-t-2xl last:rounded-b-2xl",
        "hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
      )}
    >
      <span className="num w-6 shrink-0 text-sm text-fg-faint">{person.rank}</span>
      <Avatar name={person.displayName} src={person.avatarUrl} size="md" />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate font-medium text-fg">{person.displayName}</p>
        <p className="truncate text-sm text-fg-muted">{categoryLabel(person.category)}</p>
      </div>

      <Sparkline points={person.sparkline} className="hidden h-6 w-24 sm:block" />

      <div className="flex shrink-0 flex-col items-end gap-1">
        <ScoreDisplay score={person.score} size="sm" />
        <DirectionIndicator change={person.change} size="sm" />
      </div>
    </Link>
  );
}
