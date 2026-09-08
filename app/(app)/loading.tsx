import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonPersonRow } from "@/components/ui/skeleton";

/** Route-level loading state: Home's shape, shimmering, never a blank flash. */
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-10 animate-fade-in" aria-busy aria-label="Loading">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      <div className="flex gap-2">
        {["w-16", "w-24", "w-28", "w-20"].map((width) => (
          <Skeleton key={width} className={`h-9 rounded-full ${width}`} />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="flex flex-col gap-5 p-5">
            <div className="flex items-start justify-between">
              <Skeleton className="size-10 rounded-full" />
              <Skeleton className="h-3 w-6" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-6 w-full" />
          </Card>
        ))}
      </div>

      <Card className="flex flex-col divide-y divide-line">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <SkeletonPersonRow key={index} />
        ))}
      </Card>
    </div>
  );
}
