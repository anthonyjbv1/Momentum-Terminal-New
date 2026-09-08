import Link from "next/link";

import { TopBanner } from "@/components/shell/top-banner";
import { buttonClassName } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-dvh">
      <TopBanner variant="minimal" />
      <main className="mx-auto w-full max-w-md px-5 pt-banner sm:px-8">
        <div className="flex flex-col items-center py-28 text-center">
          <p className="num text-sm text-fg-faint">404</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tighter text-fg">Nothing here</h1>
          <p className="mt-3 text-base text-fg-muted">The page you asked for is off the board.</p>
          <Link href="/" className={buttonClassName("outline", "md", "mt-10")}>
            Back to Home
          </Link>
        </div>
      </main>
    </div>
  );
}
