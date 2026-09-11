import { getCurrentUser } from "@/lib/auth";
import { Logo } from "@/components/brand/momentum-mark";
import { CountdownTimer } from "@/components/ui/countdown-timer";

import { BalanceChip } from "./balance-chip";
import { DesktopNav } from "./desktop-nav";
import { ProfileButton } from "./profile-button";
import { PulseIndicator } from "./pulse-indicator";
import { SearchButton } from "./search-button";

/**
 * The persistent top banner: mark, navigation (desktop), the paper balance
 * (signed in), platform pulse, the quiet 30-second countdown, search and
 * profile. Fixed, translucent, and layered above every sheet so the timer
 * is always in view. On a phone the balance takes the pulse's slot when a
 * user is signed in; the pulse returns from the sm breakpoint up.
 */
export async function TopBanner({ variant = "app" }: { variant?: "app" | "minimal" }) {
  // Behavioural logging only runs for a signed-in user; signed out, those
  // events would be rejected by the log endpoint anyway.
  const user = await getCurrentUser().catch(() => null);

  return (
    <header className="fixed inset-x-0 top-0 z-(--z-banner) h-banner border-b border-line bg-canvas/80 backdrop-blur-xl">
      <div className="mx-auto flex h-full max-w-shell items-center gap-4 px-5 sm:gap-6 sm:px-8">
        <Logo />
        {variant === "app" ? <DesktopNav className="ml-2 hidden md:flex" /> : null}

        <div className="ml-auto flex items-center gap-2.5 sm:gap-3">
          {user ? <BalanceChip /> : null}
          <span className={user ? "hidden sm:contents" : "contents"}>
            <PulseIndicator mood={null} status="standby" />
          </span>
          <CountdownTimer size="banner" className="mx-1" />
          <SearchButton loggingEnabled={Boolean(user)} />
          <ProfileButton />
        </div>
      </div>
    </header>
  );
}
