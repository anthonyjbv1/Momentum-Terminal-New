"use client";

import { Play } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import { cn } from "@/lib/cn";
import type { CardMedia } from "@/lib/feed/card-copy";
import { twitchEmbedUrl, youtubeEmbedUrl, youtubeThumbnailUrl } from "@/lib/feed/story-card";

/**
 * The media a story card may embed (Phase 34): a YouTube video through
 * YouTube's own thumbnail and player, a Twitch clip or channel through
 * Twitch's player. Nothing loads until the reader taps: a Feed of players is
 * a Feed that never finishes loading, and the thumbnail is the whole story
 * for most readers. The embeds are the platforms' official ones; no copy of
 * anyone's picture is hosted here.
 */
export interface StoryMediaProps {
  media: CardMedia;
  /** What the frame is called for a screen reader: the video's or stream's title, or the headline. */
  title: string;
  className?: string;
}

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-surface";

export function StoryMedia({ media, title, className }: StoryMediaProps) {
  const [playing, setPlaying] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  if (playing) {
    // Twitch's players need the embedding page's hostname; it is read at the
    // moment of the tap, so the same card works on every origin it is served from.
    const src = media.kind === "youtube" ? youtubeEmbedUrl(media.videoId) : twitchEmbedUrl(media, window.location.hostname);
    return (
      <div className={cn("relative aspect-video w-full overflow-hidden rounded-xl bg-canvas", className)}>
        <iframe
          src={src}
          title={title}
          className="absolute inset-0 size-full"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    );
  }

  const label = media.kind === "youtube" ? "Play the video" : media.clip ? "Play the clip" : "Open the stream";
  const showThumbnail = media.kind === "youtube" && !thumbnailFailed;

  // A channel with no clip has no picture to show before the tap: a row, not an empty frame.
  if (media.kind === "twitch" && !media.clip) {
    return (
      <button
        type="button"
        onClick={() => setPlaying(true)}
        className={cn("group/media flex w-full items-center gap-3 rounded-xl bg-surface-raised px-4 py-3 text-left transition-colors hover:bg-surface-overlay", focusRing, className)}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-inverse/90 text-fg-inverse">
          <Play className="ml-0.5 size-4" fill="currentColor" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-fg">{label}</span>
          <span className="truncate text-xs text-fg-muted">{media.title ?? `twitch.tv/${media.channel}`}</span>
        </span>
        <span className="shrink-0 text-xs text-fg-faint">Twitch</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={label}
      className={cn("group/media relative block aspect-video w-full overflow-hidden rounded-xl bg-surface-raised text-left", focusRing, className)}
    >
      {showThumbnail ? (
        <Image
          src={youtubeThumbnailUrl(media.videoId)}
          alt=""
          fill
          sizes="100vw"
          unoptimized
          className="object-cover"
          onError={() => setThumbnailFailed(true)}
        />
      ) : null}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-surface-inverse/90 text-fg-inverse shadow-raised transition-transform duration-200 ease-out group-hover/media:scale-105">
          <Play className="ml-0.5 size-6" fill="currentColor" aria-hidden />
        </span>
      </span>
      {!showThumbnail ? (
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 px-4 py-3 text-xs text-fg-muted">
          <span className="truncate">{title}</span>
          <span className="shrink-0">{media.kind === "youtube" ? "YouTube" : "Twitch"}</span>
        </span>
      ) : null}
    </button>
  );
}
