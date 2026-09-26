import Link from "next/link";

import { buttonClassName } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { JOIN_MESSAGES, type JoinPageState } from "@/lib/invites/join";

import { JoinForm } from "./join-form";

/**
 * What /join/<token> shows (Phase 32), one state at a time: the form for an
 * open invite, and a plain sentence for each way an invite can no longer be
 * used. The "closed" state never renders: the page 404s instead.
 */
export function JoinView({ state, token, googleEnabled }: { state: Exclude<JoinPageState, { kind: "closed" }>; token: string; googleEnabled: boolean }) {
  if (state.kind === "open") {
    const expires = state.invite.expiresAt ? new Date(state.invite.expiresAt) : null;
    return (
      <>
        <div className="mb-8 flex flex-col gap-3 px-1">
          <p className="text-sm font-medium text-fg-muted">Momentum Terminal beta</p>
          <h1 className="text-4xl font-bold tracking-tighter text-fg">Your invitation</h1>
          <p className="text-base text-fg-secondary">
            Momentum Terminal follows how the people shaping culture are trending, and lets you trade on it with a paper balance. No real money is involved.
          </p>
        </div>
        <Card>
          <CardContent className="p-6 sm:p-8">
            <JoinForm token={token} email={state.invite.email ?? ""} googleEnabled={googleEnabled} defaults={{ username: state.invite.desiredUsername, displayName: state.invite.desiredDisplayName }} />
          </CardContent>
        </Card>
        {expires ? (
          <p className="mt-6 px-1 text-sm text-fg-muted">
            This invitation works once, until{" "}
            <span className="tabular-nums">{new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(expires)}</span>.
          </p>
        ) : null}
      </>
    );
  }

  const copy: Record<Exclude<JoinPageState["kind"], "open" | "closed">, { title: string; body: string }> = {
    not_found: { title: "This link does not work", body: JOIN_MESSAGES.invalid },
    used: { title: "Already used", body: JOIN_MESSAGES.used },
    revoked: { title: "Invitation withdrawn", body: JOIN_MESSAGES.revoked },
    expired: { title: "Invitation expired", body: JOIN_MESSAGES.expired },
    unavailable: { title: "Try again in a moment", body: JOIN_MESSAGES.lookupUnavailable },
  };
  const { title, body } = copy[state.kind];
  return (
    <div className="flex flex-col gap-6 px-1 py-8">
      <h1 className="text-4xl font-bold tracking-tighter text-fg">{title}</h1>
      <p className="text-base text-fg-secondary">{body}</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/login" className={buttonClassName("primary", "md")}>
          Log in
        </Link>
        <Link href="/" className={buttonClassName("outline", "md")}>
          Momentum Terminal
        </Link>
      </div>
    </div>
  );
}
