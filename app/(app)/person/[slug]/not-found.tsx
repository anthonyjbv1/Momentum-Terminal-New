import Link from "next/link";

import { buttonClassName } from "@/components/ui/button";

/** An unknown slug: a real 404 inside the shell, with the way back. */
export default function PersonNotFound() {
  return (
    <div className="flex flex-col items-center py-24 text-center">
      <p className="num text-sm text-fg-faint">404</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tighter text-fg">No one by that name</h1>
      <p className="mt-3 max-w-sm text-base text-fg-muted">Nobody on the board answers to this address. The people being tracked are all on Home.</p>
      <Link href="/" className={buttonClassName("outline", "md", "mt-10")}>
        Back to Home
      </Link>
    </div>
  );
}
