import type { Metadata } from "next";

import { Card } from "@/components/ui/card";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { PhaseNotice } from "@/components/ui/phase-notice";
import { SkeletonPersonRow, SkeletonStat } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Home" };

/** Home: the momentum board. Person cards with live scores arrive in 6b. */
export default function HomePage() {
  return (
    <div className="flex flex-col gap-10">
      <PageHeader title="Home" description="Every person the Engine tracks, ranked by momentum. Buy the ones heating up, sell the ones cooling off." />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat />
      </div>

      <section className="flex flex-col gap-4">
        <SectionHeader title="People" meta="Ranked by momentum" />
        <Card className="divide-y divide-line overflow-hidden">
          <SkeletonPersonRow />
          <SkeletonPersonRow />
          <SkeletonPersonRow />
          <SkeletonPersonRow />
          <SkeletonPersonRow />
          <SkeletonPersonRow />
        </Card>
      </section>

      <PhaseNotice phase="Phase 6b">Person cards with live Momentum Scores land here.</PhaseNotice>
    </div>
  );
}
