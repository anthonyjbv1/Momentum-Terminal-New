import Link from "next/link";

import { getCurrentProfile } from "@/lib/auth";

export default async function HomePage() {
  const profile = await getCurrentProfile();

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Momentum Terminal</h1>
        <p className="mt-1 text-sm opacity-70">Phase 1 foundation: scaffold, schema, authentication.</p>
      </header>

      {profile ? (
        <p>
          Signed in as <strong>@{profile.username}</strong>.{" "}
          <Link href="/account" className="underline">
            Go to your account
          </Link>
        </p>
      ) : (
        <nav className="flex gap-4">
          <Link href="/login" className="underline">
            Log in
          </Link>
          <Link href="/signup" className="underline">
            Sign up
          </Link>
        </nav>
      )}
    </main>
  );
}
