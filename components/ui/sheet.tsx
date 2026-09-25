"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
 *
 * iOS SAFARI, TYPING INTO THE SHEET (Phase 29b). Focusing the Shares or
 * Dollars field made the sheet jump and sometimes close. Three things
 * combined, and each is now handled here:
 *
 *   1. THE PAGE SCROLLED BEHIND IT. iOS ignores `overflow: hidden` on the
 *      body for its own scroll-into-view, so opening the keyboard scrolled
 *      the document under the sheet. The body is now pinned in place
 *      (`position: fixed` at the current scroll offset) for as long as a
 *      sheet is open, and the offset is restored on close.
 *   2. THE VISIBLE AREA PANNED AWAY FROM THE SHEET. With the keyboard up, iOS
 *      pans the visual viewport inside the layout viewport (offsetTop > 0),
 *      and fixed elements stay with the layout viewport: the sheet's title
 *      went off the top of the screen. The overlay now follows the visual
 *      viewport at BOTH edges — its top moves down with the pan, its bottom
 *      up above the keyboard — so the whole sheet is always inside what the
 *      reader can see.
 *   3. A TAP LANDED ON THE BACKDROP. The layout shift between touchstart and
 *      the synthesised click moved the backdrop under the finger, and the
 *      backdrop's click closed the sheet. The backdrop now closes only on a
 *      press that STARTED on it, never within a moment of the viewport
 *      changing size, and — while a field in the sheet is focused — the
 *      first tap outside only dismisses the keyboard.
 *
 *   4. THE ROOT OF IT: EVERY KEYSTROKE RE-OPENED THE SHEET. The open/close
 *      effect listed `onClose` among its dependencies, and the trade sheet's
 *      close handler changes identity with the quantity typed (it logs it).
 *      So each keystroke ran the effect's cleanup and setup again: focus went
 *      back to the Buy pill behind the sheet and then to the panel, and the
 *      scroll lock came off and on. On a desktop that swallowed every digit
 *      after the first; on iOS the blur dismissed the keyboard and the focus
 *      jump scrolled the page — the glitch. The latest onClose is now read
 *      through a ref, so the effect runs exactly once per open.
 *
 * Programmatic focus never scrolls (`preventScroll`), inputs in a sheet get
 * `touch-action: manipulation` from the body, and the body's own scrolling is
 * contained so it cannot chain to the page.
 *
 * THE DESKTOP DIALOG ENDS INSIDE THE WINDOW (after Phase 29c). On desktop
 * the panel sat 5rem below the top of the overlay (`top-20`) but was allowed
 * the overlay's FULL height (`max-h-full`), so once its content reached the
 * limit it hung 80 px past the bottom of the window — and the pinned footer,
 * the one part that must always be on screen, was the part cut off. The
 * arithmetic had been wrong since Phase 6a; Phase 29's taller trade sheet
 * (the market price, the spread note, the average and last-share rows) is
 * what made common laptop windows reach it: at 1280×720 and 1366×768 the
 * Confirm button sat wholly below the window, and nothing could be bought or
 * sold from the dialog. The top gap and the height limit now come from one
 * token, `--spacing-dialog-gap` (`top-dialog-gap`, `max-h-dialog`: the
 * overlay less that gap above and below), so the panel ends at least a gap
 * above the window's bottom edge at every size and the body scrolls instead.
 * Phones never used it: there the panel is a bottom sheet with `max-h-full`
 * and no top offset.
 *
 * THE WIDE DIALOG (Phase 29e). `size="wide"` is the trade sheet's: from
 * `lg` up the panel is wide enough for two columns (the order beside its
 * summary), and the title block tightens — the description on the title's
 * line, less padding above and below — because on a short laptop window
 * (1278×604) every row of chrome is a row of the order scrolled out of view.
 * Below `lg` it is the `md` dialog and the bottom sheet, unchanged.
 *
 * HYDRATION (Phase 29b). The portal needs `document`, which the server does
 * not have: a sheet open on the first render rendered nothing on the server
 * and a dialog on the client — a hydration error, the Next.js "1 Issue"
 * badge. The sheet now renders only once mounted on the client
 * (useSyncExternalStore's server snapshot says "not yet"), so the server
 * HTML and the first client render agree.
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
  /** `wide`: the `md` dialog, and from `lg` up a two-column dialog with a tighter title block. */
  size?: "md" | "lg" | "wide";
  className?: string;
}

const noSubscription = () => () => {};

