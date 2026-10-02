import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getCurrentUser } from "@/lib/auth";
import { isBetaSignupEnabled } from "@/lib/env";
import { getForecastSummary, getForecastViewerState } from "@/lib/forecast/server";
import { getPersonHeader, getPersonReadings, getPersonSeries, getPersonSignals, getRenderedAt, type PersonHeader, type PersonReadings } from "@/lib/person/profile";
import { deriveState, type ProfileSignal } from "@/lib/person/profile-model";
import { readPublishedMarketParameters } from "@/lib/trading/published-parameters";
import { getViewerTradingState } from "@/lib/trading/server";
import { getPlatformSettings } from "@/lib/trading/settings";
import { ProductTour } from "@/components/onboarding/product-tour";
import { BackLink } from "@/components/person/back-link";
import { Dossier } from "@/components/person/dossier";
import { ForecastPanel } from "@/components/person/forecast-panel";
import { ForcesPanel } from "@/components/person/forces-panel";
import { MarketOverrides } from "@/components/person/market-overrides";
import { ForcesSkeleton, SignalsSkeleton } from "@/components/person/profile-skeleton";
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
 * WHAT RENDERS WHEN (2026-10-02). The route's loading file shows the
 * profile's shape the moment a person is tapped. The slug is resolved in one
 * round trip (the person, the quote, the newest tick) before anything
 * streams, so an unknown person is a real HTTP 404 (a not-found thrown
 * inside a Suspense boundary can only ever be a 200); the viewer's own
 * reads (balance, position, vote) follow in one parallel batch. The header
 * and the score render from that. The chart's series, the forces and the
 * signal list are separate reads, each behind its own boundary, so the
 * slowest no longer holds the page: the dossier's State and Conviction
 * fields, the change line and the chart, the forces panel and the signals
 * fill in as each read lands.
 *
 * THE TOUR (Phase 32b). With ?tour=onboarding (from /start) or ?tour=replay
 * (from the profile), a signed-in member sees the guided tour over this
 * page: only behind BETA_SIGNUP_ENABLED, and only on a tradeable person,
 * since one stop is the Buy pill. Nothing else about the page changes.
 */

// The score and its history are live readings; never serve a stale page.
export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;
type Search = Promise<{ tour?: string | string[] }>;

/** ?tour=onboarding | replay, or nothing. */
function tourOrigin(value: string | string[] | undefined): "onboarding" | "replay" | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "onboarding" || raw === "replay" ? raw : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const person = (await getPersonHeader(slug).catch(() => null))?.person;
  return person
    ? { title: person.displayName, description: `${person.displayName}'s Momentum Score, history, the five forces and signals.` }
    : { title: "Not found" };
}

export default async function PersonPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const [{ slug }, search] = await Promise.all([params, searchParams]);

  // The slug lookup and the reads that need no person, together.
  const [header, user, settings, market] = await Promise.all([getPersonHeader(slug), getCurrentUser(), getPlatformSettings(), readPublishedMarketParameters()]);
  if (!header) notFound();
  const { person, latestTick } = header;

  // The viewer's own reads on this person, in one parallel batch.
  const [viewer, forecast, forecastViewer] = await Promise.all([getViewerTradingState(person.id), getForecastSummary(person.id), getForecastViewerState(person.id)]);

  // The readings behind the sections, started now and awaited where each is
  // rendered: nothing below waits for any of them before the header shows.
  const series = getPersonSeries(slug);
  const readings = getPersonReadings(slug);
  const signals = getPersonSignals(slug);
  const state = series.then((ranges) => deriveState(ranges["24h"]));
  const conviction = readings.then((loaded) => loaded?.conviction ?? null);

  const loggingEnabled = Boolean(user);
  const renderedAt = getRenderedAt();
  const tour = tourOrigin(search.tour);

  return (
    <div className="flex flex-col gap-10 pb-28 md:pb-0">
      <BackLink />

      {/* pb-tradebar: the mobile Buy / Sell bar is fixed above the tab bar, exactly --spacing-tradebar tall
          (Phase 29b); the shell's pb-tabbar-safe already clears the tab bar and the home indicator. */}
      <div className="flex flex-col gap-10 pb-tradebar md:pb-0">
        <ProfileLogger personId={person.id} enabled={loggingEnabled} />

        {tour && user && isBetaSignupEnabled() && person.tradingMode === "tradeable" ? <ProductTour origin={tour} loggingEnabled={loggingEnabled} /> : null}

        <Dossier person={person} state={state} conviction={conviction} />

        {/* Score, history, the viewer's position, the trade sheet and both Buy / Sell placements (the mobile bar is fixed, so it lives here too). */}
        <ScorePanel
          person={person}
          latestTick={latestTick}
          series={series}
          loggingEnabled={loggingEnabled}
          renderedAt={renderedAt}
          shortingEnabled={settings.shortingEnabled}
          viewer={viewer}
          toleranceCents={settings.priceToleranceCents}
          minOrderCents={settings.minOrderCents}
        />

        {/* The person's own market settings, where they differ from the tier's (Phase 29d); nothing for everyone else. */}
        <MarketOverrides name={person.displayName} overrides={person.overrides} tier={market.tiers[person.tier]} shortingEnabled={settings.shortingEnabled} />

        <Suspense fallback={<ForcesSkeleton />}>
          <ForcesSection readings={readings} header={header} />
        </Suspense>

        {/* The crowd's read on the trajectory, below the five forces. Hidden entirely while the person's forecast_paused flag is set. */}
        <ForecastPanel
          person={{ id: person.id, slug: person.slug, displayName: person.displayName, forecastPaused: person.forecastPaused }}
          summary={forecast}
          signedIn={forecastViewer.signedIn}
          ownVote={forecastViewer.ownVote}
          loggingEnabled={loggingEnabled}
        />

        {/* On desktop the signals live in the rail; below lg they follow the forces. */}
        <Suspense fallback={<SignalsSkeleton className="lg:hidden" />}>
          <SignalsSection signals={signals} header={header} loggingEnabled={loggingEnabled} renderedAt={renderedAt} />
        </Suspense>
      </div>
    </div>
  );
}

/** The five forces, once their window has been read. */
async function ForcesSection({ readings, header }: { readings: Promise<PersonReadings | null>; header: PersonHeader }) {
  const loaded = await readings;
  if (!loaded) return null;
  return <ForcesPanel forces={loaded.forces} market={loaded.market} latestTick={loaded.latestTick} curved={header.person.depthUnits !== null} />;
}

/** The signal list below lg, once the signals and narratives have been read. */
async function SignalsSection({ signals, header, loggingEnabled, renderedAt }: { signals: Promise<ProfileSignal[]>; header: PersonHeader; loggingEnabled: boolean; renderedAt: number }) {
  const items = await signals;
  return <SignalsList className="lg:hidden" items={items} personId={header.person.id} personName={header.person.displayName} loggingEnabled={loggingEnabled} renderedAt={renderedAt} />;
}
