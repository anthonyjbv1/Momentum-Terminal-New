"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { flushBehavioralEvents, trackEvent } from "@/lib/behavioral/client";
import { cn } from "@/lib/cn";
import { TOUR, tourProgressLabel, type TourStop } from "@/lib/onboarding/copy";
import { buttonClassName } from "@/components/ui/button";

/**
 * THE GUIDED TOUR (Phase 32b): eight stops on one real person's page, one
 * element lit at a time with a short caption. It is display only. The lit
 * element is covered by a transparent button that goes to the next stop, so
 * tapping "the real thing" continues the tour and nothing underneath acts:
 * no trade is placed, no vote cast, no tab followed until the tour is over.
 * Everything outside the light is dimmed and ignores taps.
 *
 * Each stop is anchored to a `data-tour` attribute on the page (or the shell:
 * the Portfolio and Feed tabs). Where an element is rendered twice for two
 * screen sizes (the Buy pill, the tabs), the visible one is lit. A stop
 * whose element is not on the page (a paused Forecast) is passed over.
 *
 * On a phone the caption is a panel at the bottom, with the page scrolled so
 * the lit element sits above it; when the element is itself fixed at the
 * bottom (the Buy bar, the tabs) the panel goes to the top instead. From the
 * md breakpoint the caption is a card beside the element. Progress is words
 * ("3 of 8"), "Skip tour" is on every stop, and there is no bar that fills.
 *
 * Motion: the page scrolls smoothly and the light glides between stops
 * unless the reader asked for reduced motion, in which case both jump.
 *
 * Every stop seen, and every way out, is an onboarding_step event with
 * step "tour" and the stop in tour_step; a replay from the profile says so.
 */
