import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { isBetaSignupEnabled } from "@/lib/env";
import { TERMS, TERMS_CONTACT_EMAIL } from "@/lib/legal/terms";

/**
 * /terms (Phase 32): the beta Terms, a DRAFT FOR COUNSEL, shown to everyone
 * invited before they accept. Part of the invite-only door, so behind
 * BETA_SIGNUP_ENABLED like the rest of it: while the switch is off the page
 * does not exist. Not indexed while it is a draft. Every word is in
 * lib/legal/terms.ts.
 */

export const metadata: Metadata = {
  title: "Beta Terms",
  alternates: { canonical: "/terms" },
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  if (!isBetaSignupEnabled()) notFound();
  return (
    <>
      <LandingHeader />
      <main className="mx-auto w-full max-w-2xl px-5 pb-20 pt-10 sm:px-8 sm:pt-16">
        <div role="note" className="mb-10 flex flex-col gap-2 rounded-2xl border border-line bg-surface p-5">
          <p className="text-label font-semibold text-fg">{TERMS.draft.label}</p>
          <p className="text-sm text-fg-secondary">{TERMS.draft.body}</p>
        </div>
        <h1 className="text-4xl font-bold tracking-tighter text-fg sm:text-5xl">{TERMS.title}</h1>
        <p className="mt-3 text-sm tabular-nums text-fg-muted">Version {TERMS.version}</p>
        <p className="mt-4 text-base text-fg-muted">
          {TERMS.intro.split("Privacy notice")[0]}
          <Link href="/privacy" className="font-medium text-fg underline-offset-4 hover:underline">
            Privacy notice
          </Link>
          {TERMS.intro.split("Privacy notice")[1]}
        </p>
        <div className="mt-12 flex flex-col gap-10">
          {TERMS.sections.map((section) => (
            <section key={section.title} className="flex flex-col gap-3">
              <h2 className="text-xl font-semibold tracking-tight text-fg">{section.title}</h2>
              {section.body.map((paragraph) => (
                <p key={paragraph} className="text-base leading-relaxed text-fg-secondary">
                  <Prose text={paragraph} />
                </p>
              ))}
            </section>
          ))}
        </div>
      </main>
      <LandingFooter />
    </>
  );
}

/** A paragraph with its two possible links filled in: the contact address, and the price explainer by name. */
function Prose({ text }: { text: string }) {
  if (text.includes("{contact}")) {
    const [before, after] = text.split("{contact}");
    return (
      <>
        {before}
        <a href={`mailto:${TERMS_CONTACT_EMAIL}`} className="font-medium text-fg underline-offset-4 hover:underline">
          {TERMS_CONTACT_EMAIL}
        </a>
        {after}
      </>
    );
  }
  const name = "How the price works";
  if (text.includes(name)) {
    const [before, after] = text.split(name);
    return (
      <>
        {before}
        <Link href="/how-the-price-works" className="font-medium text-fg underline-offset-4 hover:underline">
          {name}
        </Link>
        {after}
      </>
    );
  }
  return <>{text}</>;
}
