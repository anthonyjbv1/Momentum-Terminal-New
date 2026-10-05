import { getFeedPreview } from "@/lib/home/board";
import { isPhoneRequest } from "@/lib/request/phone";
import { FeedPreview } from "@/components/home/feed-preview";

// Mirrors the board: the rail shows whatever has landed as of this request.
export const dynamic = "force-dynamic";

/** Home's desktop rail: the live feed beside the board. Nothing on a phone, where the rail is hidden (2026-10-04). */
export default async function HomeRail() {
  if (await isPhoneRequest()) return null;
  const items = await getFeedPreview();
  return <FeedPreview items={items} />;
}
