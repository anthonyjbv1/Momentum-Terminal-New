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

import { EditProfileSheet } from "./edit-profile-sheet";
import { ReferralLink } from "./referral-link";
import { DisplayNameForm, EmailUpdatesForm } from "./settings-forms";

/**
 * THE MEMBER PROFILE (Phase 32), behind BETA_SIGNUP_ENABLED: who you are
 * here, what you have done, who you follow, and the settings. The forecast
 * record has its own section already, holding its place until accuracy can
 * be measured. Every word is in lib/profile/copy.ts.
 *
 * THE SOCIAL HEADER (2026-09-28): under the name, the handle and the join
 * date sit three counts (Following, Forecasts, Trades), each a link to its
 * section; then the bio, when there is one; then the one Edit profile
 * control, which opens the sheet with the photo, the name and the bio. No
 * followers yet: that arrives with user-to-user follows and public profiles.
 */
export function MemberProfile({ view }: { view: ProfileView }) {
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <Avatar name={view.displayName} src={view.avatarSrc} size="2xl" initialsUnderImage={view.hasUploadedPhoto} />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="truncate text-4xl font-bold tracking-tighter text-fg sm:text-5xl">{view.displayName}</h1>
            <p className="text-base text-fg-muted">@{view.username}</p>
            <p className="text-sm text-fg-muted">{PROFILE.joined.replace("{date}", joinDate(view.joinedAt))}</p>
          </div>
          <dl className="grid max-w-sm grid-cols-3" data-testid="profile-stats">
            <StatLink href="#following" label={PROFILE.stats.following} value={view.following.length} />
            <StatLink href="#forecasts" label={PROFILE.stats.forecasts} value={view.activity.forecasts} />
            <StatLink href="/portfolio" label={PROFILE.stats.trades} value={view.activity.trades} />
          </dl>
          {view.bio ? <p className="max-w-prose text-base text-fg-secondary">{view.bio}</p> : null}
          <EditProfileSheet displayName={view.displayName} bio={view.bio} hasPhoto={view.hasUploadedPhoto} />
        </div>
      </header>

      {/* Trades and Forecasts are in the header now; what is left is one line, not a box with one tile. */}
      <Section title={PROFILE.activity.title}>
        <p className="px-1 text-base text-fg-secondary">
          <span className="font-medium tabular-nums text-fg">{view.activity.openPositions.toLocaleString("en-US")}</span> {view.activity.openPositions === 1 ? PROFILE.activity.openPositionOne : PROFILE.activity.openPositionsMany}
          <span className="text-fg-faint" aria-hidden>
            {" "}
            ·{" "}
          </span>
          <Link href="/portfolio" className="font-medium text-fg-secondary hover:text-fg">
            {PROFILE.activity.portfolio}
          </Link>
        </p>
      </Section>

      <Section id="forecasts" title={PROFILE.record.title}>
        <Card tone="ghost" className="p-5 sm:p-6">
          <p className="max-w-prose text-sm text-fg-muted">{PROFILE.record.body}</p>
        </Card>
      </Section>

      <Section
        id="following"
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
          <div className="flex flex-col gap-2 border-t border-line pt-5">
            <Link href="/start?step=tour&return=profile" className={buttonClassName("outline", "sm", "self-start")}>
              {PROFILE.settings.tour}
            </Link>
            <p className="text-xs text-fg-muted">{PROFILE.settings.tourHint}</p>
          </div>
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

function Section({ id, title, meta, children }: { id?: string; title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-24 flex-col gap-4">
      <SectionHeader title={title} meta={meta} />
      {children}
    </section>
  );
}

/** One count in the header: the number, bold, above its small label, centred in its column; the whole thing a link. */
function StatLink({ href, label, value }: { href: string; label: string; value: number }) {
  return (
    <a href={href} className="group flex min-w-0 flex-col items-center gap-0.5 rounded-lg text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
      <dd className="text-xl font-semibold tracking-tight tabular-nums text-fg sm:text-2xl">{value.toLocaleString("en-US")}</dd>
      <dt className="text-xs text-fg-muted transition-colors group-hover:text-fg-secondary sm:text-sm">{label}</dt>
    </a>
  );
}

