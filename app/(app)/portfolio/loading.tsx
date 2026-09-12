import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonPersonRow } from "@/components/ui/skeleton";

/** Route-level loading state: the portfolio's shape, shimmering, never a blank flash. */
export default function PortfolioLoading() {
  return (
    <div className="flex flex-col gap-10 animate-fade-in" aria-busy aria-label="Loading">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>

      <Card className="flex flex-col gap-8 p-6 sm:p-8">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3 w-24 bg-surface-raised" />
          <Skeleton className="h-12 w-56 sm:h-14" />
          <Skeleton className="h-3 w-72 max-w-full bg-surface-raised" />
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="flex flex-col gap-2.5">
              <Skeleton className="h-3 w-16 bg-surface-raised" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
      </Card>

      <div className="flex flex-col gap-4">
        <Skeleton className="h-3 w-28" />
        <Card className="flex flex-col gap-4 p-6 sm:p-8">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-20 bg-surface-raised" />
            <Skeleton className="h-9 w-44 rounded-full bg-surface-raised" />
          </div>
          <Skeleton className="h-56 w-full bg-surface-raised sm:h-72" />
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Skeleton className="h-3 w-28" />
        <Card className="flex flex-col divide-y divide-line">
          <SkeletonPersonRow />
          <SkeletonPersonRow />
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Skeleton className="h-3 w-24" />
        <Card className="flex flex-col divide-y divide-line">
          <SkeletonPersonRow />
          <SkeletonPersonRow />
          <SkeletonPersonRow />
        </Card>
      </div>
    </div>
  );
}
