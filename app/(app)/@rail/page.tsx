import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";
import { PhaseNotice } from "@/components/ui/phase-notice";
import { SkeletonFeedItem } from "@/components/ui/skeleton";

/** Home's desktop rail: where the live feed sits beside the board (6b). */
export default function HomeRail() {
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Live feed"
        meta={
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
      </Card>
      <PhaseNotice phase="Phase 6b">Signals and narratives stream here as the Engine ticks.</PhaseNotice>
    </div>
  );
}