export interface ProductTourProps {
  /** Onboarding goes on to the follow picker when the tour ends; a replay from the profile ends where it is. */
  origin: "onboarding" | "replay";
  loggingEnabled: boolean;
  /** Where onboarding continues after the tour. */
  nextHref?: string;
  /** Start at this stop (zero-based); the screenshot harness uses it. */
  initialIndex?: number;
  /** The stops; defaults to all of them. */
  stops?: readonly TourStop[];
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Room around the lit element. */
const PAD = 8;
/** The desktop caption card's width, and its distance from the element. */
const CARD_WIDTH = 336;
const GAP = 16;
/** Below this width the caption is a panel, not a card beside the element (Tailwind's md). */
const NARROW_MAX = 767;

/** The visible rendering of an anchor: an element hidden for this screen size has no client rects. */
function findAnchor(anchor: string): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`));
  return candidates.find((element) => element.getClientRects().length > 0) ?? null;
}

/** Whether the element (or an ancestor) is fixed to the viewport: scrolling would not bring it anywhere. */
function isFixed(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).position === "fixed") return true;
  }
  return false;
}

function measure(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function isNarrow(): boolean {
  return window.innerWidth <= NARROW_MAX;
}

/** False on the server and during hydration, true once the page is the reader's. */
const noSubscription = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ProductTour({ origin, loggingEnabled, nextHref = "/start?step=follow", initialIndex = 0, stops = TOUR.stops }: ProductTourProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), stops.length - 1));
  const [box, setBox] = useState<Box | null>(null);
  const [narrow, setNarrow] = useState(false);
  const mounted = useMounted();
  const [closed, setClosed] = useState(false);
  const direction = useRef<1 | -1>(1);
  const panelRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const stop = stops[index];
  const last = index === stops.length - 1;

  const log = useCallback(
    (action: "view" | "next" | "skip" | "finish", tourStep: TourStop["key"]) => {
      if (!loggingEnabled) return;
      trackEvent({ eventType: "onboarding_step", metadata: { step: "tour", action, tour_step: tourStep, replay: origin === "replay" } });
    },
    [loggingEnabled, origin],
  );

  const leave = useCallback(
    async (action: "skip" | "finish") => {
      log(action, stop.key);
      setClosed(true);
      try {
        await flushBehavioralEvents();
      } catch {
        // Logging never holds the reader back.
      }
      if (origin === "onboarding") router.push(nextHref);
      else router.replace(pathname);
    },
    [log, stop.key, origin, router, nextHref, pathname],
  );

  const go = useCallback(
    (step: 1 | -1) => {
      direction.current = step;
      const target = index + step;
      if (target >= stops.length) {
        void leave("finish");
        return;
      }
      if (target < 0) return;
      log("next", stop.key);
      setIndex(target);
    },
    [index, stops.length, leave, log, stop.key],
  );

  // Escape is Skip tour; the buttons do the rest.
  useEffect(() => {
    if (!mounted || closed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void leave("skip");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mounted, closed, leave]);

  // The stop: find its element, bring it into view above the caption, light it, and keep the light on it.
  useEffect(() => {
    if (!mounted || closed) return;
    const element = findAnchor(stop.anchor);
    if (!element) {
      // Not on this page (a paused Forecast, say): pass over it in the direction of travel.
      const target = index + direction.current;
      if (target < 0 || target >= stops.length) void leave("finish");
      else setIndex(target);
      return;
    }
    log("view", stop.key);

    const reduced = prefersReducedMotion();

    if (!isFixed(element)) {
      const rect = element.getBoundingClientRect();
      const header = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
      const panel = isNarrow() ? (panelRef.current?.getBoundingClientRect().height ?? 0) : 0;
      const areaTop = header + GAP;
      const areaBottom = window.innerHeight - GAP - (isNarrow() && stop.panel === "bottom" ? panel : 0);
      const areaHeight = Math.max(areaBottom - areaTop, 1);
      const delta = rect.height >= areaHeight ? rect.top - areaTop : rect.top + rect.height / 2 - (areaTop + areaHeight / 2);
      window.scrollBy({ top: delta, behavior: reduced ? "auto" : "smooth" });
    }

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setBox(measure(element));
        setNarrow(isNarrow());
      });
    };
    update();
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(element);
    nextRef.current?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [mounted, closed, index, stop, stops.length, leave, log]);

  if (!mounted || closed || !box) return null;

  const lit = { top: box.top - PAD, left: box.left - PAD, width: box.width + 2 * PAD, height: box.height + 2 * PAD };
  const progress = tourProgressLabel(index);
  const tapLabel = TOUR.tapToContinue.replace("{title}", stop.title);

  // Where the desktop card sits: beside the element on its right, else its left, else beneath.
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  const cardTop = Math.min(Math.max(lit.top, GAP), Math.max(viewportHeight - 280, GAP));
  const card =
    lit.left + lit.width + GAP + CARD_WIDTH <= viewportWidth - GAP
      ? { left: lit.left + lit.width + GAP, top: cardTop }
      : lit.left - GAP - CARD_WIDTH >= GAP
        ? { left: lit.left - GAP - CARD_WIDTH, top: cardTop }
        : { left: Math.min(Math.max(lit.left, GAP), Math.max(viewportWidth - CARD_WIDTH - GAP, GAP)), top: Math.min(lit.top + lit.height + GAP, Math.max(viewportHeight - 280, GAP)) };

  const caption = (
    <>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-medium tabular-nums text-fg-muted">{progress}</p>
        <button type="button" onClick={() => void leave("skip")} className={buttonClassName("ghost", "sm", "-mr-3")}>
          {TOUR.skip}
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold tracking-tight text-fg">{stop.title}</h2>
        <p className="text-sm text-fg-secondary">{stop.body}</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        {index > 0 ? (
          <button type="button" onClick={() => go(-1)} className={buttonClassName("outline", "md")}>
            {TOUR.back}
          </button>
        ) : (
          <span />
        )}
        <button ref={nextRef} type="button" onClick={() => go(1)} className={buttonClassName("primary", "md", "min-w-28")}>
          {last ? TOUR.done : TOUR.next}
        </button>
      </div>
    </>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label={`Tour, ${progress}: ${stop.title}`}>
      {/* Everything outside the light is dimmed and ignores taps. */}
      <div aria-hidden className="fixed inset-0 z-(--z-tour)" onClick={(event) => event.preventDefault()} />
      <div
        aria-hidden
        className="pointer-events-none fixed z-(--z-tour) rounded-2xl shadow-tour ring-2 ring-fg motion-safe:transition-[top,left,width,height] motion-safe:duration-300 motion-safe:ease-out"
        style={lit}
      />
      {/* The lit element, as a button: tapping it continues the tour and the element beneath does nothing. */}
      <button type="button" aria-label={tapLabel} onClick={() => go(1)} className="fixed z-(--z-tour) rounded-2xl bg-transparent focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/60" style={lit} />

      {narrow ? (
        <div
          ref={panelRef}
          className={cn("fixed inset-x-0 z-(--z-tour) flex flex-col gap-4 border-line bg-canvas px-5 py-4", stop.panel === "top" ? "top-0 border-b pt-safe" : "bottom-0 border-t pb-safe")}
          style={stop.panel === "top" ? undefined : { paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
        >
          {caption}
        </div>
      ) : (
        <div className="fixed z-(--z-tour) flex flex-col gap-4 rounded-2xl border border-line bg-canvas p-5 shadow-card" style={{ ...card, width: CARD_WIDTH }}>
          {caption}
        </div>
      )}
    </div>
  );
}
