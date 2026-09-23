import Link from "next/link";

import { CHROME } from "@/lib/landing/copy";

export function LandingFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-shell flex-col gap-4 px-5 py-8 text-sm text-fg-muted sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p>
          <span className="font-medium text-fg-secondary">Momentum Terminal</span>
          <span aria-hidden> · </span>
          {CHROME.footer.paper}
        </p>
        <nav className="flex items-center gap-5">
          <Link href="/privacy" className="transition-colors hover:text-fg">
            {CHROME.footer.privacy}
          </Link>
          <Link href="/login" className="transition-colors hover:text-fg">
            {CHROME.footer.signIn}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
