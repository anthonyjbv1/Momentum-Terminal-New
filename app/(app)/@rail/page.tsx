import { getFeedPreview } from "@/lib/home/board";
import { FeedPreview } from "@/components/home/feed-preview";

// Mirrors the board: the rail shows whatever has landed as of this request.
export const dynamic = "force-dynamic";

/** Home's desktop rail: the live feed beside the board. */
export default async function HomeRail() {
  const items = await getFeedPreview();
  return <FeedPreview items={items} />;
}
