import { Logo } from "@/components/brand/momentum-mark";
import { CountdownTimer } from "@/components/ui/countdown-timer";

import { DesktopNav } from "./desktop-nav";
import { ProfileButton } from "./profile-button";
import { PulseIndicator } from "./pulse-indicator";
import { SearchButton } from "./search-button";

/**
 * The persistent top banner: mark, navigation (desktop), platform pulse,
 * the quiet 30-second countdown, search and profile. Fixed, translucent,
 * and layered above every sheet so the timer is always in view.
 */
export function TopBanner({ variant = "app" }: { variant?: "app" | "minimal" }) {
  return (
    <header className="fixed inset-x-0 top-0 z-(--z-banner) h-banner border-b border-line bg-canvas/80 backdrop-blur-xl">
      <div className="mx-auto flex h-full max-w-shell items-center gap-4 px-5 sm:gap-6 sm:px-8">
        <Logo />
        {variant === "app" ? <DesktopNav className="ml-2 hidden md:flex" /> : null}

        <div className="ml-auto flex items-center gap-2.5 sm:gap-3">
          <PulseIndicator mood={null} status="standby" />
          <CountdownTimer size="banner" className="mx-1" />
          <SearchButton />
          <ProfileButton />
        </div>
      </div>
    </header>
  );
}
