/**
 * A PERSON'S OWN MARKET SETTINGS, IN WORDS (Phase 29d).
 *
 * The explainer's limits table is per tier, and under it the page says:
 * "Individual people can carry their own settings; where they do, their
 * profile says so." This is what makes that sentence true. market_params_for()
 * resolves five per-person columns over the tier's settings —
 * depth_units_override, decay_half_life_ticks_override,
 * premium_cap_cents_override, pricing_mode_override and shorting_override —
 * and every one that is set, and differs from what the tier says, becomes one
 * plain sentence on the profile, set against the tier's own figure so the
 * reader can see what is different and by how much.
 *
 * An override equal to the tier's value changes nothing a reader would see,
 * so it says nothing. market-overrides.test.ts holds the list of columns to
 * the migrations, so a sixth override cannot be added without a sentence.
 */

export interface PersonMarketOverrides {
  /** Units of net buying per point of premium; null: the tier's. */
  depthUnits: number | null;
  /** The premium's decay half-life in Engine ticks; null: the tier's. */
  halfLifeTicks: number | null;
  /** The most the premium may be, in cents; null: the tier's. */
  premiumCapCents: number | null;
  /** 'flat' or 'curve' for this person alone; null: the tier's. */
  pricingMode: "curve" | "flat" | null;
  /** Whether selling short is allowed for this person; null: the tier's. Always ANDed with the platform switch. */
  shorting: boolean | null;
}

/** The people columns behind each override, in the order the sentences appear. */
export const OVERRIDE_COLUMNS = {
  pricingMode: "pricing_mode_override",
  depthUnits: "depth_units_override",
  halfLifeTicks: "decay_half_life_ticks_override",
  premiumCapCents: "premium_cap_cents_override",
  shorting: "shorting_override",
} as const satisfies Record<keyof PersonMarketOverrides, string>;

/** What the tier says, for the comparison: the published tier parameters' shape, narrowed to what the sentences use. */
export interface TierMarketDefaults {
  tier: "public_figure" | "private_individual";
  pricingMode: "curve" | "flat";
  depthUnits: number;
  halfLifeSeconds: number;
  premiumCapCents: number;
  maxOrderShareOfDepth: number;
  shortingAllowed: boolean;
}

export function noOverrides(): PersonMarketOverrides {
  return { depthUnits: null, halfLifeTicks: null, premiumCapCents: null, pricingMode: null, shorting: null };
}

function toPositiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The five columns as the people row carries them. */
export function readOverrides(row: Partial<Record<(typeof OVERRIDE_COLUMNS)[keyof typeof OVERRIDE_COLUMNS], unknown>>): PersonMarketOverrides {
  const mode = row.pricing_mode_override;
  const shorting = row.shorting_override;
  return {
    depthUnits: toPositiveInt(row.depth_units_override),
    halfLifeTicks: toPositiveInt(row.decay_half_life_ticks_override),
    premiumCapCents: toPositiveInt(row.premium_cap_cents_override),
    pricingMode: mode === "flat" || mode === "curve" ? mode : null,
    shorting: typeof shorting === "boolean" ? shorting : null,
  };
}

const PEERS: Record<TierMarketDefaults["tier"], string> = {
  public_figure: "other public figures",
  private_individual: "other private individuals",
};

function sharesText(units: number): string {
  const shares = units / 1000;
  return `${shares.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${shares === 1 ? "share" : "shares"}`;
}

function durationText(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

function pointsText(cents: number): string {
  return `${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} points`;
}

/**
 * One sentence per setting this person carries that differs from their
 * tier's. Empty when there are none, which is almost everyone. `tickMs` is the
 * Engine's cadence (LIVE_TICK_MS), passed in rather than imported so this file
 * stays free of the profile model's import graph.
 */
export function overrideSentences(name: string, overrides: PersonMarketOverrides, tier: TierMarketDefaults, platformShortingEnabled: boolean, tickMs: number): string[] {
  const peers = PEERS[tier.tier];
  const lines: string[] = [];
  const mode = overrides.pricingMode ?? tier.pricingMode;

  if (overrides.pricingMode !== null && overrides.pricingMode !== tier.pricingMode) {
    lines.push(
      overrides.pricingMode === "flat"
        ? `${name}’s market is flat: trading does not move the market price, which stays at the score. The markets of ${peers} move with trading.`
        : `${name}’s market moves with trading, while the markets of ${peers} are flat for now.`,
    );
  }

  // Depth, half-life and cap only mean something on a market that moves.
  if (mode === "curve") {
    if (overrides.depthUnits !== null && overrides.depthUnits !== tier.depthUnits) {
      const own = Math.floor(tier.maxOrderShareOfDepth * overrides.depthUnits);
      const theirs = Math.floor(tier.maxOrderShareOfDepth * tier.depthUnits);
      lines.push(
        `${sharesText(overrides.depthUnits)} of net buying move ${name}’s market price one point, against ${sharesText(tier.depthUnits)} for ${peers}, so the largest single order here is ${sharesText(own)} (${sharesText(theirs)} for ${peers}).`,
      );
    }
    if (overrides.halfLifeTicks !== null) {
      const seconds = Math.round((overrides.halfLifeTicks * tickMs) / 1000);
      if (seconds !== tier.halfLifeSeconds) {
        lines.push(`With no trading, the premium on ${name} halves every ${durationText(seconds)}, against ${durationText(tier.halfLifeSeconds)} for ${peers}.`);
      }
    }
    if (overrides.premiumCapCents !== null && overrides.premiumCapCents !== tier.premiumCapCents) {
      lines.push(`${name}’s market price may sit at most ${pointsText(overrides.premiumCapCents)} from the score, against ${pointsText(tier.premiumCapCents)} for ${peers}.`);
    }
  }

  if (overrides.shorting !== null && overrides.shorting !== tier.shortingAllowed) {
    lines.push(
      overrides.shorting
        ? `Selling ${name} short is allowed by ${name}’s own setting${platformShortingEnabled ? "" : ", though selling short is switched off across the platform for now"}.`
        : `Selling ${name} short is not allowed, whatever the rule for ${peers}.`,
    );
  }
  return lines;
}
