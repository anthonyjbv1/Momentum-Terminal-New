import Link from "next/link";

import { CHROME } from "@/lib/landing/copy";
import { Logo } from "@/components/brand/momentum-mark";
import { CountdownTimer } from "@/components/ui/countdown-timer";

/**
 * The landing page's own header: the mark, the Engine's countdown (the same
 * clock module the app's banner runs on, so the two agree to the second),
 * and the way in for someone who already has an account. Not the app's
 * banner — that one assumes a session and a board to read the mood from.
 */
export function LandingHeader() {
  return (
    <header className="mx-auto flex h-banner w-full max-w-shell items-center justify-between gap-4 px-5 sm:px-8">
      <Logo />
      <div className="flex items-center gap-4 sm:gap-6">
        <CountdownTimer size="banner" />
        <Link href="/login" className="text-sm font-medium text-fg-secondary transition-colors hover:text-fg">
          {CHROME.signIn}
        </Link>
      </div>
    </header>
  );
}
