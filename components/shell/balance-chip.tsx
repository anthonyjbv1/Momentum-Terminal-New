import Link from "next/link";
import { unstable_rethrow } from "next/navigation";

import { getCurrentProfile } from "@/lib/auth";
import { formatCents } from "@/lib/money";

/**
 * The paper balance, in the banner, for a signed-in user. It says "Paper"
 * every time: nobody should ever be unclear that this is not real money.
 * Links to the portfolio. Renders nothing when signed out.
 */
export function BalanceChipView({ balanceCents }: { balanceCents: number }) {
  return (
    <Link
      href="/portfolio"
      aria-label={`Paper balance ${formatCents(balanceCents)}`}
      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-surface px-3.5 text-sm transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span className="text-label text-fg-muted">Paper</span>
      <span className="num font-medium text-fg">{formatCents(balanceCents)}</span>
    </Link>
  );
}

export async function BalanceChip() {
  let profile: Awaited<ReturnType<typeof getCurrentProfile>> = null;
  try {
    profile = await getCurrentProfile();
  } catch (error) {
    unstable_rethrow(error);
    console.warn("[shell] could not load balance:", error instanceof Error ? error.message : error);
  }
  if (!profile) return null;

  const balance = Number(profile.wallet_balance_cents);
  return <BalanceChipView balanceCents={Number.isSafeInteger(balance) ? balance : 0} />;
}
