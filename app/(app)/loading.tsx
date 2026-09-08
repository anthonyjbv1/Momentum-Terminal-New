import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonPersonRow } from "@/components/ui/skeleton";

/** Route-level loading state: the page's shape, shimmering, never a blank flash. */
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-10 animate-fade-in" aria-busy aria-label="Loading">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
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
