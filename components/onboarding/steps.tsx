import Link from "next/link";
import type { ReactNode } from "react";

import { nextAction, skipAction } from "@/app/start/actions";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCents } from "@/lib/money";
import { ONBOARDING, previousStep, progressLabel, type OnboardingStep } from "@/lib/onboarding/copy";

/**
 * THE ONBOARDING SCREENS' FRAME AND THE TWO SCREENS THAT ASK NOTHING
 * (Phase 32). Every sentence comes from lib/onboarding/copy.ts. Each screen
 * says where it is ("2 of 4") in words, offers Skip on every screen, and
 * Back from the second on. No bar fills, nothing counts down.
 */

export function StepFrame({ step, title, children }: { step: OnboardingStep; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4 px-1">
        <p className="text-sm font-medium tabular-nums text-fg-muted">{progressLabel(step)}</p>
        <form action={skipAction}>
          <input type="hidden" name="step" value={step} />
          <button type="submit" className={buttonClassName("ghost", "sm")}>
            {ONBOARDING.skip}
          </button>
        </form>
      </div>
      <h1 className="px-1 text-4xl font-bold tracking-tighter text-fg">{title}</h1>
      {children}
    </div>
  );
}

/** Back (a link) and Next (a form), for the screens that ask nothing. */
export function StepNav({ step }: { step: OnboardingStep }) {
  const back = previousStep(step);
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      {back ? (
        <Link href={`/start?step=${back}`} className={buttonClassName("outline", "lg")}>
          {ONBOARDING.back}
        </Link>
      ) : (
        <span />
      )}
      <form action={nextAction}>
        <input type="hidden" name="step" value={step} />
        <button type="submit" className={buttonClassName("primary", "lg", "min-w-32")}>
          {ONBOARDING.next}
        </button>
      </form>
    </div>
  );
}

export function WhatStep() {
  const copy = ONBOARDING.what;
  return (
    <StepFrame step="what" title={copy.title}>
      <div className="flex flex-col gap-4">
        {[copy.score, copy.price].map((block) => (
          <Card key={block.label} className="flex flex-col gap-2 p-5 sm:p-6">
            <h2 className="text-lg font-semibold tracking-tight text-fg">{block.label}</h2>
            <p className="text-base text-fg-secondary">{block.body}</p>
          </Card>
        ))}
        <Link href="/how-the-price-works" target="_blank" rel="noopener" className="px-1 text-sm font-medium text-fg underline underline-offset-4">
          {copy.more}
        </Link>
      </div>
      <StepNav step="what" />
    </StepFrame>
  );
}

export function PaperStep({ balanceCents }: { balanceCents: number }) {
  const copy = ONBOARDING.paper;
  const [first, ...rest] = copy.balance.split("{balance}");
  return (
    <StepFrame step="paper" title={copy.title}>
      <Card className="flex flex-col gap-4 p-5 sm:p-6">
        <p className="text-lg text-fg">
          {first}
          <span className="font-semibold tabular-nums">{formatCents(balanceCents)}</span>
          {rest.join("{balance}")}
        </p>
        <ul className="flex flex-col gap-3">
          {copy.lines.map((line) => (
            <li key={line} className="text-base text-fg-secondary">
              {line}
            </li>
          ))}
        </ul>
      </Card>
      <StepNav step="paper" />
    </StepFrame>
  );
}
