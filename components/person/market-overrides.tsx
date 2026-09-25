import Link from "next/link";

import { cn } from "@/lib/cn";
import { LIVE_TICK_MS } from "@/lib/person/live-series";
import { overrideSentences, type PersonMarketOverrides, type TierMarketDefaults } from "@/lib/person/market-overrides";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";

/**
 * A person's own market settings, where they differ from their tier's
 * (Phase 29d). The explainer promises "where they do, their profile says so";
 * this is where it says so. Nothing renders for a person on the tier's
 * settings, which is almost everyone.
 */
export function MarketOverrides({
  name,
  overrides,
  tier,
  shortingEnabled,
  className,
}: {
  name: string;
  overrides: PersonMarketOverrides;
  tier: TierMarketDefaults | null;
  shortingEnabled: boolean;
  className?: string;
}) {
  if (!tier) return null;
  const sentences = overrideSentences(name, overrides, tier, shortingEnabled, LIVE_TICK_MS);
  if (sentences.length === 0) return null;

  return (
    <section aria-labelledby="market-settings-heading" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader title={`${name}’s market settings`} />
      <h2 id="market-settings-heading" className="sr-only">
        {name}&rsquo;s market settings
      </h2>
      <Card className="flex flex-col gap-3 p-5 text-sm text-fg-secondary sm:p-6">
        {sentences.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </Card>
      <p className="px-1 text-xs text-fg-faint">
        {name} carries these settings in place of the tier&rsquo;s; everything else follows the limits in{" "}
        <Link href="/how-the-price-works" className="text-fg-muted underline-offset-4 hover:underline">
          How the price works
        </Link>
        .
      </p>
    </section>
  );
}
