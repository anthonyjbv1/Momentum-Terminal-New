import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonFeedItem } from "@/components/ui/skeleton";

/** Rail loading state, matching the feed preview's shape. */
export default function RailLoading() {
  return (
    <div className="flex flex-col gap-4 animate-fade-in" aria-busy aria-label="Loading feed">
      <div className="flex items-center justify-between px-1">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <Card className="flex flex-col divide-y divide-line">
        {[0, 1, 2, 3].map((index) => (
          <SkeletonFeedItem key={index} />
        ))}
      </Card>
    </div>
  );
}
