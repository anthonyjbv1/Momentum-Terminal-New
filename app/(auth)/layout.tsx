import type { ReactNode } from "react";

import { TopBanner } from "@/components/shell/top-banner";

/** Auth screens: the banner (and its timer) stays; the content is a centred card. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <TopBanner variant="minimal" />
      <main className="mx-auto w-full max-w-md px-4 pt-banner sm:px-6">
        <div className="py-10 sm:py-16">{children}</div>
      </main>
    </div>
  );
}
