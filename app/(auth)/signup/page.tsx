import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "@/components/auth/SignupForm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <>
      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <p className="text-label text-fg-muted">Join the board</p>
          <CardTitle className="text-2xl">Create your account</CardTitle>
          <p className="text-sm text-fg-muted">
            New accounts start with a <span className="num font-medium text-fg-secondary">$1,000.00</span> demo balance.
          </p>
        </CardHeader>
        <CardContent>
          <SignupForm />
        </CardContent>
      </Card>
      <p className="mt-6 text-center text-sm text-fg-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-fg underline-offset-4 transition-colors hover:text-accent hover:underline">
          Log in
        </Link>
      </p>
    </>
  );
}
