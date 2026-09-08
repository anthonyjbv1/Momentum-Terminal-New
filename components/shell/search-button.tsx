"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhaseNotice } from "@/components/ui/phase-notice";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonPersonRow } from "@/components/ui/skeleton";

/**
 * Search entry point: a round grey button on mobile, a pill field on
 * desktop, ⌘K / Ctrl+K anywhere. Opens the search sheet (results arrive in 6b).
 */
export function SearchButton() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Button variant="outline" size="icon" className="size-10 md:hidden" aria-label="Search" onClick={() => setOpen(true)}>
        <Search />
      </Button>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-10 w-56 items-center gap-2.5 rounded-full bg-surface px-4 text-sm text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 md:flex"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 text-left">Search people</span>
        <kbd className="text-xs text-fg-faint">⌘K</kbd>
      </button>

      <Sheet open={open} onClose={close} title="Search" description="Find a person by name or handle.">
        <Input autoFocus type="search" placeholder="Search people…" aria-label="Search people" />
        <div className="mt-5 divide-y divide-line overflow-hidden rounded-2xl bg-surface" aria-hidden>
          <SkeletonPersonRow />
          <SkeletonPersonRow />
          <SkeletonPersonRow />
        </div>
        <PhaseNotice phase="Phase 6b" className="mt-5">
          Live results connect when the board goes live.
        </PhaseNotice>
      </Sheet>
    </>
  );
}
