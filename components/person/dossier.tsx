import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import {
  STATE_RULE,
  categoryLabel,
  convictionLabels,
  formatSigned,
  formatTrackedSince,
  stateLabels,
  type ConvictionLevel,
  type MarketState,
  type ProfilePerson,
  type StateReading,
} from "@/lib/person/profile-model";
import { Avatar } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";

/**
 * The identity block: a data dossier laid out as a labelled grid. Small grey
 * uppercase label, large white value, hairline rules between rows. The name
 * is the largest value on the page after the score.
 *
 * Every label describes the person's market state and nothing else. STATE is
 * the single value allowed a colour, and only because it reads direction:
 * green for a rising score, red for a falling one, white for stable.
 */
export interface DossierProps {
  person: ProfilePerson;
  state: StateReading;
  conviction: ConvictionLevel | null;
  className?: string;
}

const stateTones: Record<MarketState, string> = {
  heating: "text-positive",
  cooling: "text-negative",
  stable: "text-fg",
};

function stateCaption(state: StateReading): ReactNode {
  if (state.ticks === 0) return "No score history yet";
  if (!state.qualified) {
    return (
      <>
        <span className="num">{state.ticks}</span> {state.ticks === 1 ? "tick" : "ticks"} in 24h, needs <span className="num">{STATE_RULE.minTicks}</span>
      </>
    );
  }
  return (
    <>
      <span className="num">{formatSigned(state.change ?? 0)}</span> over 24h
    </>
  );
}

function convictionCaption(level: ConvictionLevel | null): ReactNode {
  switch (level) {
    case null:
      return "Awaiting the first tick";
    case "low":
      return (
        <>
          Under <span className="num">60%</span> of the allocation cap committed
        </>
      );
    case "moderate":
      return (
        <>
          <span className="num">60–85%</span> of the allocation cap committed
        </>
      );
    case "high":
      return (
        <>
          Over <span className="num">85%</span> of the allocation cap committed
        </>
      );
  }
}

export function Dossier({ person, state, conviction, className }: DossierProps) {
  return (
    <section aria-labelledby="dossier-heading" className={cn("flex flex-col gap-4", className)}>
      <SectionHeader title="Identity" />

      <Card className="p-6 sm:p-8">
        <div className="flex flex-col gap-7 sm:flex-row sm:items-start sm:gap-10">
          <Avatar name={person.displayName} src={person.avatarUrl} size="xl" className="sm:hidden" />
          <Avatar name={person.displayName} src={person.avatarUrl} size="2xl" className="hidden sm:inline-flex" />

          <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-6">
            <div className="col-span-2 flex flex-col gap-2 pb-6">
              <dt className="text-label text-fg-muted">Name</dt>
              <dd>
                <h1 id="dossier-heading" className="text-4xl font-bold tracking-tighter text-fg sm:text-5xl">
                  {person.displayName}
                </h1>
              </dd>
            </div>

            <Field label="Category" value={categoryLabel(person.category)} />
            <Field label="Tracked since" value={formatTrackedSince(person.createdAt)} />
            <Field label="State" value={stateLabels[state.state]} tone={stateTones[state.state]} caption={stateCaption(state)} />
            <Field label="Conviction" value={conviction ? convictionLabels[conviction] : "—"} tone={conviction ? "text-fg" : "text-fg-faint"} caption={convictionCaption(conviction)} />
          </dl>
        </div>
      </Card>
    </section>
  );
}

function Field({ label, value, tone = "text-fg", caption }: { label: string; value: string; tone?: string; caption?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-t border-line py-5">
      <dt className="text-label text-fg-muted">{label}</dt>
      <dd className="flex flex-col gap-1">
        <span className={cn("truncate text-xl font-semibold tracking-tight sm:text-2xl", tone)}>{value}</span>
        {caption ? <span className="text-xs text-fg-faint">{caption}</span> : null}
      </dd>
    </div>
  );
}
