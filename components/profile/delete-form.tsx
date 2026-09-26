"use client";

import Link from "next/link";
import { useActionState } from "react";

import { deleteAccountAction, type DeleteState } from "@/app/(app)/profile/actions";
import { Button, buttonClassName } from "@/components/ui/button";
import { DELETE_PAGE } from "@/lib/profile/copy";

/**
 * The one control that deletes an account (Phase 32): an unticked box that
 * says what it means, and a button. A refusal (open positions, most often)
 * comes back in plain words with the way forward.
 */
export function DeleteForm({ initialState }: { initialState?: DeleteState }) {
  const [state, action, pending] = useActionState(deleteAccountAction, initialState ?? {});
  return (
    <form action={action} className="flex flex-col gap-5">
      <label className="flex items-start gap-3 text-sm text-fg-secondary">
        <input type="checkbox" name="confirm" required className="mt-0.5 size-4 shrink-0 accent-[var(--color-fg)]" />
        <span>{DELETE_PAGE.confirm}</span>
      </label>
      {state.error ? (
        <div role="alert" className="flex flex-col gap-3 rounded-xl bg-surface-raised p-4">
          <p className="text-sm text-fg">{state.error}</p>
          {state.code === "open_positions" ? (
            <Link href="/portfolio" className={buttonClassName("outline", "sm", "self-start")}>
              {DELETE_PAGE.portfolio}
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Link href="/profile" className={buttonClassName("outline", "lg")}>
          {DELETE_PAGE.cancel}
        </Link>
        <Button type="submit" variant="primary" size="lg" loading={pending} disabled={pending}>
          {DELETE_PAGE.submit}
        </Button>
      </div>
    </form>
  );
}
