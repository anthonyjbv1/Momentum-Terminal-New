import Image from "next/image";
import Link from "next/link";

import { cn } from "@/lib/cn";

/** The brand asset, byte-for-byte: public/brand/momentum-mark.png. */
export const MOMENTUM_MARK_SRC = "/brand/momentum-mark.png";
const MARK_INTRINSIC_SIZE = 1254;

/**
 * The Momentum Terminal mark — the supplied artwork itself, unmodified.
 *
 * The file is a white orbital mark on an opaque black tile. `mix-blend-mode:
 * screen` composites that away wherever the mark sits: screen keeps white
 * pixels white and lets black pixels show whatever is behind them,
 * anti-aliased edges included. So the image is never edited or redrawn — CSS
 * does the compositing, and the mark reads correctly on the black banner and
 * on grey cards alike.
 *
 * One rule when placing it: a blended element composites against the nearest
 * stacking context, so an ANCESTOR carrying `opacity`, `transform`, `filter`
 * or `isolate` seals the mark off from the surface behind it and the black
 * tile snaps back. Put such effects on the mark itself (as its own opacity,
 * which stays outside the blend) or on its siblings, never on a wrapper
 * around it.
 */
export function MomentumMark({ className }: { className?: string }) {
  return (
    <Image
      src={MOMENTUM_MARK_SRC}
      alt=""
      width={MARK_INTRINSIC_SIZE}
      height={MARK_INTRINSIC_SIZE}
      priority
      className={cn("size-8 shrink-0 mix-blend-screen", className)}
    />
  );
}

/** Mark + wordmark, linking home. The wordmark hides on the narrowest screens. */
export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Momentum Terminal — Home"
      className={cn(
        "group flex shrink-0 items-center gap-2.5 rounded-full text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {/* The dim lives on each child, never on this link: an ancestor opacity
          would isolate the mark's blend and reveal its black tile. */}
      <MomentumMark className="size-9 transition-opacity group-hover:opacity-75" />
      <span className="hidden items-baseline gap-1.5 text-base font-semibold tracking-tight transition-opacity group-hover:opacity-75 sm:flex">
        Momentum
        <span className="font-normal text-fg-muted">Terminal</span>
      </span>
    </Link>
  );
}
