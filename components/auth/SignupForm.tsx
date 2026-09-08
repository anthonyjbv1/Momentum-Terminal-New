"use client";

import { useActionState } from "react";

import { signup, type AuthFormState } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";

import { FormError } from "./FormError";

const initialState: AuthFormState = {};

export function SignupForm() {
  const [state, formAction, pending] = useActionState(signup, initialState);

  if (state.message) {
    return (
      <Card tone="raised">
        <CardContent>
          <p role="status" className="text-sm text-fg-secondary">
            {state.message}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <Field label="Email" htmlFor="signup-email">
        <Input id="signup-email" name="email" type="email" required autoComplete="email" defaultValue={state.values?.email ?? ""} />
      </Field>

      <Field label="Username" htmlFor="signup-username" hint="3–30 characters: lowercase letters, numbers or underscores.">
        <Input
          id="signup-username"
          name="username"
          type="text"
          required
          autoComplete="username"
          minLength={3}
          maxLength={30}
          pattern="[a-z0-9_]{3,30}"
          defaultValue={state.values?.username ?? ""}
        />
      </Field>

      <Field label="Display name" htmlFor="signup-display-name" hint="Optional. Defaults to your username.">
        <Input id="signup-display-name" name="display_name" type="text" autoComplete="name" maxLength={80} defaultValue={state.values?.display_name ?? ""} />
      </Field>

      <Field label="Password" htmlFor="signup-password" hint="At least 8 characters.">
        <Input id="signup-password" name="password" type="password" required autoComplete="new-password" minLength={8} />
      </Field>

      <FormError message={state.error} />

      <Button type="submit" size="lg" loading={pending} className="w-full">
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
