"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { joinAction, type JoinFormState } from "@/app/join/[token]/actions";
import { FormError } from "@/components/auth/FormError";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { MINIMUM_AGE } from "@/lib/legal/versions";

/**
 * THE JOIN FORM (Phase 32). The invited address is shown and not editable:
 * the invitation is for that address, and the account is created only for
 * it. A username, an optional display name, the two boxes, and one of two
 * ways in. Nothing is pre-ticked.
 */

export interface JoinFormProps {
  token: string;
  email: string;
  googleEnabled: boolean;
  defaults?: { username?: string | null; displayName?: string | null };
  /** For the screenshot harness: the state to render instead of the action's. */
  initialState?: JoinFormState;
}

const EMPTY: JoinFormState = { outcome: null, values: { username: "", display_name: "" } };

export function JoinForm({ token, email, googleEnabled, defaults, initialState }: JoinFormProps) {
  const [state, formAction, pending] = useActionState(joinAction, initialState ?? EMPTY);
  const [method, setMethod] = useState<"email" | "google">("email");

  if (state.outcome?.kind === "link_sent") {
    return (
      <Card tone="raised">
        <CardContent className="flex flex-col gap-3">
          <p role="status" className="text-lg font-semibold tracking-tight text-fg">
            Check your inbox
          </p>
          <p className="text-base text-fg-secondary">
            A sign-in link is on its way to <span className="font-medium text-fg">{state.outcome.email}</span>. It works once. Open it on this device to finish.
          </p>
          <p className="text-sm text-fg-muted">Nothing there after a few minutes? Check spam, or ask for a new link on the log-in page with the same address.</p>
        </CardContent>
      </Card>
    );
  }

  const error = state.outcome?.kind === "error" ? state.outcome : null;
  const username = state.values.username || defaults?.username || "";
  const displayName = state.values.display_name || defaults?.displayName || "";

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="method" value={method} />

      <Field label="Email" htmlFor="join-email" hint="The invitation is for this address.">
        <Input id="join-email" type="email" value={email} readOnly aria-readonly className="text-fg-secondary" />
      </Field>

      <Field label="Username" htmlFor="join-username" hint="3 to 30 characters: lowercase letters, numbers or underscores." error={error?.field === "username" ? error.message : undefined}>
        <Input
          id="join-username"
          name="username"
          type="text"
          required
          autoComplete="username"
          minLength={3}
          maxLength={30}
          pattern="[a-z0-9_]{3,30}"
          defaultValue={username}
          aria-invalid={error?.field === "username" || undefined}
        />
      </Field>

      <Field label="Display name" htmlFor="join-display-name" hint="Optional. Defaults to your username.">
        <Input id="join-display-name" name="display_name" type="text" autoComplete="name" maxLength={80} defaultValue={displayName} />
      </Field>

      <div className="flex flex-col gap-3 rounded-xl bg-surface-raised p-4">
        <label className="flex items-start gap-3 text-sm text-fg-secondary">
          <input type="checkbox" name="age" required className="mt-0.5 size-4 shrink-0 accent-[var(--color-fg)]" aria-invalid={error?.field === "age" || undefined} />
          <span>I am {MINIMUM_AGE} or older.</span>
        </label>
        <label className="flex items-start gap-3 text-sm text-fg-secondary">
          <input type="checkbox" name="terms" required className="mt-0.5 size-4 shrink-0 accent-[var(--color-fg)]" aria-invalid={error?.field === "terms" || undefined} />
          <span>
            I accept the{" "}
            <Link href="/terms" target="_blank" className="font-medium text-fg underline underline-offset-4">
              beta Terms
            </Link>{" "}
            and the{" "}
            <Link href="/privacy" target="_blank" className="font-medium text-fg underline underline-offset-4">
              Privacy notice
            </Link>
            .
          </span>
        </label>
      </div>

      <FormError message={error && !error.field ? error.message : error?.field === "age" || error?.field === "terms" ? error.message : undefined} />

      <div className="flex flex-col gap-3">
        <Button type="submit" size="lg" loading={pending && method === "email"} disabled={pending} className="w-full" onClick={() => setMethod("email")}>
          {pending && method === "email" ? "Sending the link…" : "Email me a sign-in link"}
        </Button>
        {googleEnabled ? (
          <Button type="submit" variant="outline" size="lg" loading={pending && method === "google"} disabled={pending} className="w-full" onClick={() => setMethod("google")}>
            Continue with Google
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-fg-muted">No password: each sign-in is a link sent to your inbox{googleEnabled ? ", or your Google account with the same address" : ""}.</p>
    </form>
  );
}
