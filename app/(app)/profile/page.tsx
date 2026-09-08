import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";

import { SignOutButton } from "@/components/auth/SignOutButton";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PhaseNotice } from "@/components/ui/phase-notice";
import { SkeletonStat } from "@/components/ui/skeleton";
import { getCurrentProfile, requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  const user = await requireUser("/profile");

  let profile: Awaited<ReturnType<typeof getCurrentProfile>> = null;
  try {
    profile = await getCurrentProfile();
  } catch (error) {
    unstable_rethrow(error);
    console.warn("[profile] could not load profile row:", error instanceof Error ? error.message : error);
  }

  const name = profile?.display_name ?? user.email ?? "You";

  return (
    <div className="flex flex-col gap-10">
      <PageHeader title={name} description={profile ? `@${profile.username}` : undefined} actions={<SignOutButton />} />

      <Card>
        <CardContent className="flex items-center gap-6">
          <Avatar name={name} src={profile?.avatar_url} size="xl" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="truncate text-xl font-semibold tracking-tight text-fg">{name}</p>
            <p className="truncate text-sm text-fg-muted">{user.email}</p>
            {profile ? (
              <p className="text-sm text-fg-faint">
                Member since {new Date(profile.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat className="col-span-2 sm:col-span-1" />
      </div>

      <PhaseNotice phase="Phase 6f">Stats, activity and settings arrive with the profile build.</PhaseNotice>
    </div>
  );
}
