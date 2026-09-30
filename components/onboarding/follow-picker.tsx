"use client";

import Link from "next/link";
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { followAction } from "@/app/start/actions";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonClassName } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { categoryLabel } from "@/lib/home/board-model";
import { ONBOARDING, previousStep } from "@/lib/onboarding/copy";
import type { RosterEntry } from "@/lib/onboarding/model";

/**
 * Pick people to follow (Phase 32), on the third onboarding screen and again
 * from the profile. Each person is a checkbox, so the form posts exactly the
 * ticked set and the server replaces the follows with it. Selected inverts
 * to white, as the category pills do: colour on this platform means
 * direction, never "chosen".
 */
export interface FollowPickerProps {
  roster: RosterEntry[];
  following: string[];
  mode: "onboarding" | "profile";
}

export function FollowPicker({ roster, following, mode }: FollowPickerProps) {
  const [picked, setPicked] = useState(() => new Set(following));
  const copy = ONBOARDING.follow;
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <form action={followAction} className="flex flex-col gap-6">
      {mode === "profile" ? <input type="hidden" name="return" value="profile" /> : null}
      <div role="group" aria-label={mode === "profile" ? copy.profileTitle : copy.title} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {roster.map((person) => {
          const on = picked.has(person.id);
          return (
            <label
              key={person.id}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/60",
                on ? "bg-surface-inverse text-fg-inverse" : "bg-surface text-fg hover:bg-surface-raised",
              )}
            >
              <input type="checkbox" name="person" value={person.id} checked={on} onChange={() => toggle(person.id)} className="sr-only" />
              <Avatar name={person.name} src={person.avatarUrl} size="sm" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{person.name}</span>
                <span className={cn("text-xs", on ? "text-fg-inverse/70" : "text-fg-muted")}>{categoryLabel(person.category)}</span>
              </span>
              <span aria-hidden className={cn("ml-auto text-sm", on ? "opacity-100" : "opacity-0")}>
                ✓
              </span>
            </label>
          );
        })}
      </div>

      <p role="status" className="px-1 text-sm tabular-nums text-fg-muted">
        {picked.size === 0 ? copy.none : copy.picked.replace("{count}", String(picked.size))}
      </p>

      <div className="flex items-center justify-between gap-3 px-1">
        {mode === "profile" ? (
          <Link href="/profile" className={buttonClassName("outline", "lg")}>
            {copy.cancel}
          </Link>
        ) : (
          <Link href={`/start?step=${previousStep("follow")}`} className={buttonClassName("outline", "lg")}>
            {ONBOARDING.back}
          </Link>
        )}
        <SaveButton label={mode === "profile" ? copy.profileSave : copy.save} />
      </div>
    </form>
  );
}

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" loading={pending} disabled={pending} className="min-w-32">
      {label}
    </Button>
  );
}
