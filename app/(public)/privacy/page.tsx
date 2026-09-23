import type { Metadata } from "next";
import Link from "next/link";

import { PRIVACY, PRIVACY_CONTACT_EMAIL } from "@/lib/landing/copy";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";

/**
 * /privacy (Phase 28): what the landing page and the waitlist collect, why,
 * for how long, and how to have it removed. Short on purpose. Every word is
 * in lib/landing/copy.ts.
 */

export const metadata: Metadata = {
  title: "Privacy",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <>
      <LandingHeader />
      <main className="mx-auto w-full max-w-2xl px-5 pb-20 pt-10 sm:px-8 sm:pt-16">
        <h1 className="text-4xl font-bold tracking-tighter text-fg sm:text-5xl">{PRIVACY.title}</h1>
        <p className="mt-4 text-base text-fg-muted">{PRIVACY.intro}</p>
        <div className="mt-12 flex flex-col gap-10">
          {PRIVACY.sections.map((section) => (
            <section key={section.title} className="flex flex-col gap-3">
              <h2 className="text-xl font-semibold tracking-tight text-fg">{section.title}</h2>
              {section.body.map((paragraph) => (
                <p key={paragraph} className="text-base leading-relaxed text-fg-secondary">
                  {paragraph.includes("{contact}") ? (
                    <>
                      {paragraph.split("{contact}")[0]}
                      <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className="font-medium text-fg underline-offset-4 hover:underline">
                        {PRIVACY_CONTACT_EMAIL}
                      </a>
                      {paragraph.split("{contact}")[1]}
                    </>
                  ) : (
                    paragraph
                  )}
                </p>
              ))}
            </section>
          ))}
        </div>
        <p className="mt-14 text-sm text-fg-muted">
          <Link href="/" className="font-medium text-fg underline-offset-4 hover:underline">
            Back to the landing page
          </Link>
        </p>
      </main>
      <LandingFooter />
    </>
  );
}
