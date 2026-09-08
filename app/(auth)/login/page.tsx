import type { Metadata } from "next";
import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "Log in" };

type SearchParams = Promise<{ next?: string; error?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { next, error } = await searchParams;

  return (
    <>
      <div className="mb-8 flex flex-col gap-2 px-1">
        <h1 className="text-4xl font-bold tracking-tighter text-fg">Log in</h1>
        <p className="text-base text-fg-muted">Welcome back.</p>
      </div>
      <Card>
        <CardContent className="p-6 sm:p-8">
          <LoginForm
            next={next}
            notice={error === "auth_callback" ? "That sign-in link is invalid or has expired. Log in below or request a new one." : undefined}
          />
        </CardContent>
      </Card>
      <p className="mt-8 text-center text-sm text-fg-muted">
        No account yet?{" "}
        <Link href="/signup" className="font-medium text-fg underline-offset-4 transition-colors hover:underline">
          Sign up
        </Link>
      </p>
    </>
  );
}
