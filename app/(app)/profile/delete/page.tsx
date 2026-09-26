import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DeleteAccountView } from "@/components/profile/delete-account-view";
import { isBetaSignupEnabled } from "@/lib/env";
import { getMyProfileView } from "@/lib/profile/server";

/** The title follows the switch: while it is off, the 404 says nothing about what would have been here. */
export function generateMetadata(): Metadata {
  const base: Metadata = { robots: { index: false, follow: false } };
  return isBetaSignupEnabled() ? { ...base, title: "Delete your account" } : base;
}

export const dynamic = "force-dynamic";

/** /profile/delete (Phase 32): what deletion does, said before the box is ticked. */
export default async function DeleteAccountPage() {
  if (!isBetaSignupEnabled()) notFound();
  const view = await getMyProfileView();
  if (!view) redirect("/login?next=/profile/delete");
  return <DeleteAccountView isOperator={view.isOperator} openPositions={view.activity.openPositions} />;
}
