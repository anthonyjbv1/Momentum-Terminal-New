"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

import { Button } from "./button";

/**
 * Modal surface: a bottom sheet on mobile, a centred dialog on desktop.
 *
 * It deliberately sits BELOW the top banner (the overlay starts at the
 * banner's bottom edge and the z-index is lower), so the countdown timer
 * stays visible and live above every modal on the platform. It sits ABOVE
 * everything else, the mobile tab bar included — see --z-tabbar in
 * tokens.css, which Phase 26 moved under the overlay.
 *
 * TWO THINGS PHASE 26 FIXED, BOTH AT THE EDGES.
 *
 * The title block is now STICKY INSIDE the scroll area rather than a
 * sibling above it, and it carries the sheet's own background. Before, the
 * scrolled content was clipped at the header's bottom edge with nothing
 * between them: the top four pixels of a scrolled line survived the clip
 * and landed under "Paper trading. Not real money.", so the sheet read as
 * if its content were showing through its own title. Content now passes
 * UNDER an opaque header and is covered by it, which is what a scrolled
 * dialog is supposed to look like.
 *
 * The bottom no longer reserves the tab bar's height. It used to pad by a
 * whole tab-bar height so the nav — which was drawn on top — would not cover
 * the last row. The nav is under the sheet now, so the padding is just the
 * device's home indicator, env(safe-area-inset-bottom), plus the body's own.
 * That hands a tab bar's worth of height back to the sheet, which on the
 * smallest supported viewport is the difference between a Review button you
 * have to go looking for and one that is simply on screen.
 *
 * THREE REGIONS (Phase 26b): a pinned TITLE, a scrolling BODY, and a pinned
 * FOOTER carrying the step's primary action.
 *
 * Phase 26 bought the sheet height; it did not change its shape, so the
 * primary action still rode at the bottom of the scrolling content and its
 * reachability was a function of how tall that content happened to be. On
 * the smallest supported viewport the Sell sheet was already over by more
 * than the height of its own action, and every row a later phase adds — a
 * Shares/Dollars toggle, a fee line, a warning — takes another bite out of
 * the one control the sheet exists to offer. A pinned footer makes the
 * action's position independent of the body's height: extra content costs
 * the BODY its scroll, never the action.
 *
 * The footer is pinned by flex rather than by `position: sticky`. The panel
 * is a column with a fixed maximum height, so a `shrink-0` last child sits
 * against the bottom edge and the middle child takes what is left — no
 * stacking context, no sticky containment to reason about, and the footer
 * cannot be scrolled past even for an instant during a reflow. It inherits
 * the panel's z-index, so "above the tab bar" is true by containment rather
 * than by a second token.
 *
 * Its top border is hairline and conditional: shown only while there is body
 * left underneath it, because a rule under content that has ended is a line
 * drawn for no reason. The border is always in the box (transparent when
 * off), so toggling it cannot shift the layout by a pixel.
 *
 * THE SOFTWARE KEYBOARD. `position: fixed` resolves against the LAYOUT
 * viewport, which iOS does not shrink when the keyboard comes up — so a
 * bottom-anchored sheet, and its footer with it, ends up behind the
 * keyboard. The overlay tracks `visualViewport` and lifts its own bottom
 * edge by the occluded height, so the footer comes to rest directly above
 * the keyboard instead of behind it. Where the API is absent the inset stays
 * 0 and nothing changes.
 */
export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /**
   * The step's primary action, pinned to the bottom of the sheet and never
   * scrolled. Anything that needs the body's context belongs in `children`.
   */
  footer?: ReactNode;
  size?: "md" | "lg";
  className?: string;
}

export function Sheet({ open, onClose, title, description, children, footer, size = "md", className }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // Whether any body remains below the footer's top edge, which is the only
  // time the footer's hairline says anything.
  const [bodyBelow, setBodyBelow] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  // The hairline. Measured on scroll and whenever the body resizes; the
  // observer's first callback supplies the initial reading, so nothing is
  // set during the effect itself.
  useEffect(() => {
    const element = bodyRef.current;
    if (!open || !element) return;
    const measure = () => setBodyBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [open, children, footer]);

  // The keyboard inset. See THE SOFTWARE KEYBOARD above.
  useEffect(() => {
    const viewport = typeof window === "undefined" ? null : window.visualViewport;
    if (!open || !viewport) return;
    // Written straight onto the element: the keyboard's height is a runtime
    // measurement from an external system, not a design value, so it has no
    // business being a class or a token.
    const apply = () => {
      const occluded = Math.round(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
      const element = overlayRef.current;
      if (element) element.style.bottom = occluded > 0 ? `${occluded}px` : "";
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div ref={overlayRef} className="fixed inset-x-0 bottom-0 top-banner z-(--z-overlay)">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-canvas/75 backdrop-blur-sm animate-fade-in"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          // overflow-hidden so the sticky header cannot square off the sheet's rounded corners
          "absolute z-(--z-sheet) flex max-h-full flex-col overflow-hidden bg-surface-overlay shadow-overlay focus-visible:outline-none",
          // mobile: bottom sheet, clearing the device's home indicator (the tab bar is below it)
          "inset-x-0 bottom-0 rounded-t-3xl pb-safe md:pb-0 animate-slide-up",
          // desktop: centred dialog
          "sm:inset-auto sm:left-1/2 sm:top-20 sm:w-full sm:-translate-x-1/2 sm:rounded-3xl sm:animate-rise-in",
          size === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg",
          className,
        )}
      >
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-start justify-between gap-4 bg-surface-overlay px-6 pb-5 pt-6 sm:px-8 sm:pt-8">
            <div className="flex flex-col gap-1.5">
              <h2 id={titleId} className="text-2xl font-semibold tracking-tight text-fg">
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="text-sm text-fg-muted">
                  {description}
                </p>
              ) : null}
            </div>
            <Button variant="outline" size="icon" onClick={onClose} aria-label="Close" className="-mr-2 -mt-2 size-10">
              <X />
            </Button>
          </div>
          <div className="px-6 pb-6 sm:px-8 sm:pb-8">{children}</div>
        </div>
        {footer ? (
          // shrink-0 against the panel's bottom edge: pinned by the column,
          // not by `position: sticky`. The panel's own pb-safe sits below it
          // in the same colour, so the padding under the action is this
          // footer's own plus the device's home indicator.
          <div className={cn("shrink-0 border-t bg-surface-overlay px-6 pb-6 pt-4 sm:px-8", bodyBelow ? "border-line" : "border-transparent")}>{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
