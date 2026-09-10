import Link from "next/link";

import type { FeedPreviewItem } from "@/lib/home/board";
import { relativeTime } from "@/lib/home/relative-time";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";

/**
 * The desktop rail: the newest Engine narratives and raw signals, read only.
 * The full Feed page is a later phase; this is the glanceable preview beside
 * the board.
 */
export function FeedPreview({ items }: { items: FeedPreviewItem[] }) {
  const live = items.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Live feed"
        meta={
          live ? (
            <Badge tone="positive" dot>
              Live
            </Badge>
          ) : (
            <Badge tone="warning" dot>
              Standby
            </Badge>
          )
        }
      />

      {live ? (
        <Card className="flex flex-col divide-y divide-line">
          {items.map((item) => (
            <FeedRow key={item.id} item={item} />
          ))}
        </Card>
      ) : (
        <Card tone="ghost">
          <div className="flex flex-col gap-2 px-5 py-8 text-center">
            <p className="text-sm font-medium text-fg-secondary">Nothing in the Feed yet</p>
            <p className="text-sm text-fg-muted">Signals and the Engine&rsquo;s read on them appear here once ingestion runs.</p>
          </div>
        </Card>
      )}
    </div>
  );
}

function FeedRow({ item }: { item: FeedPreviewItem }) {
  return (
    <article className="flex flex-col gap-2 px-5 py-4">
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        {item.personSlug ? (
          <Link
            href={`/person/${item.personSlug}`}
            className="truncate font-medium text-fg-secondary underline-offset-4 transition-colors hover:text-fg hover:underline"
          >
            {item.personName}
          </Link>
        ) : (
          <span className="truncate font-medium text-fg-secondary">{item.personName}</span>
        )}
        <span aria-hidden>·</span>
        <time dateTime={item.occurredAt} className="shrink-0 num text-xs">
          {relativeTime(item.occurredAt)}
        </time>
      </div>

      <p className="text-sm leading-relaxed text-fg-secondary">{item.text}</p>

      {item.source ? <p className="text-xs text-fg-faint">{item.source}</p> : null}
    </article>
  );
}
