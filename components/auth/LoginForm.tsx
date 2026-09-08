"use client";

import { useActionState } from "react";

import { login, type AuthFormState } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

import { FormError } from "./FormError";

const initialState: AuthFormState = {};

export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="next" value={next ?? ""} />

      <FormError message={notice} />

      <Field label="Email" htmlFor="login-email">
        <Input id="login-email" name="email" type="email" required autoComplete="email" defaultValue={state.values?.email ?? ""} />
      </Field>

      <Field label="Password" htmlFor="login-password">
        <Input id="login-password" name="password" type="password" required autoComplete="current-password" />
      </Field>

      <FormError message={state.error} />

      <Button type="submit" size="lg" loading={pending} className="w-full">
        {pending ? "Logging in…" : "Log in"}
      </Button>
    </form>
  );
}
