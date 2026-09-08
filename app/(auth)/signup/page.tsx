import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "@/components/auth/SignupForm";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <>
      <div className="mb-8 flex flex-col gap-2 px-1">
        <h1 className="text-4xl font-bold tracking-tighter text-fg">Create your account</h1>
        <p className="text-base text-fg-muted">
          New accounts start with a <span className="num font-medium text-fg-secondary">$1,000.00</span> demo balance.
        </p>
      </div>
      <Card>
        <CardContent className="p-6 sm:p-8">
          <SignupForm />
        </CardContent>
      </Card>
      <p className="mt-8 text-center text-sm text-fg-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-fg underline-offset-4 transition-colors hover:underline">
          Log in
        </Link>
      </p>
    </>
  );
}
