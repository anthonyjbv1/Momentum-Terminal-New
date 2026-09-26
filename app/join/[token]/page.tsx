import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JoinView } from "@/components/join/join-view";
import { QuietLayout } from "@/components/shell/quiet-layout";
import { isBetaSignupEnabled, isGoogleAuthEnabled } from "@/lib/env";
import { joinPageState } from "@/lib/invites/join";
import { lookupInvite } from "@/lib/invites/server";

/**
 * /join/<token> — where an invitation lands (Phase 32). While
 * BETA_SIGNUP_ENABLED is off there is no such page: every token is a 404,
 * exactly as before the phase. The token never reaches a log line; only its
 * hash reaches the database.
 */

export const dynamic = "force-dynamic";

/** The title follows the switch: while it is off, the 404 says nothing about what would have been here. */
export function generateMetadata(): Metadata {
  const base: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };
  return isBetaSignupEnabled() ? { ...base, title: "Your invitation" } : base;
}

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const state = await joinPageState(token, { enabled: isBetaSignupEnabled(), lookup: lookupInvite });
  if (state.kind === "closed") notFound();
  return (
    <QuietLayout>
      <JoinView state={state} token={token} googleEnabled={isGoogleAuthEnabled()} />
    </QuietLayout>
  );
}
