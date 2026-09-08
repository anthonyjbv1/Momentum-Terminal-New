"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

import { Button } from "./button";

/**
 * Modal surface: a bottom sheet on mobile, a centred dialog on desktop.
 *
 * It deliberately sits BELOW the top banner (the overlay starts at the
 * banner's bottom edge and the z-index is lower), so the countdown timer
 * stays visible and live above every modal on the platform.
 */
export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: "md" | "lg";
  className?: string;
}

export function Sheet({ open, onClose, title, description, children, size = "md", className }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

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

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-x-0 bottom-0 top-banner z-(--z-overlay)">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-canvas/70 backdrop-blur-sm animate-fade-in"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "absolute z-(--z-sheet) flex max-h-full flex-col border border-line bg-surface-overlay shadow-overlay focus-visible:outline-none",
          // mobile: bottom sheet
          "inset-x-0 bottom-0 rounded-t-2xl pb-safe animate-slide-up",
          // desktop: centred dialog
          "sm:inset-auto sm:left-1/2 sm:top-16 sm:w-full sm:-translate-x-1/2 sm:rounded-2xl sm:animate-rise-in",
          size === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight text-fg">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-sm text-fg-muted">
                {description}
              </p>
            ) : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" className="-mr-2 -mt-2">
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
