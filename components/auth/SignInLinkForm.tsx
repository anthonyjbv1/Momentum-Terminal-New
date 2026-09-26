"use client";

import { useActionState } from "react";

import { requestSignInLink, signInWithGoogle, type AuthFormState } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";

import { FormError } from "./FormError";

const initialState: AuthFormState = {};

/**
 * The passwordless ways in (Phase 32, only with BETA_SIGNUP_ENABLED on): a
 * one-time link to the account's address, and Google when its own switch is
 * on. Accounts made from invites have no password, so this is how they come
 * back.
 */
export function SignInLinkForm({ next, googleEnabled }: { next?: string; googleEnabled: boolean }) {
  const [state, formAction, pending] = useActionState(requestSignInLink, initialState);

  return (
    <div className="flex flex-col gap-4">
      {state.message ? (
        <Card tone="raised">
          <CardContent>
            <p role="status" className="text-sm text-fg-secondary">
              {state.message}
            </p>
          </CardContent>
        </Card>
      ) : (
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next ?? ""} />
          <Field label="Email" htmlFor="link-email">
            <Input id="link-email" name="email" type="email" required autoComplete="email" defaultValue={state.values?.email ?? ""} />
          </Field>
          <FormError message={state.error} />
          <Button type="submit" size="lg" loading={pending} className="w-full">
            {pending ? "Sending…" : "Email me a sign-in link"}
          </Button>
        </form>
      )}
      {googleEnabled ? (
        <form action={signInWithGoogle}>
          <input type="hidden" name="next" value={next ?? ""} />
          <Button type="submit" variant="outline" size="lg" className="w-full">
            Continue with Google
          </Button>
        </form>
      ) : null}
    </div>
  );
}
