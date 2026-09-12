import { getCurrentUser } from "@/lib/auth";
import { getHomeBoard } from "@/lib/home/board";
import { BoardGlance } from "@/components/feed/board-glance";

// Mirrors the page: the rail shows the board as of this request.
export const dynamic = "force-dynamic";

/**
 * The portfolio's desktop rail: a glance at the board beside your holdings,
 * the same four movers the Feed's rail shows, each a link. What to look at
 * next, for a page whose positions are a subset of the board. Signed out
 * the page redirects; the rail renders nothing.
 */
export default async function PortfolioRail() {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return null;
  const board = await getHomeBoard();
  return <BoardGlance board={board} />;
}
