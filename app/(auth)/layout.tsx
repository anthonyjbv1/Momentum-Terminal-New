import type { ReactNode } from "react";

import { TopBanner } from "@/components/shell/top-banner";

/** Auth screens: the banner (and its timer) stays; the content is a centred card. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <TopBanner variant="minimal" />
      <main className="mx-auto w-full max-w-md px-5 pt-banner sm:px-8">
        <div className="py-12 sm:py-20">{children}</div>
      </main>
    </div>
  );
}
