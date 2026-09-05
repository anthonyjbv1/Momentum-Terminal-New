import { SignOutButton } from "@/components/auth/SignOutButton";
import { getCurrentProfile, requireUser } from "@/lib/auth";
import { formatCents } from "@/lib/money";

/**
 * Minimal protected page. Proves the full auth loop: proxy.ts guards the
 * route, requireUser() verifies the session, and the public.users row created
 * by the signup trigger is read back through RLS.
 */
export default async function AccountPage() {
  const user = await requireUser("/account");
  const profile = await getCurrentProfile();

  if (!profile) {
    return (
      <main className="mx-auto max-w-md p-8">
        <p role="alert" className="text-sm text-red-600">
          Signed in as {user.email}, but no profile row exists yet. Check the on_auth_user_created
          trigger in the database.
        </p>
        <SignOutButton />
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">Account</h1>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="opacity-70">Username</dt>
        <dd data-testid="username">@{profile.username}</dd>

        <dt className="opacity-70">Display name</dt>
        <dd data-testid="display-name">{profile.display_name}</dd>

        <dt className="opacity-70">Email</dt>
        <dd data-testid="email">{profile.email}</dd>

        <dt className="opacity-70">Wallet balance</dt>
        <dd data-testid="wallet-balance">{formatCents(profile.wallet_balance_cents)}</dd>

        <dt className="opacity-70">Buying power</dt>
        <dd data-testid="buying-power">{formatCents(profile.buying_power_cents)}</dd>

        <dt className="opacity-70">Member since</dt>
        <dd>{new Date(profile.created_at).toLocaleDateString("en-US")}</dd>
      </dl>

      <SignOutButton />
    </main>
  );
}
