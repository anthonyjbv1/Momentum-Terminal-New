import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { getPersonBySlug, getPersonProfile, getPersonSignals, getRenderedAt } from "@/lib/person/profile";
import { BackLink } from "@/components/person/back-link";
import { Dossier } from "@/components/person/dossier";
import { ForcesPanel } from "@/components/person/forces-panel";
import { ScorePanel } from "@/components/person/score-panel";
import { SignalsList } from "@/components/person/signals-list";
import { TradeBar } from "@/components/person/trade-bar";
import { ProfileLogger } from "@/components/person/use-profile-logging";

/**
 * /person/[slug] — one person's page (Phase 6c).
 *
 *   identity → score and history → the five forces → signals
 *
 * Desktop puts the signals in the right rail (app/(app)/@rail/person/[slug])
 * and the Buy / Sell entry beside the score; mobile stacks everything in one
 * column with Buy / Sell fixed above the tab bar. Every reading comes from
 * the database as it stands: with the Engine dormant the page says so, in
 * every section, rather than inventing movement.
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

  const [profile, signals, user] = await Promise.all([getPersonProfile(slug), getPersonSignals(person.id), getCurrentUser()]);
  if (!profile) notFound();

  const loggingEnabled = Boolean(user);
  const renderedAt = getRenderedAt();

  return (
    <div className="flex flex-col gap-10 pb-28 md:pb-0">
      <ProfileLogger personId={profile.person.id} enabled={loggingEnabled} />

      <BackLink />

      <Dossier person={profile.person} state={profile.state} conviction={profile.conviction} />

      <ScorePanel profile={profile} loggingEnabled={loggingEnabled} renderedAt={renderedAt} />

      <ForcesPanel forces={profile.forces} latestTick={profile.latestTick} />

      {/* On desktop the signals live in the rail; below lg they follow the forces. */}
      <SignalsList
        className="lg:hidden"
        items={signals}
        personId={profile.person.id}
        personName={profile.person.displayName}
        loggingEnabled={loggingEnabled}
        renderedAt={renderedAt}
      />

      <TradeBar person={profile.person} />
    </div>
  );
}
