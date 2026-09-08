import { Logo } from "@/components/brand/momentum-mark";
import { CountdownTimer } from "@/components/ui/countdown-timer";

import { DesktopNav } from "./desktop-nav";
import { ProfileButton } from "./profile-button";
import { PulseIndicator } from "./pulse-indicator";
import { SearchButton } from "./search-button";

/**
 * The persistent top banner: mark, navigation (desktop), platform pulse,
 * the 30-second countdown, search and profile. Fixed, translucent, and
 * layered above every sheet so the timer is always in view.
 */
export function TopBanner({ variant = "app" }: { variant?: "app" | "minimal" }) {
  return (
    <header className="fixed inset-x-0 top-0 z-(--z-banner) h-banner border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-shell items-center gap-3 px-4 sm:gap-4 sm:px-6">
        <Logo />
        {variant === "app" ? <DesktopNav className="ml-3 hidden md:flex" /> : null}

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <PulseIndicator mood={null} status="standby" />
          <CountdownTimer size="banner" />
          <span aria-hidden className="hidden h-5 w-px bg-line sm:block" />
          <SearchButton />
          <ProfileButton />
        </div>
      </div>
    </header>
  );
}
