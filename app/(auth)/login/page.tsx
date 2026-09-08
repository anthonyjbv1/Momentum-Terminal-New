import type { Metadata } from "next";
import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Log in" };

type SearchParams = Promise<{ next?: string; error?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { next, error } = await searchParams;

  return (
    <>
      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <p className="text-label text-fg-muted">Welcome back</p>
          <CardTitle className="text-2xl">Log in</CardTitle>
        </CardHeader>
        <CardContent>
          <LoginForm
            next={next}
            notice={error === "auth_callback" ? "That sign-in link is invalid or has expired. Log in below or request a new one." : undefined}
          />
        </CardContent>
      </Card>
      <p className="mt-6 text-center text-sm text-fg-muted">
        No account yet?{" "}
        <Link href="/signup" className="font-medium text-fg underline-offset-4 transition-colors hover:text-accent hover:underline">
          Sign up
        </Link>
      </p>
    </>
  );
}
