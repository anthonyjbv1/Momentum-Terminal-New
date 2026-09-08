import Link from "next/link";

import { TopBanner } from "@/components/shell/top-banner";
import { buttonClassName } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-dvh">
      <TopBanner variant="minimal" />
      <main className="mx-auto w-full max-w-md px-4 pt-banner sm:px-6">
        <div className="flex flex-col items-center py-24 text-center">
          <p className="num text-label text-fg-muted">404</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-fg">Nothing here</h1>
          <p className="mt-3 text-sm text-fg-muted">The page you asked for is off the board.</p>
          <Link href="/" className={buttonClassName("outline", "md", "mt-8")}>
            Back to Home
          </Link>
        </div>
      </main>
    </div>
  );
}
