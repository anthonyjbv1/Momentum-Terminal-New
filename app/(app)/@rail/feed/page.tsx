import { getHomeBoard } from "@/lib/home/board";
import { BoardGlance } from "@/components/feed/board-glance";

// Mirrors the page: the rail shows the board as of this request.
export const dynamic = "force-dynamic";

/**
 * The Feed's desktop rail: a glance at the board, not a second copy of the
 * Feed. The biggest movers of the hour with their scores, each a link.
 */
export default async function FeedRail() {
  const board = await getHomeBoard();
  return <BoardGlance board={board} />;
}
