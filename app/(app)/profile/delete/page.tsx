import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DeleteForm } from "@/components/profile/delete-form";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { isBetaSignupEnabled } from "@/lib/env";
import { DELETE_PAGE } from "@/lib/profile/copy";
import { DELETE_REFUSALS } from "@/lib/profile/model";
import { getMyProfileView } from "@/lib/profile/server";

export const metadata: Metadata = { title: "Delete your account", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * /profile/delete (Phase 32): what deletion does, said before the box is
 * ticked. The same lists the Privacy notice gives, from the same facts as
 * delete_my_account(). Open positions are named up front, so nobody ticks
 * the box only to be refused.
 */
export default async function DeleteAccountPage() {
  if (!isBetaSignupEnabled()) notFound();
  const view = await getMyProfileView();
  if (!view) redirect("/login?next=/profile/delete");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-bold tracking-tighter text-fg sm:text-5xl">{DELETE_PAGE.title}</h1>
        <p className="text-base text-fg-secondary">{DELETE_PAGE.intro}</p>
      </div>

      <Card className="flex flex-col gap-3 p-5 sm:p-6">
        <h2 className="text-lg font-semibold tracking-tight text-fg">{DELETE_PAGE.deleted.title}</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-fg-secondary">
          {DELETE_PAGE.deleted.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Card>

      <Card className="flex flex-col gap-3 p-5 sm:p-6">
        <h2 className="text-lg font-semibold tracking-tight text-fg">{DELETE_PAGE.kept.title}</h2>
        <p className="text-sm text-fg-secondary">{DELETE_PAGE.kept.body}</p>
      </Card>

      <div className="flex flex-col gap-2 px-1 text-sm text-fg-muted">
        <p>{DELETE_PAGE.backups}</p>
        <p>{DELETE_PAGE.rejoin}</p>
      </div>

      {view.isOperator ? (
        <p role="note" className="rounded-xl bg-surface-raised p-4 text-sm text-fg">
          {DELETE_REFUSALS.operator}
        </p>
      ) : view.activity.openPositions > 0 ? (
        <div role="note" className="flex flex-col gap-3 rounded-xl bg-surface-raised p-4">
          <p className="text-sm text-fg">{DELETE_REFUSALS.open_positions}</p>
          <Link href="/portfolio" className={buttonClassName("outline", "sm", "self-start")}>
            {DELETE_PAGE.portfolio}
          </Link>
        </div>
      ) : (
        <DeleteForm />
      )}
    </div>
  );
}
