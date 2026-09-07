import "server-only";

import { cookies } from "next/headers";
import { after } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase-server";

import { createSupabaseBehavioralStore, writeBehavioralEvents, type BehavioralEventStore, type LogResult } from "./core";
import type { BehavioralEventInput } from "./events";
import { BEHAVIORAL_SESSION_COOKIE, sessionIdFromCookieValue } from "./session";

/**
 * Server-side logging: what Server Actions and Route Handlers call.
 *
 *   logEventInBackground({ eventType: "take_position", personId, metadata: { direction, amount_cents } });
 *
 * The acting user comes from the verified auth session; the browsing session
 * comes from the mt_bsid cookie the client maintains; the insert runs through
 * the user's own RLS-scoped client, so the row can only ever be theirs.
 * Nothing here throws: not signed in, invalid event, database down all
 * become a result (or a warning in the server log) and the caller's action
 * proceeds untouched.
 */

export interface LogOptions {
  /** Overrides the session id read from the mt_bsid cookie. */
  sessionId?: string | null;
}

interface LogContext {
  userId: string | null;
  sessionId: string | null;
  store: BehavioralEventStore | null;
}

async function readSessionCookie(): Promise<string | null> {
  try {
    const store = await cookies();
    return sessionIdFromCookieValue(store.get(BEHAVIORAL_SESSION_COOKIE)?.value);
  } catch {
    return null;
  }
}

/**
 * Resolves everything that needs the request scope (auth cookies). Called
 * synchronously by the public functions so it starts inside the request even
 * when the write itself is deferred with after().
 */
async function resolveContext(options: LogOptions): Promise<LogContext> {
  const user = await getCurrentUser();
  if (!user) return { userId: null, sessionId: null, store: null };
  const [sessionId, client] = await Promise.all([
    options.sessionId !== undefined ? Promise.resolve(options.sessionId) : readSessionCookie(),
    createSupabaseServerClient(),
  ]);
  return { userId: user.id, sessionId, store: createSupabaseBehavioralStore(client) };
}

async function writeWithContext(contextPromise: Promise<LogContext>, inputs: BehavioralEventInput[]): Promise<LogResult> {
  try {
    const context = await contextPromise;
    if (!context.userId || !context.store) {
      return { accepted: 0, dropped: inputs.map((_, index) => ({ index, reason: "not signed in" })) };
    }
    return await writeBehavioralEvents(context.store, context.userId, inputs, { sessionId: context.sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[behavioral] logging failed:", message);
    return { accepted: 0, dropped: [], error: message };
  }
}

/** Logs several events for the signed-in user. Resolves to what happened; never rejects. */
export function logEvents(inputs: BehavioralEventInput[], options: LogOptions = {}): Promise<LogResult> {
  return writeWithContext(resolveContext(options), inputs);
}

/** Logs one event for the signed-in user. Resolves to what happened; never rejects. */
export function logEvent(input: BehavioralEventInput, options: LogOptions = {}): Promise<LogResult> {
  return logEvents([input], options);
}

/**
 * Fire-and-forget from a Server Action or Route Handler: the write is
 * scheduled with Next's after(), so it runs once the response has been sent
 * and adds nothing to the user's wait. Outside a request scope it simply
 * runs in the background.
 */
export function logEventInBackground(input: BehavioralEventInput | BehavioralEventInput[], options: LogOptions = {}): void {
  const inputs = Array.isArray(input) ? input : [input];
  let context: Promise<LogContext>;
  try {
    context = resolveContext(options);
  } catch (error) {
    console.warn("[behavioral] could not resolve request context:", error instanceof Error ? error.message : error);
    return;
  }
  // Attach a no-op handler so a rejection can never surface as unhandled.
  context.catch(() => undefined);

  const run = () => writeWithContext(context, inputs).then(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}
