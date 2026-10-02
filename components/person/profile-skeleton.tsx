import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonFeedItem } from "@/components/ui/skeleton";

/**
 * The profile's shape while its readings load: identity, score and history,
 * the five forces, and (below lg) the signal list, in the order the real
 * sections land. The route's loading file shows the whole thing the moment
 * a person is tapped; once the slug resolves, the header and the score
 * render and the pieces below stand in for the chart, the forces and the
 * signals until each one's read lands (2026-10-02).
 */
export function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-10 animate-fade-in" aria-busy aria-label="Loading">
      {/* Identity */}
      <div className="flex flex-col gap-4">
        <Skeleton className="h-3 w-16" />
        <Card className="p-6 sm:p-8">
          <div className="flex flex-col gap-7 sm:flex-row sm:items-start sm:gap-10">
            <Skeleton className="size-20 rounded-full sm:size-28" />
            <div className="grid flex-1 grid-cols-2 gap-x-6">
              <div className="col-span-2 flex flex-col gap-3 pb-6">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-11 w-64 max-w-full" />
              </div>
              {[0, 1, 2, 3].map((index) => (
                <DossierFieldSkeleton key={index} />
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Score and history */}
      <div className="flex flex-col gap-4">
        <Skeleton className="h-3 w-28" />
        <Card className="flex flex-col gap-8 p-6 sm:p-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="flex flex-col gap-4">
              <Skeleton className="h-14 w-44" />
              <ChangeLineSkeleton />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <div className="hidden gap-2 md:flex">
              <Skeleton className="h-11 w-28 rounded-full" />
              <Skeleton className="h-11 w-28 rounded-full" />
            </div>
          </div>
          <ChartSkeleton />
        </Card>
      </div>

      <ForcesSkeleton />

      {/* Signals (below lg; the rail has its own skeleton) */}
      <SignalsSkeleton className="lg:hidden" />
    </div>
  );
}

/** One field of the identity grid, for the two that wait on a read (State, Conviction). */
export function DossierFieldSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 border-t border-line py-5" aria-hidden>
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-6 w-28" />
    </div>
  );
}

/** The change line under the score, until the series says what changed. */
export function ChangeLineSkeleton() {
  return <Skeleton className="h-4 w-32" />;
}

/** The range toggle and the chart area. */
export function ChartSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy aria-label="Loading score history">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-52 rounded-full" />
      </div>
      <Skeleton className="h-56 w-full sm:h-72" />
    </div>
  );
}

/** The forces panel's five rows. */
export function ForcesSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy aria-label="Loading forces">
      <Skeleton className="h-3 w-28" />
      <Card className="divide-y divide-line">
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="flex items-center gap-6 px-5 py-4">
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-44 max-w-full" />
            </div>
            <Skeleton className="hidden h-1.5 w-40 rounded-full sm:block" />
            <Skeleton className="h-4 w-12" />
          </div>
        ))}
      </Card>
    </div>
  );
}

/** The signal list's first few cards. */
export function SignalsSkeleton({ className }: { className?: string }) {
  return (
    <div className={["flex flex-col gap-4", className].filter(Boolean).join(" ")} aria-busy aria-label="Loading signals">
      <Skeleton className="h-3 w-16" />
      <Card className="divide-y divide-line">
        <SkeletonFeedItem />
        <SkeletonFeedItem />
        <SkeletonFeedItem />
      </Card>
    </div>
  );
}
