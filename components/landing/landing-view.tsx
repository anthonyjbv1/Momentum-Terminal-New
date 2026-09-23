import { HERO, WAITLIST } from "@/lib/landing/copy";
import type { FeaturedPayload } from "@/lib/landing/model";

import { HowItWorks } from "./how-it-works";
import { LandingFooter } from "./landing-footer";
import { LandingHeader } from "./landing-header";
import { LiveScore } from "./live-score";
import { FeaturedProvider } from "./use-featured";
import { WaitlistForm } from "./waitlist-form";
import { WhyItMoved } from "./why-it-moved";

/**
 * THE LANDING PAGE, top to bottom.
 *
 * One idea above the fold: a real Momentum Score, moving. The headline says
 * what it is, the number shows it, and one field asks for one thing. Below
 * the fold, three beats on how it works, the reading behind the number, and
 * the field again for a reader who needed the whole page.
 *
 * Mobile first: a single column on a phone with the score at display size;
 * two columns from the md breakpoint with the words on the left and the
 * number on the right, so on a wide screen the eye lands on the figure.
 */
export interface LandingViewProps {
  initial: FeaturedPayload | null;
  renderedAt: number;
  /** For harnesses: where the browser re-reads the score from. */
  endpoint?: string;
}

export function LandingView({ initial, renderedAt, endpoint }: LandingViewProps) {
  return (
    <FeaturedProvider initial={initial} renderedAt={renderedAt} endpoint={endpoint}>
      <div className="flex min-h-dvh flex-col bg-canvas text-fg">
        <LandingHeader />

        <main className="mx-auto flex w-full max-w-shell flex-1 flex-col gap-20 px-5 pb-20 pt-6 sm:px-8 sm:pt-12 md:gap-28">
          {/*
            On a phone the order is headline, THE NUMBER, then the words and the
            field, so the live score is above the fold at 375x667; from md the
            words take the left column and the number the right.
          */}
          <section aria-labelledby="hero-heading" className="grid gap-8 md:grid-cols-2 md:items-start md:gap-x-16 md:gap-y-6">
            <div className="flex flex-col gap-5 md:col-start-1 md:row-start-1">
              <p className="text-label text-fg-muted">{HERO.eyebrow}</p>
              <h1 id="hero-heading" className="text-4xl font-semibold leading-tight tracking-tight text-fg sm:text-5xl">
                {HERO.headline}
              </h1>
            </div>
            <div className="rounded-3xl border border-line p-5 sm:p-8 md:col-start-2 md:row-span-2 md:row-start-1 md:self-center">
              <LiveScore />
            </div>
            <div className="flex flex-col gap-6 md:col-start-1 md:row-start-2">
              <p className="max-w-prose text-base leading-relaxed text-fg-secondary sm:text-lg">{HERO.sub}</p>
              <WaitlistForm source="landing_hero" className="max-w-md" />
              <p className="text-sm text-fg-muted">{HERO.paper}</p>
            </div>
          </section>

          <HowItWorks />

          <WhyItMoved />

          <section aria-labelledby="join-heading" className="flex flex-col gap-6 border-t border-line pt-16">
            <div className="flex flex-col gap-3">
              <h2 id="join-heading" className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                {WAITLIST.title}
              </h2>
              <p className="max-w-prose text-base leading-relaxed text-fg-secondary">{WAITLIST.body}</p>
            </div>
            <WaitlistForm source="landing_footer" className="max-w-md" />
          </section>
        </main>

        <LandingFooter />
      </div>
    </FeaturedProvider>
  );
}
