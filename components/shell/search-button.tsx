"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { trackEvent } from "@/lib/behavioral/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhaseNotice } from "@/components/ui/phase-notice";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonPersonRow } from "@/components/ui/skeleton";

/**
 * Search entry point: a round grey button on mobile, a pill field on
 * desktop, ⌘K / Ctrl+K anywhere. Opens the search sheet; results are a later
 * phase, but the query is logged now so the recommendation layer has it.
 */

/** How long a query must sit still before it counts as a search. */
const QUERY_SETTLE_MS = 700;

export function SearchButton({ loggingEnabled = false }: { loggingEnabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const lastLogged = useRef("");

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

  // Log the query once it settles, so a single search is one event rather
  // than one per keystroke.
  useEffect(() => {
    const trimmed = query.trim();
    if (!loggingEnabled || !open || trimmed.length < 2 || trimmed === lastLogged.current) return;

    const timer = setTimeout(() => {
      lastLogged.current = trimmed;
      trackEvent({ eventType: "search", metadata: { query: trimmed } });
    }, QUERY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [query, open, loggingEnabled]);

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
        <Input
          autoFocus
          type="search"
          placeholder="Search people…"
          aria-label="Search people"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-5 divide-y divide-line overflow-hidden rounded-2xl bg-surface" aria-hidden>
          <SkeletonPersonRow />
          <SkeletonPersonRow />
          <SkeletonPersonRow />
        </div>
        <PhaseNotice phase="Phase 6c" className="mt-5">
          Results arrive with the person pages. Browse the ranked board on Home in the meantime.
        </PhaseNotice>
      </Sheet>
    </>
  );
}
