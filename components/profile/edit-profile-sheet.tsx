"use client";

import { useActionState, useState } from "react";

import { updateProfileAction, type ProfileFormState } from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { PROFILE } from "@/lib/profile/copy";
import { BIO_MAX, DISPLAY_NAME_MAX } from "@/lib/profile/model";

import { PhotoForm } from "./settings-forms";

/**
 * EDIT PROFILE: one control under the header, one sheet with the photo
 * (change or remove, as before), the display name and the bio. The name and
 * the bio save together with the validations the settings form already had;
 * the photo saves on its own the moment it is chosen. Nothing is saved by
 * closing the sheet.
 */
export function EditProfileSheet({ displayName, bio, hasPhoto }: { displayName: string; bio: string | null; hasPhoto: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(updateProfileAction, {});
  const [bioLength, setBioLength] = useState([...(bio ?? "")].length);

  return (
    <>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
        {PROFILE.edit.button}
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={PROFILE.edit.title} description={PROFILE.edit.description}>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-fg">{PROFILE.edit.photo}</p>
            <PhotoForm hasPhoto={hasPhoto} />
          </div>

          <form action={action} className="flex flex-col gap-5 border-t border-line pt-5">
            <Field label={PROFILE.settings.displayName} htmlFor="edit-display-name" hint={PROFILE.settings.displayNameHint}>
              <Input id="edit-display-name" name="display_name" type="text" required maxLength={DISPLAY_NAME_MAX} defaultValue={displayName} autoComplete="name" />
            </Field>
            <Field label={PROFILE.edit.bio} htmlFor="edit-bio" hint={`${PROFILE.edit.bioHint} ${bioLength}/${BIO_MAX}.`}>
              <textarea
                id="edit-bio"
                name="bio"
                rows={3}
                maxLength={BIO_MAX}
                defaultValue={bio ?? ""}
                onChange={(event) => setBioLength([...event.currentTarget.value].length)}
                className="w-full resize-none rounded-2xl border border-line bg-surface px-4 py-3 text-base text-fg placeholder:text-fg-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              />
            </Field>
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" size="lg" loading={pending} disabled={pending}>
                {PROFILE.edit.save}
              </Button>
              {state.error ? (
                <p role="alert" className="text-sm text-negative">
                  {state.error}
                </p>
              ) : state.ok ? (
                <p role="status" className="text-sm text-fg-muted">
                  {state.ok}
                </p>
              ) : null}
            </div>
          </form>
        </div>
      </Sheet>
    </>
  );
}
