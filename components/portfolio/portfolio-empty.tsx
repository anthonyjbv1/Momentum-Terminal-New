import Link from "next/link";

import type { RosterPerson } from "@/lib/feed/feed";
import { formatCents } from "@/lib/money";
import { Avatar } from "@/components/ui/avatar";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * The portfolio before a first trade: the state most beta users see first.
 * The paper credit is real and ready; the page says what it will hold, and
 * points at Home and the Feed, where a first position starts. Not a shrug.
 */
export function PortfolioEmpty({ roster, cashCents }: { roster: RosterPerson[]; cashCents: number }) {
  return (
    <Card tone="ghost" className="px-6 py-14 sm:py-20">
      <div className="mx-auto flex max-w-md flex-col items-center gap-7 text-center">
        <div className="flex flex-col items-center gap-3">
          <p className="text-label text-fg-muted">Your portfolio</p>
          <h2 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">Nothing held yet.</h2>
          <p className="text-base leading-relaxed text-fg-muted">
            Your <span className="num text-fg-secondary">{formatCents(cashCents)}</span> of paper credit is ready. Pick a person on Home, or follow the Feed to see who is
            moving, and take a position with Buy. Everything you hold and every trade you make lands here, marked at the Sell quote, tick by tick.
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/" className={buttonClassName("primary", "md")}>
            Go to Home
          </Link>
          <Link href="/feed" className={buttonClassName("outline", "md")}>
            Read the Feed
          </Link>
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
