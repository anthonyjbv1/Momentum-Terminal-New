"use client";

import { useId, useState, type FormEvent } from "react";
import Link from "next/link";

import { cn } from "@/lib/cn";
import { WAITLIST } from "@/lib/landing/copy";
import { isValidEmail, type WaitlistSource } from "@/lib/landing/waitlist";
import { Input } from "@/components/ui/input";

/**
 * ONE FIELD, ONE BUTTON. The page asks for an email and nothing else.
 *
 * The honeypot is a second text field named `website`, visually hidden and
 * hidden from assistive technology, with autocomplete off so a browser never
 * fills it for a person. A bot that fills every field it finds fills this
 * one, and the server drops the submission while answering as if it
 * succeeded (minus a position it would otherwise have to invent).
 *
 * Success is honest: the position shown is the row's real place in the
 * table, or nothing when the server sent none. No email is sent, and the
 * copy does not claim one will be, beyond the invite when a place opens.
 *
 * Campaign parameters and the referrer are read here, from the visitor's
 * own URL and document, and sent along; the server clips and stores them.
 */

export interface WaitlistFormProps {
  source: WaitlistSource;
  /** Where the POST goes; harnesses point it elsewhere. */
  endpoint?: string;
  className?: string;
}

type Phase = { kind: "idle" } | { kind: "busy" } | { kind: "done"; position: number | null } | { kind: "error"; message: string };

function campaignParameters(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const key of ["source", "medium", "campaign", "content", "term"] as const) {
    const value = params.get(`utm_${key}`);
    if (value) utm[key] = value;
  }
  return utm;
}

export function WaitlistForm({ source, endpoint = "/api/waitlist", className }: WaitlistFormProps) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) {
      setPhase({ kind: "error", message: WAITLIST.errors.invalid });
      return;
    }
    setPhase({ kind: "busy" });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          source,
          website,
          utm: campaignParameters(),
          referrer: typeof document === "undefined" ? null : document.referrer || null,
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; position?: number | null; code?: string } | null;
      if (response.ok && body?.ok) {
        setPhase({ kind: "done", position: typeof body.position === "number" && body.position > 0 ? body.position : null });
        return;
      }
      if (response.status === 429 || body?.code === "rate_limited") {
        setPhase({ kind: "error", message: WAITLIST.errors.rateLimited });
        return;
      }
      if (response.status === 400 || body?.code === "invalid") {
        setPhase({ kind: "error", message: WAITLIST.errors.invalid });
        return;
      }
      setPhase({ kind: "error", message: WAITLIST.errors.unavailable });
    } catch {
      setPhase({ kind: "error", message: WAITLIST.errors.unavailable });
    }
  };

  if (phase.kind === "done") {
    return (
      <div className={cn("flex flex-col gap-2", className)} role="status" aria-live="polite">
        <p className="text-xl font-semibold tracking-tight text-fg">{WAITLIST.success.title}</p>
        <p className="text-base text-fg-muted">
          {phase.position === null ? WAITLIST.success.withoutPosition : WAITLIST.success.withPosition.replace("{position}", phase.position.toLocaleString("en-US"))}
        </p>
      </div>
    );
  }

  const busy = phase.kind === "busy";
  const error = phase.kind === "error" ? phase.message : null;

  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-3", className)} noValidate>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor={`${id}-email`} className="sr-only">
          {WAITLIST.emailLabel}
        </label>
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={WAITLIST.emailPlaceholder}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (phase.kind === "error") setPhase({ kind: "idle" });
          }}
          disabled={busy}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : `${id}-consent`}
          className="flex-1"
        />
        <button
          type="submit"
          disabled={busy}
          className={cn(
            "h-12 shrink-0 rounded-xl bg-surface-inverse px-5 text-base font-semibold text-fg-inverse transition-opacity",
            "hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40",
          )}
        >
          {busy ? WAITLIST.buttonBusy : WAITLIST.button}
        </button>
      </div>

      {/* The honeypot. Off-screen, out of the tab order, out of the accessibility tree. */}
      <div className="sr-only" aria-hidden="true">
        <label htmlFor={`${id}-website`}>{WAITLIST.honeypotLabel}</label>
        <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
      </div>

      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-negative">
          {error}
        </p>
      ) : (
        <p id={`${id}-consent`} className="text-sm text-fg-muted">
          {WAITLIST.consent}{" "}
          <Link href="/privacy" className="underline decoration-line underline-offset-4 transition-colors hover:text-fg">
            {WAITLIST.privacyLink}
          </Link>
        </p>
      )}
    </form>
  );
}
