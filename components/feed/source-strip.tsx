"use client";

import { Activity, ArrowUpRight, FileText, Newspaper, Trophy } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { sourceGlyph, sourceIconUrl, type StorySource } from "@/lib/feed/story-card";
import { TwitchMark, YouTubeMark } from "@/components/ui/brand-marks";

/**
 * The source strip (Phase 34): every source behind a story, each with its
 * icon, its name, how many of the story's signals it supplied when more than
 * one, and a link to the piece where there is one. A platform's icon is its
 * own mark (YouTube, Twitch); a publisher's is its favicon, fetched from the
 * icon service at render, with its initial standing in when the icon does
 * not arrive; a metric or data source's is a neutral glyph. Small, grey,
 * last: the strip is attribution, not decoration.
 */
export function SourceStrip({ sources, className }: { sources: StorySource[]; className?: string }) {
  if (sources.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)} aria-label="Sources">
      {sources.map((source) => (
        <li key={source.name} className="min-w-0">
          {source.link ? (
            <a
              href={source.link}
              target="_blank"
              rel="noopener noreferrer"
              className="group/source inline-flex max-w-full items-center gap-1.5 rounded-md text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
            >
              <SourceIcon source={source} />
              <span className="truncate">{source.name}</span>
              {source.count > 1 ? <span className="num text-fg-faint">{source.count}</span> : null}
              <ArrowUpRight className="size-3 shrink-0 text-fg-faint transition-colors group-hover/source:text-fg-muted" aria-hidden />
            </a>
          ) : (
            <span className="inline-flex max-w-full items-center gap-1.5 text-xs text-fg-muted">
              <SourceIcon source={source} />
              <span className="truncate">{source.name}</span>
              {source.count > 1 ? <span className="num text-fg-faint">{source.count}</span> : null}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const NEUTRAL_GLYPHS = { news: Newspaper, game: Trophy, filing: FileText, metric: Activity } as const;

function SourceIcon({ source }: { source: StorySource }) {
  const [failed, setFailed] = useState(false);
  const glyph = sourceGlyph(source);
  if (glyph === "youtube") return <YouTubeMark />;
  if (glyph === "twitch") return <TwitchMark />;
  if (glyph !== "favicon") {
    const Glyph = NEUTRAL_GLYPHS[glyph];
    return <Glyph className="size-4 shrink-0 text-fg-faint" aria-hidden />;
  }
  const url = source.domain && !failed ? sourceIconUrl(source.domain) : null;
  if (url) {
    return (
      <span className="relative size-4 shrink-0 overflow-hidden rounded-sm bg-surface-raised">
        <Image src={url} alt="" width={16} height={16} unoptimized className="size-4" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-surface-raised text-2xs font-semibold leading-none text-fg-secondary" aria-hidden>
      {source.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
