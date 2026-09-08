import type { Metadata } from "next";
import type { ReactNode } from "react";

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
  { name: "canvas", role: "page ground", className: "bg-canvas" },
  { name: "surface", role: "cards, panels", className: "bg-surface" },
  { name: "surface-raised", role: "hover, inputs, chips", className: "bg-surface-raised" },
  { name: "surface-overlay", role: "sheets, menus", className: "bg-surface-overlay" },
  { name: "line", role: "hairlines", className: "bg-line" },
  { name: "line-strong", role: "emphasised borders", className: "bg-line-strong" },
  { name: "fg", role: "primary text", className: "bg-fg" },
  { name: "fg-secondary", role: "secondary text", className: "bg-fg-secondary" },
  { name: "fg-muted", role: "captions", className: "bg-fg-muted" },
  { name: "fg-faint", role: "placeholders", className: "bg-fg-faint" },
  { name: "positive", role: "HIGH · Buy · heating", className: "bg-positive" },
  { name: "negative", role: "LOW · Sell · cooling", className: "bg-negative" },
  { name: "neutral", role: "flat · standby", className: "bg-neutral" },
  { name: "accent", role: "focus · links · emphasis", className: "bg-accent" },
];

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <SectionHeader title={title} />
        {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export default function DesignPage() {
  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        eyebrow="Reference"
        title="Design system"
        description="Tokens and primitives, with sample values. Edit app/styles/tokens.css and watch this page change."
        actions={<Badge tone="accent">Sample values</Badge>}
      />

      <Section title="Colour" description="Semantic tokens only. Components never name a hue.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {SWATCHES.map((swatch) => (
            <div key={swatch.name} className="flex flex-col gap-2">
              <div className={`h-14 rounded-lg border border-line ${swatch.className}`} />
              <div className="flex flex-col">
                <span className="num text-xs text-fg-secondary">{swatch.name}</span>
                <span className="text-2xs text-fg-muted">{swatch.role}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typography" description="Geist Sans for interface text; JetBrains Mono for every number and label.">
        <Card>
          <CardContent className="flex flex-col gap-5">
            <p className="text-4xl font-semibold tracking-tight text-fg">Momentum moves every thirty seconds.</p>
            <p className="text-2xl font-semibold tracking-tight text-fg">Section title, 2xl semibold</p>
            <p className="text-base text-fg-secondary">
              Body text, base. Users take HIGH or LOW positions on people whose Momentum Score is driven by real-world data. The platform is
              the sole counterparty.
            </p>
            <p className="text-sm text-fg-muted">Caption, sm muted. Scores update on every Engine tick.</p>
            <div className="flex flex-wrap items-center gap-6">
              <span className="text-label text-fg-muted">Micro label · text-label</span>
              <span className="num text-lg text-fg">
                1,234.56 <span className="text-fg-muted">num</span>
              </span>
              <span className="num text-lg text-positive">+12.40</span>
              <span className="num text-lg text-negative">−3.15</span>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Momentum Score" description="The signature number, in its four sizes, with the direction read beside it.">
        <Card>
          <CardContent className="flex flex-wrap items-end gap-x-12 gap-y-8">
            <div className="flex flex-col gap-2">
              <span className="text-label text-fg-muted">xl</span>
              <ScoreDisplay score={72.4} change={1.8} size="xl" withLabel />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-label text-fg-muted">lg</span>
              <ScoreDisplay score={48.1} change={-2.3} size="lg" withLabel />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-label text-fg-muted">md</span>
              <ScoreDisplay score={55.0} change={0} size="md" />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-label text-fg-muted">sm</span>
              <ScoreDisplay score={91.7} change={4.2} size="sm" />
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Direction" description="Heating, cooling, flat. Colour and arrow together, never colour alone.">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-8">
            <DirectionIndicator change={2.4} withLabel />
            <DirectionIndicator change={-1.1} withLabel />
            <DirectionIndicator change={0.02} withLabel />
            <DirectionIndicator change={null} withLabel />
            <DirectionIndicator change={3.5} size="lg" />
            <DirectionIndicator change={-0.6} size="sm" iconOnly />
          </CardContent>
        </Card>
      </Section>

      <Section title="Buttons" description="Buy is green, Sell is red, everything else stays quiet.">
        <Card>
          <CardContent className="flex flex-col gap-5">
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
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Badges" description="Categories, sources and states in the mono micro-label voice.">
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
            <Badge tone="negative">Tier 1</Badge>
          </CardContent>
        </Card>
      </Section>

      <Section title="Avatars" description="Initials on a raised surface when there is no photo.">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4">
            <Avatar name="Kendrick Lamar" size="2xl" />
            <Avatar name="Taylor Swift" size="xl" />
            <Avatar name="Drake" size="lg" ring="positive" />
            <Avatar name="MrBeast" size="md" ring="accent" />
            <Avatar name="Serena Williams" size="sm" />
            <Avatar name="Elon Musk" size="xs" />
          </CardContent>
        </Card>
      </Section>

      <Section title="Cards" description="One border, one soft shadow, generous radius. Interactive cards lift on hover.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex-col items-start gap-1">
              <CardTitle>Default</CardTitle>
              <CardDescription>Panels and tiles.</CardDescription>
            </CardHeader>
            <CardContent className="pt-2">
              <ScoreDisplay score={64.2} change={0.9} size="md" />
            </CardContent>
          </Card>
          <Card interactive>
            <CardHeader className="flex-col items-start gap-1">
              <CardTitle>Interactive</CardTitle>
              <CardDescription>Hover to lift. Person cards use this.</CardDescription>
            </CardHeader>
            <CardContent className="pt-2">
              <ScoreDisplay score={37.8} change={-1.4} size="md" />
            </CardContent>
          </Card>
          <Card tone="raised">
            <CardHeader className="flex-col items-start gap-1">
              <CardTitle>Raised</CardTitle>
              <CardDescription>Nested inside another card.</CardDescription>
            </CardHeader>
            <CardContent className="pt-2">
              <ScoreDisplay score={50.0} change={0} size="md" />
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Inputs" description="One height, one radius, accent focus.">
        <Card>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <Field label="Search" htmlFor="design-search" hint="Hint text sits here.">
              <Input id="design-search" placeholder="Search people…" />
            </Field>
            <Field label="Amount" htmlFor="design-amount" error="Enter a whole number of dollars.">
              <Input id="design-amount" className="num" defaultValue="250" aria-invalid />
            </Field>
          </CardContent>
        </Card>
      </Section>

      <Section title="Countdown" description="The same clock as the banner, larger.">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-10">
            <CountdownTimer size="lg" />
            <CountdownTimer size="banner" />
            <SheetDemo />
          </CardContent>
        </Card>
      </Section>

      <Section title="Loading" description="Skeletons mirror the shape of what is coming, with a slow shimmer.">
        <div className="grid gap-3 sm:grid-cols-3">
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
