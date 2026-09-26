"use client";

import { useActionState, useRef, useState } from "react";

import {
  removeAvatarAction,
  updateDisplayNameAction,
  updateEmailUpdatesAction,
  uploadAvatarAction,
  type ProfileFormState,
} from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { PROFILE } from "@/lib/profile/copy";
import { AVATAR_MAX_BYTES, AVATAR_TYPES, DISPLAY_NAME_MAX } from "@/lib/profile/model";

/**
 * The profile's small forms (Phase 32). Each saves on its own and says so in
 * a status line; nothing is saved by leaving the page.
 */

function Status({ state }: { state: ProfileFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-negative">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        {state.ok}
      </p>
    );
  }
  return null;
}

export function DisplayNameForm({ value }: { value: string }) {
  const [state, action, pending] = useActionState(updateDisplayNameAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label={PROFILE.settings.displayName} htmlFor="profile-display-name" hint={PROFILE.settings.displayNameHint}>
        <div className="flex gap-2">
          <Input id="profile-display-name" name="display_name" type="text" required maxLength={DISPLAY_NAME_MAX} defaultValue={value} autoComplete="name" />
          <Button type="submit" variant="outline" size="lg" loading={pending} disabled={pending} className="shrink-0">
            {PROFILE.settings.save}
          </Button>
        </div>
      </Field>
      <Status state={state} />
    </form>
  );
}

export function EmailUpdatesForm({ on }: { on: boolean }) {
  const [state, action, pending] = useActionState(updateEmailUpdatesAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={action} className="flex flex-col gap-2">
      <label className="flex items-start gap-3 text-sm text-fg-secondary">
        <input
          type="checkbox"
          name="email_updates"
          defaultChecked={on}
          disabled={pending}
          onChange={() => formRef.current?.requestSubmit()}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-fg)]"
        />
        <span className="flex flex-col gap-1">
          <span className="font-medium text-fg">{PROFILE.settings.updates}</span>
          <span className="text-fg-muted">{PROFILE.settings.updatesHint}</span>
        </span>
      </label>
      <Status state={state} />
    </form>
  );
}

export function PhotoForm({ hasPhoto }: { hasPhoto: boolean }) {
  const [state, upload, uploading] = useActionState(uploadAvatarAction, {});
  const [removeState, remove, removing] = useActionState(removeAvatarAction, {});
  const [tooBig, setTooBig] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = uploading || removing;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form ref={formRef} action={upload}>
          <input
            ref={inputRef}
            type="file"
            name="photo"
            accept={Object.keys(AVATAR_TYPES).join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (!file) return;
              // The server refuses it anyway; saying so here saves the upload.
              if (file.size > AVATAR_MAX_BYTES) {
                setTooBig(true);
                event.currentTarget.value = "";
                return;
              }
              setTooBig(false);
              formRef.current?.requestSubmit();
            }}
          />
          <Button type="button" variant="outline" size="sm" loading={uploading} disabled={busy} onClick={() => inputRef.current?.click()}>
            {hasPhoto ? PROFILE.photo.change : PROFILE.photo.add}
          </Button>
        </form>
        {hasPhoto ? (
          <form action={remove}>
            <Button type="submit" variant="ghost" size="sm" loading={removing} disabled={busy}>
              {PROFILE.photo.remove}
            </Button>
          </form>
        ) : null}
      </div>
      {tooBig ? (
        <p role="alert" className="text-sm text-negative">
          {PROFILE.photo.tooBig}
        </p>
      ) : (
        <Status state={state.error || state.ok ? state : removeState} />
      )}
      <p className="text-xs text-fg-faint">{PROFILE.photo.hint}</p>
    </div>
  );
}
