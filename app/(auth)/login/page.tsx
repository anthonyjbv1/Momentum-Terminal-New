import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";

type SearchParams = Promise<{ next?: string; error?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { next, error } = await searchParams;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">Log in</h1>

      {error === "auth_callback" && (
        <p role="alert" className="text-sm text-red-600">
          That sign-in link is invalid or has expired. Please log in or request a new one.
        </p>
      )}

      <LoginForm next={next} />

      <p className="text-sm">
        No account yet?{" "}
        <Link href="/signup" className="underline">
          Sign up
        </Link>
      </p>
    </main>
  );
}
