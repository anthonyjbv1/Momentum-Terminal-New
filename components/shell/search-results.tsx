"use client";

import { cn } from "@/lib/cn";
import { categoryLabel } from "@/lib/home/board-model";
import type { SearchResult } from "@/lib/search/search-model";
import { Avatar } from "@/components/ui/avatar";
import { DirectionIndicator } from "@/components/ui/direction-indicator";
import { ScoreDisplay } from "@/components/ui/score-display";

/**
 * What a search result looks like, and what the sheet says when there is
 * nothing to show.
 *
 * The row follows the board's own row (components/home/person-card.tsx): the
 * same avatar, the same name-over-category stack, the same score on the right
 * with the direction read beneath it. Someone who has scrolled Home should
 * recognise this as the same object, found a different way. Colour discipline
 * is unchanged — the direction indicator is the only thing here that may be
 * green or red.
 *
 * It is a button rather than a link on purpose: the sheet closes and routes
 * itself, so the keyboard path (arrow keys, Enter) and the tap path end in
 * exactly the same call.
 */

export interface SearchResultRowProps {
  person: SearchResult;
  id: string;
  active: boolean;
  onActivate: () => void;
  onHover: () => void;
}

export function SearchResultRow({ person, id, active, onActivate, onHover }: SearchResultRowProps) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onClick={onActivate}
      onMouseMove={onHover}
      className={cn(
        // min-h-16: a thumb-sized target on mobile, where this list is reached
        // by tapping rather than by arrow key.
        "flex min-h-16 w-full items-center gap-4 px-5 py-3.5 text-left transition-colors",
        "first:rounded-t-2xl last:rounded-b-2xl focus-visible:outline-none",
        active && "bg-surface-raised",
      )}
    >
      <Avatar name={person.displayName} src={person.avatarUrl} size="md" />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate font-medium text-fg">{person.displayName}</p>
        <p className="truncate text-sm text-fg-muted">{categoryLabel(person.category)}</p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <ScoreDisplay score={person.score} size="sm" />
        <DirectionIndicator change={person.change} size="sm" />
      </div>
    </button>
  );
}

/** The empty, no-result and failure states: a line that leads, a line that explains. */
export function SearchMessage({ title, body, className }: { title: string; body: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 px-1 py-6", className)}>
      <p className="text-base font-medium text-fg">{title}</p>
      <p className="max-w-prose text-sm leading-relaxed text-fg-muted">{body}</p>
    </div>
  );
}
