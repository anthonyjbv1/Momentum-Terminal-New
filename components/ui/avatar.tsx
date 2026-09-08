import Image from "next/image";

import { cn } from "@/lib/cn";

/**
 * Person / user avatar with a consistent fallback: initials on a raised
 * surface inside a hairline ring. Images fill the circle.
 */
export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

const avatarSizes: Record<AvatarSize, { box: string; text: string; px: number }> = {
  xs: { box: "size-6", text: "text-2xs", px: 24 },
  sm: { box: "size-8", text: "text-xs", px: 32 },
  md: { box: "size-10", text: "text-sm", px: 40 },
  lg: { box: "size-14", text: "text-base", px: 56 },
  xl: { box: "size-20", text: "text-xl", px: 80 },
  "2xl": { box: "size-28", text: "text-3xl", px: 112 },
};

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: AvatarSize;
  className?: string;
  /** Emphasised ring (e.g. the active profile button). */
  ring?: "default" | "accent" | "positive";
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

const rings = {
  default: "ring-line",
  accent: "ring-accent",
  positive: "ring-positive",
};

export function Avatar({ name, src, size = "md", className, ring = "default" }: AvatarProps) {
  const dims = avatarSizes[size];
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-surface-raised font-semibold text-fg-secondary ring-1",
        dims.box,
        dims.text,
        rings[ring],
        className,
      )}
      role="img"
      aria-label={name}
    >
      {src ? (
        <Image src={src} alt="" fill sizes={`${dims.px}px`} unoptimized className="object-cover" />
      ) : (
        <span aria-hidden>{initialsFor(name)}</span>
      )}
    </span>
  );
}
