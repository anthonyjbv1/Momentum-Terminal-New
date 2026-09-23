import "server-only";

import { after } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase-admin";

import { toRow } from "./core";
import { validateBehavioralEvent, type BehavioralEventInput } from "./events";
import { generateUuid } from "./session";

/**
 * Behavioural events from PUBLIC pages, where there is no user (Phase 28).
 *
 * The row is written through the service role with user_id null and a
 * session id — the mt_bsid cookie when the browser has one, otherwise a
 * random id that lives for this one event — which is what the table's
 * actor check requires and what keeps the row invisible to every signed-in
 * user (the policies compare user_id to auth.uid(), never true of a null).
 *
 * Deferred with after(): the page or the route answers first, the row is
 * written once the response is on its way, and a failure is a warning in the
 * server log rather than anything the visitor sees. Never throws.
 */
export function logPublicEventInBackground(input: BehavioralEventInput, sessionId: string | null = null): void {
  const validated = validateBehavioralEvent(input, { sessionId: sessionId ?? generateUuid() });
  if (!validated.ok) {
    console.warn("[behavioral] public event dropped:", validated.reason);
    return;
  }
  const row = toRow(null, validated.event);
  after(async () => {
    try {
      const { error } = await createSupabaseAdminClient().from("behavioral_events").insert(row);
      if (error) console.warn("[behavioral] public event failed:", error.message);
    } catch (error) {
      console.warn("[behavioral] public event threw:", error instanceof Error ? error.message : String(error));
    }
  });
}

/** The referring site's host, or null: enough to see where visitors come from, never the full URL. */
export function referrerHost(referer: string | null | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname || null;
  } catch {
    return null;
  }
}
