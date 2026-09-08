import type { Metadata } from "next";

import { Card } from "@/components/ui/card";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { PhaseNotice } from "@/components/ui/phase-notice";
import { SkeletonPersonRow, SkeletonStat } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <div className="flex flex-col gap-10">
      <PageHeader title="Portfolio" description="Balance, buying power and every open HIGH or LOW position, marked to the latest tick." />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat className="col-span-2 sm:col-span-1" />
      </div>

      <section className="flex flex-col gap-4">
        <SectionHeader title="Open positions" />
        <Card className="divide-y divide-line overflow-hidden">
          <SkeletonPersonRow />
          <SkeletonPersonRow />
          <SkeletonPersonRow />
        </Card>
      </section>

      <PhaseNotice phase="Phase 6d">Positions, P&amp;L and portfolio history arrive with the trading flow.</PhaseNotice>
    </div>
  );
}
