import type { Metadata } from "next";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";
import { PhaseNotice } from "@/components/ui/phase-notice";
import { Skeleton, SkeletonFeedItem, SkeletonStat } from "@/components/ui/skeleton";

type Params = Promise<{ slug: string }>;

/** "kendrick-lamar" → "Kendrick Lamar" until the person record is wired in 6c. */
function nameFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  return { title: nameFromSlug(slug) };
}

export default async function PersonPage({ params }: { params: Params }) {
  const { slug } = await params;
  const name = nameFromSlug(slug);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Avatar name={name} size="lg" />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{name}</h1>
              <Badge tone="outline">Person</Badge>
            </div>
            <p className="num text-sm text-fg-muted">/{slug}</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <Skeleton className="h-12 w-36" />
          <Skeleton className="h-3 w-24" />
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat />
      </div>

      <Card className="h-56 sm:h-72">
        <Skeleton className="size-full rounded-xl" />
      </Card>

      <section className="flex flex-col gap-3">
        <SectionHeader title="Recent signals" />
        <Card className="divide-y divide-line overflow-hidden">
          <SkeletonFeedItem />
          <SkeletonFeedItem />
          <SkeletonFeedItem />
        </Card>
      </section>

      <PhaseNotice phase="Phase 6c">Score history, the five forces, signals and the Buy / Sell actions land here.</PhaseNotice>
    </div>
  );
}
