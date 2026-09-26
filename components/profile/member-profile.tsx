import Link from "next/link";
import type { ReactNode } from "react";

import { SignOutButton } from "@/components/auth/SignOutButton";
import { Avatar } from "@/components/ui/avatar";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/page-header";
import { PROFILE } from "@/lib/profile/copy";
import { joinDate } from "@/lib/profile/model";
import type { ProfileView } from "@/lib/profile/server";

import { ReferralLink } from "./referral-link";
import { DisplayNameForm, EmailUpdatesForm, PhotoForm } from "./settings-forms";

/**
 * THE MEMBER PROFILE (Phase 32), behind BETA_SIGNUP_ENABLED: who you are
 * here, what you have done, who you follow, and the settings. The forecast
 * record has its own section already, holding its place until accuracy can
 * be measured. Every word is in lib/profile/copy.ts.
 */
export function MemberProfile({ view }: { view: ProfileView }) {
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <Avatar name={view.displayName} src={view.avatarSrc} size="2xl" initialsUnderImage={view.hasUploadedPhoto} />
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="truncate text-4xl font-bold tracking-tighter text-fg sm:text-5xl">{view.displayName}</h1>
            <p className="text-base text-fg-muted">
              @{view.username}
              <span aria-hidden> · </span>
              {PROFILE.joined.replace("{date}", joinDate(view.joinedAt))}
            </p>
          </div>
          <PhotoForm hasPhoto={view.hasUploadedPhoto} />
        </div>
      </header>

      <Section title={PROFILE.activity.title} meta={<Link href="/portfolio" className="font-medium text-fg-secondary hover:text-fg">{PROFILE.activity.portfolio}</Link>}>
        <Card className="grid grid-cols-3 divide-x divide-line">
          <Stat label={PROFILE.activity.openPositions} value={view.activity.openPositions} />
          <Stat label={PROFILE.activity.trades} value={view.activity.trades} />
          <Stat label={PROFILE.activity.forecasts} value={view.activity.forecasts} />
        </Card>
      </Section>

      <Section title={PROFILE.record.title}>
        <Card tone="ghost" className="p-5 sm:p-6">
          <p className="max-w-prose text-sm text-fg-muted">{PROFILE.record.body}</p>
        </Card>
      </Section>

      <Section
        title={PROFILE.following.title}
        meta={
          <Link href="/start?step=follow&return=profile" className="font-medium text-fg-secondary hover:text-fg">
            {view.following.length > 0 ? PROFILE.following.change : PROFILE.following.pick}
          </Link>
        }
      >
        {view.following.length > 0 ? (
          <Card className="flex flex-col divide-y divide-line">
            {view.following.map((person) => (
              <Link key={person.id} href={`/person/${person.slug}`} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-raised">
                <Avatar name={person.name} src={person.avatarUrl} size="sm" />
                <span className="truncate text-sm font-medium text-fg">{person.name}</span>
              </Link>
            ))}
          </Card>
        ) : (
          <p className="px-1 text-sm text-fg-muted">{PROFILE.following.none}</p>
        )}
      </Section>

      {view.referralLink ? (
        <Section title={PROFILE.referral.title}>
          <Card className="flex flex-col gap-4 p-5 sm:p-6">
            <p className="text-sm text-fg-secondary">{PROFILE.referral.body}</p>
            <ReferralLink link={view.referralLink} />
          </Card>
        </Section>
      ) : null}

      <Section title={PROFILE.settings.title}>
        <Card className="flex flex-col gap-6 p-5 sm:p-6">
          <Field label={PROFILE.settings.email} htmlFor="profile-email" hint={PROFILE.settings.emailHint}>
            <Input id="profile-email" type="email" value={view.email} readOnly aria-readonly className="text-fg-secondary" />
          </Field>
          <DisplayNameForm value={view.displayName} />
          <EmailUpdatesForm on={view.emailUpdates} />
        </Card>
      </Section>

      <Section title={PROFILE.account.title}>
        <Card className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <SignOutButton />
          {view.isOperator ? null : (
            <div className="flex flex-col gap-2 sm:items-end">
              <Link href="/profile/delete" className={buttonClassName("ghost", "sm", "self-start sm:self-end")}>
                {PROFILE.account.delete}
              </Link>
              <p className="text-xs text-fg-muted sm:text-right">{PROFILE.account.deleteHint}</p>
            </div>
          )}
        </Card>
      </Section>
    </div>
  );
}

function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <SectionHeader title={title} meta={meta} />
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-5 sm:px-6">
      <p className="text-2xl font-semibold tracking-tight tabular-nums text-fg">{value.toLocaleString("en-US")}</p>
      <p className="text-xs text-fg-muted sm:text-sm">{label}</p>
    </div>
  );
}
