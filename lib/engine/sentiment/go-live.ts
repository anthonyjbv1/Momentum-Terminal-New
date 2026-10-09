import type { Json } from "@/types/database";

/**
 * THE NEUTRAL GO-LIVE (2026-10-09, GO_LIVE_NEUTRAL_ENABLED). A broadcast's
 * go-live signal written under the switch carries `go_live: "neutral"`:
 * the Engine scores it at zero by design, never hands it to the model, and
 * counts it free like a metric. The signal still exists, so the Feed and
 * the stream link appear.
 */
export function isNeutralGoLive(payload: Json | null): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  return payload.kind === "stream" && payload.go_live === "neutral";
}

/** The stream title of a neutral go-live payload, for the narrative template; null for anything else. */
export function neutralGoLiveTitle(payload: Json | null): string | null {
  if (!isNeutralGoLive(payload)) return null;
  const title = (payload as { title?: Json }).title;
  return typeof title === "string" ? title : "";
}
