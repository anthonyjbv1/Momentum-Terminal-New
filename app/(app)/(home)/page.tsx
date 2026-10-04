import type { Metadata } from "next";

import { getCurrentUser } from "@/lib/auth";
import { isBetaSignupEnabled } from "@/lib/env";
import { getHomeBoard } from "@/lib/home/board";
import { getMyFollowIds } from "@/lib/onboarding/server";
import { PeopleBoard } from "@/components/home/people-board";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Home" };

// The board is live: every request reflects whatever the Engine has computed.
export const dynamic = "force-dynamic";

/**
 * Home: the momentum board — everyone the Engine tracks, ranked. One wave of
 * reads (the tab-switch lag fix, 2026-10-04): the board, the identity check
 * and the viewer's follows start together; the follows read is RLS-scoped,
 * so it needs nothing from the other two.
 */
export default async function HomePage() {
  const beta = isBetaSignupEnabled();
  const [board, user, follows] = await Promise.all([getHomeBoard(), getCurrentUser(), beta ? getMyFollowIds() : Promise.resolve<string[]>([])]);
  // Phase 32: the Following filter exists only behind the beta switch, for a signed-in viewer.
  const followingIds = user && beta ? follows : undefined;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Home"
        description="Discover who’s trending"
      />
      <PeopleBoard board={board} loggingEnabled={Boolean(user)} followingIds={followingIds} />
    </div>
  );
}
