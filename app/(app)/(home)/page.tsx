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

/** Home: the momentum board — everyone the Engine tracks, ranked. */
export default async function HomePage() {
  const [board, user] = await Promise.all([getHomeBoard(), getCurrentUser()]);
  // Phase 32: the Following filter exists only behind the beta switch, for a signed-in viewer.
  const followingIds = user && isBetaSignupEnabled() ? await getMyFollowIds() : undefined;

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
