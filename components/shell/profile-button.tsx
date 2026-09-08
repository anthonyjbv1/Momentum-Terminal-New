import { CircleUser } from "lucide-react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";

import { getCurrentProfile } from "@/lib/auth";
import { Avatar } from "@/components/ui/avatar";
import { buttonClassName } from "@/components/ui/button";

/** Banner profile access: the signed-in user's avatar, or a sign-in link. */
export async function ProfileButton() {
  let profile: Awaited<ReturnType<typeof getCurrentProfile>> = null;
  try {
    profile = await getCurrentProfile();
  } catch (error) {
    // Let Next's own control-flow errors (dynamic rendering, redirects) through.
    unstable_rethrow(error);
    console.warn("[shell] could not load profile:", error instanceof Error ? error.message : error);
  }

  if (!profile) {
    return (
      <>
        <Link href="/login" aria-label="Sign in" className={buttonClassName("outline", "icon", "size-10 sm:hidden")}>
          <CircleUser />
        </Link>
        <Link href="/login" className={buttonClassName("primary", "sm", "hidden sm:inline-flex")}>
          Sign in
        </Link>
      </>
    );
  }

  return (
    <Link
      href="/profile"
      aria-label={`Profile: ${profile.display_name}`}
      className="flex size-10 items-center justify-center rounded-full transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Avatar name={profile.display_name} src={profile.avatar_url} size="md" />
    </Link>
  );
}
