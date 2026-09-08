import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonPersonRow } from "@/components/ui/skeleton";

/** Route-level loading state: the page's shape, shimmering, never a blank flash. */
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-8 animate-fade-in" aria-busy aria-label="Loading">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-3.5 w-80 max-w-full" />
      </div>
      <Card className="divide-y divide-line overflow-hidden">
        <SkeletonPersonRow />
        <SkeletonPersonRow />
        <SkeletonPersonRow />
        <SkeletonPersonRow />
      </Card>
    </div>
  );
}
