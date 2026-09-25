import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getCurrentUser } from "@/lib/auth";
import { getForecastSummary, getForecastViewerState } from "@/lib/forecast/server";
import { getPersonBySlug, getPersonProfile, getPersonSignals, getRenderedAt } from "@/lib/person/profile";
import { readPublishedMarketParameters } from "@/lib/trading/published-parameters";
import { getViewerTradingState } from "@/lib/trading/server";
import { getPlatformSettings } from "@/lib/trading/settings";
import { BackLink } from "@/components/person/back-link";
import { Dossier } from "@/components/person/dossier";
import { ForecastPanel } from "@/components/person/forecast-panel";
import { ForcesPanel } from "@/components/person/forces-panel";
import { MarketOverrides } from "@/components/person/market-overrides";
import { ProfileSkeleton } from "@/components/person/profile-skeleton";
import { ScorePanel } from "@/components/person/score-panel";
import { SignalsList } from "@/components/person/signals-list";
import { ProfileLogger } from "@/components/person/use-profile-logging";

/**
 * /person/[slug] — one person's page (Phase 6c).
 *
 *   identity → score and history → the five forces → the Forecast (Phase 19) → signals
 *
 * Desktop puts the signals in the right rail (app/(app)/@rail/person/[slug])
 * and the Buy / Sell entry beside the score; mobile stacks everything in one
 * column with Buy / Sell fixed above the tab bar. Every reading comes from
 * the database as it stands: with the Engine dormant the page says so, in
 * every section, rather than inventing movement.
 *
 * The slug is resolved in the shell, before anything streams, so an unknown
 * person is a real HTTP 404 (a not-found thrown inside a Suspense boundary
 * can only ever be a 200). The readings behind the sections then stream in
 * behind a skeleton of the page's own shape.
 */

// The score and its history are live readings; never serve a stale page.
export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const person = await getPersonBySlug(slug).catch(() => null);
  return person
    ? { title: person.displayName, description: `${person.displayName}'s Momentum Score, history, the five forces and signals.` }
    : { title: "Not found" };
}

export default async function PersonPage({ params }: { params: Params }) {
  const { slug } = await params;

  const person = await getPersonBySlug(slug);
  if (!person) notFound();

  return (
    <div className="flex flex-col gap-10 pb-28 md:pb-0">
      <BackLink />
      <Suspense fallback={<ProfileSkeleton />}>
        <ProfileBody slug={slug} personId={person.id} personName={person.displayName} personCategory={person.category} />
      </Suspense>
    </div>
  );
}

/** Everything below the back link: the readings, streamed in once they are loaded. */
async function ProfileBody({ slug, personId, personName, personCategory }: { slug: string; personId: string; personName: string; personCategory: string }) {
  const [profile, signals, user, settings, viewer, forecast, forecastViewer, market] = await Promise.all([
    getPersonProfile(slug),
    getPersonSignals({ id: personId, displayName: personName, category: personCategory }),
    getCurrentUser(),
    getPlatformSettings(),
    getViewerTradingState(personId),
    getForecastSummary(personId),
    getForecastViewerState(personId),
    readPublishedMarketParameters(),
  ]);
  // The person was found a moment ago; only a deactivation in between lands here.
  if (!profile) notFound();

  const loggingEnabled = Boolean(user);
  const renderedAt = getRenderedAt();

  return (
    // pb-tradebar: the mobile Buy / Sell bar is fixed above the tab bar, exactly --spacing-tradebar tall
    // (Phase 29b); the shell's pb-tabbar-safe already clears the tab bar and the home indicator.
    <div className="flex flex-col gap-10 pb-tradebar md:pb-0">
      <ProfileLogger personId={profile.person.id} enabled={loggingEnabled} />

      <Dossier person={profile.person} state={profile.state} conviction={profile.conviction} />

      {/* Score, history, the viewer's position, the trade sheet and both Buy / Sell placements (the mobile bar is fixed, so it lives here too). */}
      <ScorePanel
        profile={profile}
        loggingEnabled={loggingEnabled}
        renderedAt={renderedAt}
        shortingEnabled={settings.shortingEnabled}
        viewer={viewer}
        toleranceCents={settings.priceToleranceCents}
        minOrderCents={settings.minOrderCents}
      />

      {/* The person's own market settings, where they differ from the tier's (Phase 29d); nothing for everyone else. */}
      <MarketOverrides
        name={profile.person.displayName}
        overrides={profile.person.overrides}
        tier={market.tiers[profile.person.tier]}
        shortingEnabled={settings.shortingEnabled}
      />

      <ForcesPanel forces={profile.forces} market={profile.market} latestTick={profile.latestTick} curved={profile.person.depthUnits !== null} />

      {/* The crowd's read on the trajectory, below the five forces. Hidden entirely while the person's forecast_paused flag is set. */}
      <ForecastPanel
        person={{ id: profile.person.id, slug: profile.person.slug, displayName: profile.person.displayName, forecastPaused: profile.person.forecastPaused }}
        summary={forecast}
        signedIn={forecastViewer.signedIn}
        ownVote={forecastViewer.ownVote}
        loggingEnabled={loggingEnabled}
      />

      {/* On desktop the signals live in the rail; below lg they follow the forces. */}
      <SignalsList
        className="lg:hidden"
        items={signals}
        personId={profile.person.id}
        personName={profile.person.displayName}
        loggingEnabled={loggingEnabled}
        renderedAt={renderedAt}
      />
    </div>
  );
}
