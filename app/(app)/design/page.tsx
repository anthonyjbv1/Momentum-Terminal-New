import type { Metadata } from "next";
import type { ReactNode } from "react";

import { MomentumMark } from "@/components/brand/momentum-mark";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CountdownTimer } from "@/components/ui/countdown-timer";
import { DirectionIndicator } from "@/components/ui/direction-indicator";
import { Field, Input } from "@/components/ui/input";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { ScoreDisplay } from "@/components/ui/score-display";
import { Skeleton, SkeletonFeedItem, SkeletonPersonRow, SkeletonStat } from "@/components/ui/skeleton";

import { SheetDemo } from "./sheet-demo";

export const metadata: Metadata = { title: "Design system" };

/**
 * Living reference for the token system and component library. Every value
 * shown is a SAMPLE; nothing here reads live data. Change a token in
 * app/styles/tokens.css and this page shows the result everywhere at once.
 */

const SWATCHES: Array<{ name: string; role: string; className: string }> = [
  { name: "canvas", role: "jet-black ground", className: "bg-canvas ring-1 ring-inset ring-line" },
  { name: "surface", role: "cards, panels", className: "bg-surface" },
  { name: "surface-raised", role: "hover, inputs, chips", className: "bg-surface-raised" },
  { name: "surface-overlay", role: "sheets, menus", className: "bg-surface-overlay" },
  { name: "line", role: "hairlines", className: "bg-line" },
  { name: "line-strong", role: "focus edges", className: "bg-line-strong" },
  { name: "fg", role: "primary text", className: "bg-fg" },
  { name: "fg-secondary", role: "secondary text", className: "bg-fg-secondary" },
  { name: "fg-muted", role: "captions", className: "bg-fg-muted" },
  { name: "fg-faint", role: "placeholders", className: "bg-fg-faint" },
  { name: "positive", role: "Buy · heating", className: "bg-positive" },
  { name: "negative", role: "Sell · cooling", className: "bg-negative" },
  { name: "neutral", role: "flat · standby (grey)", className: "bg-neutral" },
  { name: "accent", role: "focus · emphasis (white)", className: "bg-accent" },
];

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <SectionHeader title={title} />
        {description ? <p className="px-1 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export default function DesignPage() {
  return (
    <div className="flex flex-col gap-14">
      <PageHeader
        title="Design system"
        description="Tokens and primitives, with sample values. Edit app/styles/tokens.css and watch this page change."
        actions={<Badge tone="outline">Sample values</Badge>}
      />

      <Section title="Mark" description="The orbital mark in the current text colour, so it follows any recolour. Black blends into the ground.">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-10">
            <MomentumMark className="size-24" />
            <MomentumMark className="size-12" />
            <MomentumMark className="size-8" />
            <MomentumMark className="size-5 text-fg-muted" />
            <span className="flex items-baseline gap-1.5 text-base font-semibold tracking-tight text-fg">
              Momentum <span className="font-normal text-fg-muted">Terminal</span>
            </span>
          </CardContent>
        </Card>
      </Section>

      <Section title="Colour" description="Monochrome, zero chroma. Green and red exist for Buy / heating and Sell / cooling and appear nowhere else.">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
          {SWATCHES.map((swatch) => (
            <div key={swatch.name} className="flex flex-col gap-2.5">
              <div className={`h-16 rounded-xl ${swatch.className}`} />
              <div className="flex flex-col px-0.5">
                <span className="text-sm font-medium text-fg-secondary">{swatch.name}</span>
                <span className="text-xs text-fg-muted">{swatch.role}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typography" description="Inter carries the interface. JetBrains Mono appears only through the num utility, on numbers.">
        <Card>
          <CardContent className="flex flex-col gap-6 p-8">
            <p className="text-5xl font-bold tracking-tighter text-fg">Momentum moves every thirty seconds.</p>
            <p className="text-2xl font-semibold tracking-tight text-fg">Section title, 2xl semibold</p>
            <p className="max-w-prose text-base text-fg-secondary">
              Body text, base. Users take HIGH or LOW positions on people whose Momentum Score is driven by real-world data. The platform is
              the sole counterparty.
            </p>
            <p className="text-sm text-fg-muted">Caption, sm muted. Scores update on every Engine tick.</p>
            <div className="flex flex-wrap items-center gap-8">
              <span className="text-label text-fg-muted">Section label</span>
              <span className="num text-lg text-fg">
                1,234.56 <span className="text-sm text-fg-muted">num</span>
              </span>
              <span className="num text-lg text-positive">+12.40</span>
              <span className="num text-lg text-negative">−3.15</span>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Momentum Score" description="The signature number, in its four sizes, with the direction read beside it. The only place colour moves.">
        <Card>
          <CardContent className="flex flex-wrap items-end gap-x-14 gap-y-10 p-8">
            <div className="flex flex-col gap-3">
              <span className="text-sm text-fg-muted">xl</span>
              <ScoreDisplay score={72.4} change={1.8} size="xl" withLabel />
            </div>
            <div className="flex flex-col gap-3">
              <span className="text-sm text-fg-muted">lg</span>
              <ScoreDisplay score={48.1} change={-2.3} size="lg" withLabel />
            </div>
            <div className="flex flex-col gap-3">
              <span className="text-sm text-fg-muted">md</span>
              <ScoreDisplay score={55.0} change={0} size="md" />
            </div>
            <div className="flex flex-col gap-3">
              <span className="text-sm text-fg-muted">sm</span>
              <ScoreDisplay score={91.7} change={4.2} size="sm" />
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Direction" description="Heating, cooling, flat. Arrow and colour together; flat is grey.">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-10">
            <DirectionIndicator change={2.4} withLabel />
            <DirectionIndicator change={-1.1} withLabel />
            <DirectionIndicator change={0.02} withLabel />
            <DirectionIndicator change={null} withLabel />
            <DirectionIndicator change={3.5} size="lg" />
            <DirectionIndicator change={-0.6} size="sm" iconOnly />
          </CardContent>
        </Card>
      </Section>

      <Section title="Buttons" description="Pills. Buy is green, Sell is red; everything else is white, grey or bare.">
        <Card>
          <CardContent className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-3">
              <Button>Primary</Button>
              <Button variant="buy">Buy · HIGH</Button>
              <Button variant="sell">Sell · LOW</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="buy">
                Small
              </Button>
              <Button size="lg" variant="sell">
                Large
              </Button>
              <Button loading>Working</Button>
              <Button disabled variant="outline">
                Disabled
              </Button>
              <Button size="icon" variant="outline" aria-label="Icon button">
                <MomentumMark className="size-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Badges" description="Categories, sources and states. Grey unless the meaning is direction or live status.">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Badge>Musician</Badge>
            <Badge tone="outline">Creator</Badge>
            <Badge tone="accent">YouTube</Badge>
            <Badge tone="positive" dot>
              Live
            </Badge>
            <Badge tone="warning" dot>
              Standby
            </Badge>
            <Badge tone="negative">Cooling</Badge>
          </CardContent>
        </Card>
      </Section>

      <Section title="Avatars" description="Initials on a raised surface when there is no photo.">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-5">
            <Avatar name="Kendrick Lamar" size="2xl" />
            <Avatar name="Taylor Swift" size="xl" />
            <Avatar name="Drake" size="lg" ring="positive" />
            <Avatar name="MrBeast" size="md" ring="accent" />
            <Avatar name="Serena Williams" size="sm" />
            <Avatar name="Elon Musk" size="xs" />
          </CardContent>
        </Card>
      </Section>

      <Section title="Cards" description="Grey on black, no border, generous radius and padding. Interactive cards lift on hover.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex-col items-start gap-1">
              <CardTitle>Default</CardTitle>
              <CardDescription>Panels and tiles.</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
              <ScoreDisplay score={64.2} change={0.9} size="md" />
            </CardContent>
          </Card>
          <Card interactive>
            <CardHeader className="flex-col items-start gap-1">
              <CardTitle>Interactive</CardTitle>
              <CardDescription>Hover to lift. Person cards use this.</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
              <ScoreDisplay score={37.8} change={-1.4} size="md" />
            </CardContent>
          </Card>
          <Card tone="raised">
            <CardHeader className="flex-col items-start gap-1">
              <CardTitle>Raised</CardTitle>
              <CardDescription>Nested inside another card.</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
              <ScoreDisplay score={50.0} change={0} size="md" />
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Inputs" description="Soft grey fields, no border until focus.">
        <Card>
          <CardContent className="grid gap-6 sm:grid-cols-2">
            <Field label="Search" htmlFor="design-search" hint="Hint text sits here.">
              <Input id="design-search" placeholder="Search people…" />
            </Field>
            <Field label="Amount" htmlFor="design-amount" error="Enter a whole number of dollars.">
              <Input id="design-amount" className="num" defaultValue="250" aria-invalid />
            </Field>
          </CardContent>
        </Card>
      </Section>

      <Section title="Countdown" description="The same clock as the banner. Quiet digits over a hairline that fills; white in the final seconds, never coloured.">
        <Card>
          <CardContent className="flex flex-wrap items-end gap-12 p-8">
            <CountdownTimer size="lg" showLabel />
            <CountdownTimer size="banner" />
            <SheetDemo />
          </CardContent>
        </Card>
      </Section>

      <Section title="Loading" description="Skeletons mirror the shape of what is coming, with a slow shimmer.">
        <div className="grid gap-4 sm:grid-cols-3">
          <SkeletonStat />
          <Card className="overflow-hidden">
            <SkeletonPersonRow />
          </Card>
          <Card className="overflow-hidden">
            <SkeletonFeedItem />
          </Card>
        </div>
        <Skeleton className="h-3 w-1/2" />
      </Section>
    </div>
  );
}
