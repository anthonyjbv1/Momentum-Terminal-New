import Link from "next/link";

import type { RosterPerson } from "@/lib/feed/feed";
import { Avatar } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";

/**
 * The Feed before anything has crossed the wire: a system at rest, with the
 * people it is tracking. This is the state the page ships in, so it has to
 * read as intentional, not broken.
 */
export function FeedEmpty({ roster }: { roster: RosterPerson[] }) {
  return (
    <Card tone="ghost" className="px-6 py-14 sm:py-20">
      <div className="mx-auto flex max-w-md flex-col items-center gap-7 text-center">
        <div className="flex flex-col items-center gap-3">
          <p className="text-label text-fg-muted">The wire</p>
          <h2 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">Quiet on the wire.</h2>
          <p className="text-base leading-relaxed text-fg-muted">
            Nothing has come through yet. Once ingestion runs, every signal the Engine reads and every move it explains lands here, newest first,
            across everyone on the board.
          </p>
        </div>

        {roster.length > 0 ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-xs text-fg-faint">
              On the board <span className="text-fg-muted">·</span> <span className="num">{roster.length}</span> people
            </p>
            <div className="flex max-w-xs flex-wrap justify-center gap-2">
              {roster.map((person) => (
                <Link
                  key={person.id}
                  href={`/person/${person.slug}`}
                  title={person.name}
                  aria-label={person.name}
                  className="rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <Avatar name={person.name} src={person.avatarUrl} size="sm" />
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
