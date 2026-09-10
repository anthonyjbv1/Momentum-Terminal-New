import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonFeedItem } from "@/components/ui/skeleton";

/** Route-level loading state: the Feed's shape, shimmering, never a blank flash. */
export default function FeedLoading() {
  return (
    <div className="flex flex-col gap-10 animate-fade-in" aria-busy aria-label="Loading">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      <div className="flex gap-2">
        {["w-16", "w-24", "w-28", "w-20", "w-24"].map((width) => (
          <Skeleton key={width} className={`h-9 rounded-full ${width}`} />
        ))}
      </div>

      <div className="flex flex-col gap-4">
        <Skeleton className="h-3 w-16" />
        <Card className="flex flex-col divide-y divide-line">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <SkeletonFeedItem key={index} />
          ))}
        </Card>
      </div>
    </div>
  );
}
