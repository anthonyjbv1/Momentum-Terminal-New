import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonCircle, SkeletonPersonRow } from "@/components/ui/skeleton";

/**
 * Route-level loading state for the member profile (the tab-switch lag fix,
 * 2026-10-04): the header's shape, the three counts, the sections. The tab
 * bar prefetches this boundary, so the tap paints at once instead of waiting
 * on the profile's three reads.
 */
export default function ProfileLoading() {
  return (
    <div className="flex flex-col gap-10 animate-fade-in" aria-busy aria-label="Loading profile">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <SkeletonCircle className="size-24" />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-10 w-56 max-w-full" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="flex gap-6">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex flex-col gap-2">
                <Skeleton className="h-5 w-10" />
                <Skeleton className="h-3 w-16 bg-surface-raised" />
              </div>
            ))}
          </div>
          <Skeleton className="h-9 w-32 rounded-full" />
        </div>
      </div>

      {[0, 1, 2].map((index) => (
        <div key={index} className="flex flex-col gap-4">
          <Skeleton className="h-3 w-28" />
          <Card className="flex flex-col divide-y divide-line">
            <SkeletonPersonRow />
            <SkeletonPersonRow />
          </Card>
        </div>
      ))}
    </div>
  );
}
