import { cn } from "@/lib/cn";

/**
 * The platforms' own marks, drawn to their brand guidelines and never
 * recoloured: YouTube's icon (its red, a white play), Twitch's Glitch (its
 * purple). Their colours are the fixed brand tokens in tokens.css, not the
 * theme's. Decorative wherever they stand beside the platform's name.
 */

export function YouTubeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0", className)} aria-hidden focusable="false">
      <path
        className="fill-brand-youtube"
        d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81Z"
      />
      <path className="fill-brand-youtube-play" d="M9.55 15.57V8.43L15.82 12l-6.27 3.57Z" />
    </svg>
  );
}

export function TwitchMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0", className)} aria-hidden focusable="false">
      <path
        className="fill-brand-twitch"
        d="M11.57 4.71h1.72v5.15h-1.72Zm4.72 0H18v5.15h-1.71ZM6 0 1.71 4.29v15.42h5.15V24l4.28-4.29h3.43L21.43 12V0Zm13.71 11.14-3.42 3.43h-3.43l-3 3v-3H6.86V1.71h12.85Z"
      />
    </svg>
  );
}
