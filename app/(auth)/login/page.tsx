import type { Metadata } from "next";
import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";
import { SignInLinkForm } from "@/components/auth/SignInLinkForm";
import { Card, CardContent } from "@/components/ui/card";
import { isBetaSignupEnabled, isGoogleAuthEnabled } from "@/lib/env";

export const metadata: Metadata = { title: "Log in" };

type SearchParams = Promise<{ next?: string; error?: string; deleted?: string }>;

const NOTICES: Record<string, string> = {
  auth_callback: "That sign-in link is invalid or has expired. Log in below or request a new one.",
  not_invited: "That account could not be created. The invitation is for one address only: sign in with the address it was sent to.",
};

/**
 * Log in. With BETA_SIGNUP_ENABLED off this is the page as it was, less the
 * link to the old public sign-up (Phase 32 removed it). With it on, the
 * passwordless ways in come first, since invited accounts have no password,
 * and the password form stays for the accounts that have one.
 */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { next, error, deleted } = await searchParams;
  const open = isBetaSignupEnabled();
  const notice = error ? (NOTICES[error] ?? NOTICES.auth_callback) : undefined;

  return (
    <>
      <div className="mb-8 flex flex-col gap-2 px-1">
        <h1 className="text-4xl font-bold tracking-tighter text-fg">Log in</h1>
        <p className="text-base text-fg-muted">{deleted ? "Your account has been deleted." : "Welcome back."}</p>
      </div>
      {open ? (
        <Card className="mb-6">
          <CardContent className="p-6 sm:p-8">
            <SignInLinkForm next={next} googleEnabled={isGoogleAuthEnabled()} />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent className="p-6 sm:p-8">
          {open ? <p className="mb-5 text-sm text-fg-muted">Or with a password, if your account has one.</p> : null}
          <LoginForm next={next} notice={notice} />
        </CardContent>
      </Card>
      <p className="mt-8 text-center text-sm text-fg-muted">
        No account yet? Membership is by invitation during the beta.{" "}
        <Link href="/" className="font-medium text-fg underline-offset-4 transition-colors hover:underline">
          Join the waitlist
        </Link>
      </p>
    </>
  );
}
