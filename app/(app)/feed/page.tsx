import type { Metadata } from "next";

import { getCurrentUser } from "@/lib/auth";
import { getFeedCategories, getFeedRoster, getFirstFeedPage } from "@/lib/feed/feed";
import { getRenderedAt } from "@/lib/render-time";
import { FeedStream } from "@/components/feed/feed-stream";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";

/**
 * /feed — the wire (Phase 6d).
 *
 * The Engine narrating what it observes across the whole board, newest
 * first: its own sentences about meaningful moves, and the signals it has
 * yet to explain, framed in its voice. Read-only. The first page renders on
 * the server; the stream pages further on scroll through /api/feed.
 *
 * With the Engine dormant and no connector producing, the page is empty,
 * and says so. Nothing is synthesised.
 */

// Entries land on every tick; never serve a stale page.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Feed" };

export default async function FeedPage() {
  const [page, categories, roster, user] = await Promise.all([getFirstFeedPage(), getFeedCategories(), getFeedRoster(), getCurrentUser()]);
  const live = page.entries.length > 0;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Feed"
        description="The Engine, narrating every move across the board as it lands."
        actions={
          live ? (
            <Badge tone="positive" dot>
              Live
            </Badge>
          ) : (
            <Badge tone="warning" dot>
              Standby
            </Badge>
          )
        }
      />

      <FeedStream initialPage={page} categories={categories} roster={roster} loggingEnabled={Boolean(user)} renderedAt={getRenderedAt()} />
    </div>
  );
}
