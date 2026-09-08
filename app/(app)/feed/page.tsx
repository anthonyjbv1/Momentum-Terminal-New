import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PhaseNotice } from "@/components/ui/phase-notice";
import { SkeletonFeedItem } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Feed" };

export default function FeedPage() {
  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Feed"
        description="What moved, and why: the Engine's read on every signal, as it lands."
        actions={
          <Badge tone="warning" dot>
            Standby
          </Badge>
        }
      />

      <Card className="divide-y divide-line overflow-hidden">
        <SkeletonFeedItem />
        <SkeletonFeedItem />
        <SkeletonFeedItem />
        <SkeletonFeedItem />
        <SkeletonFeedItem />
        <SkeletonFeedItem />
      </Card>

      <PhaseNotice phase="Phase 6b">The live feed streams here, and beside Home on desktop.</PhaseNotice>
    </div>
  );
}
