"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** Something failed while loading a page inside the shell. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[app] route error:", error);
  }, [error]);

  return (
    <Card tone="ghost" className="mx-auto max-w-md">
      <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Could not load the board</h1>
        <p className="text-sm text-fg-muted">
          The Engine&rsquo;s data did not come back. This is usually momentary.
        </p>
        <Button variant="outline" onClick={reset} className="mt-2">
          Try again
        </Button>
      </div>
    </Card>
  );
}
