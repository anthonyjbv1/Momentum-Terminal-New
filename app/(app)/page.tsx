import type { Metadata } from "next";

import { getCurrentUser } from "@/lib/auth";
import { getHomeBoard } from "@/lib/home/board";
import { PeopleBoard } from "@/components/home/people-board";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Home" };

// The board is live: every request reflects whatever the Engine has computed.
export const dynamic = "force-dynamic";

/** Home: the momentum board — everyone the Engine tracks, ranked. */
export default async function HomePage() {
  const [board, user] = await Promise.all([getHomeBoard(), getCurrentUser()]);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Home"
        description="Every person the Engine tracks, ranked by momentum. Buy the ones heating up, sell the ones cooling off."
      />
      <PeopleBoard board={board} loggingEnabled={Boolean(user)} />
    </div>
  );
}