/** False on the server and during hydration, true once the client has taken over. */
function useMounted(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

/** How long after the viewport changes size a backdrop click is treated as the keyboard's, not the reader's. */
export const VIEWPORT_SETTLE_MS = 500;

/**
 * Pins the page where it is while a sheet is open. `overflow: hidden` alone
 * does not stop iOS scrolling the document to reveal a focused field, so the
 * body is fixed at the current offset and put back exactly on release.
 */
function lockBodyScroll(): () => void {
  const { body, documentElement } = document;
  const scrollY = window.scrollY;
  const previous = {
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    overflow: body.style.overflow,
    overscroll: documentElement.style.overscrollBehavior,
  };
  body.style.position = "fixed";
  body.style.top = `-${scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  documentElement.style.overscrollBehavior = "none";
  return () => {
    body.style.position = previous.position;
    body.style.top = previous.top;
    body.style.left = previous.left;
    body.style.right = previous.right;
    body.style.width = previous.width;
    body.style.overflow = previous.overflow;
    documentElement.style.overscrollBehavior = previous.overscroll;
    window.scrollTo(0, scrollY);
  };
}

function isTextField(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset"].includes(element.type));
}

export function Sheet({ open, onClose, title, description, children, footer, size = "md", className }: SheetProps) {
  const mounted = useMounted();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // Whether any body remains below the footer's top edge, which is the only
  // time the footer's hairline says anything.
  const [bodyBelow, setBodyBelow] = useState(false);
  // The backdrop's dismissal guards: whether the press began on the backdrop,
  // and when the visual viewport last changed size (the keyboard moving).
  const pressStartedOnBackdrop = useRef(false);
  // The field that had the keyboard when the press began — read then, because
  // by the click the press itself may have moved focus (Chrome focuses a
  // clicked button; iOS may not), and the answer must not depend on which.
  const fieldAtPress = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const viewportChangedAt = useRef(0);
  // The latest onClose, read at the moment of closing. See point 4 above: a
  // handler that changes identity must never re-run the open/close effect.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || !mounted) return;
    const panel = panelRef.current;
    const active = document.activeElement as HTMLElement | null;
    // A field that took focus on mount (autoFocus) keeps it; otherwise the panel takes it.
    const focusInside = Boolean(active && panel?.contains(active));
    const previouslyFocused = focusInside ? null : active;
    const unlock = lockBodyScroll();
    if (!focusInside) panel?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unlock();
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [open, mounted]);

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
  }, [open, mounted, children, footer]);

  // The keyboard and the pan. See THE SOFTWARE KEYBOARD and iOS SAFARI above.
  useEffect(() => {
    const viewport = typeof window === "undefined" ? null : window.visualViewport;
    if (!open || !mounted || !viewport) return;
    const root = getComputedStyle(document.documentElement);
    const bannerPx = (Number.parseFloat(root.getPropertyValue("--spacing-banner")) || 4) * (Number.parseFloat(root.fontSize) || 16);
    let lastHeight = viewport.height;
    // Written straight onto the element: the keyboard's height and the pan
    // are runtime measurements from an external system, not design values,
    // so they have no business being classes or tokens.
    const apply = () => {
      if (Math.abs(viewport.height - lastHeight) > 1) viewportChangedAt.current = performance.now();
      lastHeight = viewport.height;
      const element = overlayRef.current;
      if (!element) return;
      const occluded = Math.round(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
      element.style.bottom = occluded > 0 ? `${occluded}px` : "";
      // The top follows the visible area once it has panned past the banner.
      const panned = Math.round(viewport.offsetTop);
      element.style.top = panned > bannerPx ? `${panned}px` : "";
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
    };
  }, [open, mounted]);

  if (!open || !mounted) return null;
  const wide = size === "wide";

  // Every press inside the overlay records where it began, so a click that
  // arrives on the backdrop from a press that began on the sheet is known.
  const onPressStart = (event: React.PointerEvent) => {
    pressStartedOnBackdrop.current = event.target === backdropRef.current;
    const active = document.activeElement;
    fieldAtPress.current = isTextField(active) && panelRef.current?.contains(active) ? active : null;
  };
  const onBackdropClick = () => {
    const startedHere = pressStartedOnBackdrop.current;
    const field = fieldAtPress.current;
    pressStartedOnBackdrop.current = false;
    fieldAtPress.current = null;
    // A click the layout shift put here: the press began somewhere else.
    if (!startedHere) return;
    // The keyboard is still moving: this is the viewport settling, not the reader.
    if (performance.now() - viewportChangedAt.current < VIEWPORT_SETTLE_MS) return;
    // A field in the sheet had the keyboard up: the first tap outside puts the keyboard away.
    if (field) {
      field.blur();
      return;
    }
    onClose();
  };

  return createPortal(
    <div ref={overlayRef} onPointerDownCapture={onPressStart} className="fixed inset-x-0 bottom-0 top-banner z-(--z-overlay)">
      <button
        ref={backdropRef}
        type="button"
        aria-label="Close"
        tabIndex={-1}
        // The press never takes focus from the field; the click decides what happens to it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onBackdropClick}
        className="absolute inset-0 cursor-default touch-none bg-canvas/75 backdrop-blur-sm animate-fade-in"
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
          // desktop: centred dialog, a gap below the banner and at most the same gap above the window's bottom edge
          "sm:inset-auto sm:left-1/2 sm:top-dialog-gap sm:max-h-dialog sm:w-full sm:-translate-x-1/2 sm:rounded-3xl sm:animate-rise-in",
          size === "lg" ? "sm:max-w-2xl" : size === "wide" ? "sm:max-w-lg lg:max-w-dialog-wide" : "sm:max-w-lg",
          className,
        )}
      >
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [&_input]:touch-manipulation">
          <div className={cn("sticky top-0 z-10 flex items-start justify-between gap-4 bg-surface-overlay px-6 pb-5 pt-6 sm:px-8 sm:pt-8", wide && "lg:items-center lg:pb-4 lg:pt-6")}>
            <div className={cn("flex flex-col gap-1.5", wide && "lg:flex-row lg:items-baseline lg:gap-3")}>
              <h2 id={titleId} className="text-2xl font-semibold tracking-tight text-fg">
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="text-sm text-fg-muted">
                  {description}
                </p>
              ) : null}
            </div>
            <Button variant="outline" size="icon" onClick={onClose} aria-label="Close" className={cn("-mr-2 -mt-2 size-10", wide && "lg:mt-0")}>
              <X />
            </Button>
          </div>
          <div className={cn("px-6 pb-6 sm:px-8 sm:pb-8", wide && "lg:pb-6")}>{children}</div>
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
