import type { Metadata } from "next";
import Link from "next/link";

import { readPublishedMarketParameters, type PublishedTierParameters } from "@/lib/trading/published-parameters";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";

/**
 * /how-the-price-works (Phase 29): the two numbers, in plain language, with
 * the formula and the parameters as they stand in the database right now.
 * Public and indexable, linked from every profile's market line. Reachable
 * signed out through the gate's allowlist (lib/auth-gate.ts).
 *
 * The parameters are READ, not written down: the table below is the tier
 * settings table as it stands when the page is served, so recalibrating the
 * depth changes this page with no deploy.
 *
 * The copy here is held to the landing rules by lib/landing/copy.test.ts,
 * which scans every source file under app/(public).
 */

export const metadata: Metadata = {
  title: "How the price works",
  description: "Every person on the board has two numbers: the Momentum Score, moved by the data alone, and the market price, moved by trading and drifting back toward the score.",
  alternates: { canonical: "/how-the-price-works" },
};

export const dynamic = "force-dynamic";

function hoursLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shares(units: number): string {
  return `${(units / 1000).toLocaleString("en-US")} shares`;
}

function points(cents: number): string {
  return `${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} points`;
}

export default async function HowThePriceWorksPage() {
  const params = await readPublishedMarketParameters();
  const tiers = params.tiers;

  return (
    <>
      <LandingHeader />
      <main className="mx-auto w-full max-w-2xl px-5 pb-20 pt-10 sm:px-8 sm:pt-16">
        <h1 className="text-4xl font-bold tracking-tighter text-fg sm:text-5xl">How the price works</h1>
        <p className="mt-4 text-base text-fg-muted">
          Every person on the board has two numbers. The Momentum Score is the data&rsquo;s number. The market price is the number you trade at. This page says how each one
          moves, in plain language, and publishes the arithmetic and the limits behind the second.
        </p>

        <div className="mt-12 flex flex-col gap-10">
          <Section title="The score comes from outside signals only">
            <p>
              The Momentum Score moves on three forces: Gravity, Signals and Market Mood. All three read the world outside this platform: news, uploads, streams, games,
              filings, and the tide across the whole board. Nothing anyone does here moves it. Buying, selling and holding do not touch the score, by construction, and a
              test fails the build if they ever could.
            </p>
            <p>
              Two more readings sit beside those three on every profile, Conviction and Trading Activity. They describe the market, not the person, and they add exactly
              nothing to the score.
            </p>
          </Section>

          <Section title="The market price moves with trading, and drifts back">
            <p>
              The market price is the score plus a <strong className="font-medium text-fg">premium</strong>. Every share bought pushes the premium up a little; every share
              sold pushes it down. With no trading at all, the premium halves every {tiers.public_figure ? hoursLabel(tiers.public_figure.halfLifeSeconds) : "few hours"} for a
              public figure{tiers.private_individual ? ` and every ${hoursLabel(tiers.private_individual.halfLifeSeconds)} for a private individual` : ""}, one small step at
              every 30-second tick, until the market price is the score again. A profile reads &ldquo;+4.0 above the data&rdquo; when the premium is four points, and
              &ldquo;in line with the data&rdquo; when it is gone.
            </p>
            <p>
              That drift back happens whether or not anyone is still holding. If many people bought while the premium was high and then sell after it has drifted back
              toward zero, their selling pushes the market price <strong className="font-medium text-fg">below</strong> the score for a while. A wave of exits can take the
              market price under the data. The score is unchanged by any of it, and the premium drifts back up toward zero from there at the same pace.
            </p>
          </Section>

          <Section title="The quotes, and what a round trip costs">
            <p>
              You buy at the Buy quote and sell at the Sell quote. The two sit either side of the market price by the spread, and the gap between them is the platform&rsquo;s
              spread, shown on every trade sheet. A round trip against an otherwise unchanged market costs exactly the spread and nothing more: the move your own buying
              put on the price is undone when you sell the same shares back.
            </p>
            <p>
              Each quote is the price of the <em>first</em> share. A larger order moves along the price as it fills, so it pays an average a little past the quote and its
              last share a little past that. Both figures are shown before you confirm, the average is the price you confirm, and the server refuses the order rather than
              filling it if that average has moved by more than {dollars(params.priceToleranceCents)} a share by the time it reads it.
            </p>
          </Section>

          <Section title="The arithmetic">
            <p>
              Quantities are counted in thousandths of a share, prices in whole cents, and every step is integer arithmetic. With <span className="num">S</span> the
              quote in cents (the score plus or minus half the spread, premium excluded), <span className="num">I</span> the market&rsquo;s inventory in thousandths
              (positive after net buying, negative after net selling) and <span className="num">D</span> the tier&rsquo;s depth:
            </p>
            <dl className="grid grid-cols-1 gap-3 rounded-2xl bg-surface p-5 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-8">
              <dt className="text-fg-muted">a buy of u costs</dt>
              <dd className="num text-fg">ceil( u·S / 1000 + u·(2I + u) / (20·D) ) cents</dd>
              <dt className="text-fg-muted">a sell of u brings</dt>
              <dd className="num text-fg">floor( u·S / 1000 + u·(2I − u) / (20·D) ) cents</dd>
              <dt className="text-fg-muted">the premium</dt>
              <dd className="num text-fg">trunc( I × 100 / D ) cents a share</dd>
              <dt className="text-fg-muted">the market price</dt>
              <dd className="num text-fg">score + premium / 100</dd>
              <dt className="text-fg-muted">decay, each tick</dt>
              <dd className="num text-fg">I − sign(I) · ceil( |I| / K ), K = round( half-life in ticks / ln 2 )</dd>
            </dl>
            <p>
              A buy rounds up to the cent and a sell rounds down, so a fraction of a cent is never settled in the buyer&rsquo;s or the seller&rsquo;s favour. A depth of{" "}
              {tiers.public_figure ? shares(tiers.public_figure.depthUnits ?? 0) : "300 shares"} means that many shares of net buying move the market price one point.
            </p>
          </Section>

          <Section title="The platform is the other side of every trade">
            <p>
              There is no order book of other traders. When you buy, the platform sells to you; when you sell, the platform buys from you. The platform keeps the spread and
              holds the other side of every price move, and it records its own side of every close and every decay step in a house book, to the cent, so the platform&rsquo;s
              position is always a number on the record and never an estimate.
            </p>
          </Section>

          <Section title="The limits">
            <p>
              Every person is either a public figure or a private individual, and each tier has its own limits. These are the settings as they stand right now; a change to
              them changes this page without a deploy.
            </p>
            <div className="overflow-x-auto rounded-2xl bg-surface">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-fg-muted">
                    <th className="px-4 py-3 font-medium">Setting</th>
                    <th className="px-4 py-3 font-medium">Public figure</th>
                    <th className="px-4 py-3 font-medium">Private individual</th>
                  </tr>
                </thead>
                <tbody className="[&_td]:border-t [&_td]:border-line [&_td]:px-4 [&_td]:py-2.5 [&_td]:align-top">
                  <Row label="Depth (shares of net buying per point)" pub={tiers.public_figure} priv={tiers.private_individual} render={(t) => (t.depthUnits === null ? "flat market" : shares(t.depthUnits))} />
                  <Row label="Premium half-life with no trading" pub={tiers.public_figure} priv={tiers.private_individual} render={(t) => hoursLabel(t.halfLifeSeconds)} />
                  <Row label="Most the market price may sit from the score" pub={tiers.public_figure} priv={tiers.private_individual} render={(t) => points(t.premiumCapCents)} />
                  <Row label="Largest single order" pub={tiers.public_figure} priv={tiers.private_individual} render={(t) => (t.depthUnits === null ? "no limit" : shares(Math.floor(t.maxOrderShareOfDepth * t.depthUnits)))} />
                  <Row label="Minimum hold before a position can be closed" pub={tiers.public_figure} priv={tiers.private_individual} render={(t) => hoursLabel(Math.max(t.minHoldSeconds, params.closeCooldownSeconds))} />
                  <Row label="Most the platform will hold on one person, net" pub={tiers.public_figure} priv={tiers.private_individual} render={(t) => shares(t.aggregateExposureCapUnits)} />
                  <Row
                    label="Circuit breaker on the premium"
                    pub={tiers.public_figure}
                    priv={tiers.private_individual}
                    render={(t) => `${points(t.breakerPremiumCents)} in ${hoursLabel(t.breakerWindowSeconds)} halts trading for ${hoursLabel(t.breakerHaltSeconds)}`}
                  />
                  <Row
                    label="Circuit breaker on the whole price"
                    pub={tiers.public_figure}
                    priv={tiers.private_individual}
                    render={(t) => (t.breakerPriceCents === null ? "none" : `${points(t.breakerPriceCents)} in ${hoursLabel(t.breakerWindowSeconds)} halts trading for ${hoursLabel(t.breakerHaltSeconds)}`)}
                  />
                  <Row label="Selling short" pub={tiers.public_figure} priv={tiers.private_individual} render={(t) => (t.shortingAllowed && params.shortingEnabled ? "allowed" : "not allowed")} />
                </tbody>
              </table>
            </div>
            <p>
              The smallest order is {dollars(params.minOrderCents)}, either way of entering it. A person can also be <strong className="font-medium text-fg">halted</strong>{" "}
              (a breaker tripped or an operator stepped in; every order is refused until a stated time), <strong className="font-medium text-fg">paused</strong> (nothing can
              be placed), or <strong className="font-medium text-fg">display-only</strong> (the score is shown, nothing new can be opened, and anything already held can still be
              closed). Each state is written on the profile and on the trade sheet when it applies.
            </p>
          </Section>

          <Section title="Everything is on the record">
            <p>
              Every change of the premium, whether a trade, a decay step or a reset, is recorded with the score at that instant. With the score history and the orders,
              every market price ever quoted can be reproduced from the record, and a test does exactly that.
            </p>
            <p>
              All of this is paper trading with paper credits. No real money changes hands anywhere on the platform.
            </p>
          </Section>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>
      <div className="flex flex-col gap-3 text-base leading-relaxed text-fg-secondary">{children}</div>
    </section>
  );
}

function Row({ label, pub, priv, render }: { label: string; pub: PublishedTierParameters | null; priv: PublishedTierParameters | null; render: (tier: PublishedTierParameters) => string }) {
  return (
    <tr>
      <td className="text-fg-secondary">{label}</td>
      <td className="num text-fg">{pub ? render(pub) : "—"}</td>
      <td className="num text-fg">{priv ? render(priv) : "—"}</td>
    </tr>
  );
}
