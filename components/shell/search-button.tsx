"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { trackEvent } from "@/lib/behavioral/client";
import {
  MIN_QUERY_LENGTH,
  QUERY_DEBOUNCE_MS,
  QUERY_SETTLE_MS,
  SEARCH_COPY,
  SEARCH_LIMIT,
  type SearchResult,
} from "@/lib/search/search-model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonPersonRow } from "@/components/ui/skeleton";

import { SearchMessage, SearchResultRow } from "./search-results";

/**
 * Search: a round grey button on mobile, a pill field on desktop, ⌘K / Ctrl+K
 * anywhere.
 *
 * Keyboard-first on desktop — the field takes focus on open, the arrow keys
 * move a highlight through the results without the focus ever leaving the
 * field, and Enter opens the highlighted person. Escape closes (the sheet's
 * own handler). Thumb-first on mobile — the same rows, each a full-width
 * target at least sixteen units tall, in a bottom sheet that sits under the
 * live banner.
 *
 * Two clocks, deliberately different. The query is SENT after a short pause
 * so the list keeps up with typing; it is LOGGED only once it has sat still
 * for longer AND its results are back, so the behavioural event carries the
 * number of results the person actually saw rather than a guess made before
 * the answer arrived.
 */

interface SearchState {
  status: "idle" | "loading" | "ready" | "failed";
  /** The query these results belong to; "" while idle. */
  query: string;
  results: SearchResult[];
}

const IDLE: SearchState = { status: "idle", query: "", results: [] };

export function SearchButton({ loggingEnabled = false }: { loggingEnabled?: boolean }) {
  const router = useRouter();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>(IDLE);
  const [active, setActive] = useState(0);
  const logged = useRef<string>("");

  const close = useCallback(() => setOpen(false), []);
  const trimmed = query.trim();

  // Every open starts clean, so the next ⌘K is a new search rather than the
  // last one. Done here rather than in an effect on `open`: the reset belongs
  // to the gesture, not to a render.
  const openSheet = useCallback(() => {
    setQuery("");
    setState(IDLE);
    setActive(0);
    logged.current = "";
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) close();
        else openSheet();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close, openSheet]);

  // Fetch, debounced. The abort controller means a slow answer to an old
  // query can never overwrite a fast answer to the current one. An emptied
  // field needs no reset: every branch below is guarded on the results
  // belonging to the query on screen, so stale results are already invisible.
  useEffect(() => {
    if (!open || trimmed.length < MIN_QUERY_LENGTH) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState((current) => (current.query === trimmed ? current : { ...current, status: "loading" }));
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=${SEARCH_LIMIT}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { results?: SearchResult[] };
        setState({ status: "ready", query: trimmed, results: body.results ?? [] });
        setActive(0);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("[search] failed:", error instanceof Error ? error.message : error);
        setState({ status: "failed", query: trimmed, results: [] });
      }
    }, QUERY_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, open]);

  // Log once the query has settled and its results are in hand.
  useEffect(() => {
    if (!loggingEnabled || !open) return;
    if (state.status !== "ready" || state.query !== trimmed) return;
    if (trimmed.length < 2 || trimmed === logged.current) return;

    const timer = setTimeout(() => {
      logged.current = trimmed;
      trackEvent({ eventType: "search", metadata: { query: trimmed, result_count: state.results.length } });
    }, QUERY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state, trimmed, open, loggingEnabled]);

  const results = state.query === trimmed ? state.results : [];
  const showResults = state.status === "ready" && state.query === trimmed && results.length > 0;

  const openPerson = useCallback(
    (person: SearchResult) => {
      // The search that produced the opened row, and which row it was: the
      // recommendation layer wants the pair, not either half.
      if (loggingEnabled) {
        trackEvent({ eventType: "view_person", personId: person.id, metadata: { source: "search" } });
      }
      close();
      router.push(`/person/${person.slug}`);
    },
    [close, loggingEnabled, router],
  );

  const onFieldKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showResults) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const person = results[active];
      if (person) openPerson(person);
    }
  };

  return (
    <>
      <Button variant="outline" size="icon" className="size-10 md:hidden" aria-label="Search" onClick={openSheet}>
        <Search />
      </Button>
      <button
        type="button"
        onClick={openSheet}
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
          role="combobox"
          aria-expanded={showResults}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showResults ? `${listId}-${active}` : undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onFieldKeyDown}
        />

        {showResults ? (
          <ul id={listId} role="listbox" aria-label="Search results" className="mt-5 divide-y divide-line overflow-hidden rounded-2xl bg-surface">
            {results.map((person, index) => (
              <li key={person.id}>
                <SearchResultRow
                  person={person}
                  id={`${listId}-${index}`}
                  active={index === active}
                  onActivate={() => openPerson(person)}
                  onHover={() => setActive(index)}
                />
              </li>
            ))}
          </ul>
        ) : trimmed.length < MIN_QUERY_LENGTH ? (
          <SearchMessage title={SEARCH_COPY.empty.title} body={SEARCH_COPY.empty.body} />
        ) : state.status === "failed" && state.query === trimmed ? (
          <SearchMessage title={SEARCH_COPY.failed.title} body={SEARCH_COPY.failed.body} />
        ) : state.status === "ready" && state.query === trimmed ? (
          <SearchMessage title={SEARCH_COPY.noResults.title} body={SEARCH_COPY.noResults.body} />
        ) : (
          <div className="mt-5 divide-y divide-line overflow-hidden rounded-2xl bg-surface" aria-hidden>
            <SkeletonPersonRow />
            <SkeletonPersonRow />
            <SkeletonPersonRow />
          </div>
        )}
      </Sheet>
    </>
  );
}
