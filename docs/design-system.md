# Momentum Terminal design system

Dark terminal, premium finish. One token file drives everything; components never name a colour, size or font directly.

## How to change the look

Every visual value lives in **`app/styles/tokens.css`**, inside one `@theme` block. Tailwind 4 turns each variable into a utility class (`bg-surface`, `text-fg-muted`, `rounded-lg`, `shadow-card`, `h-banner`) and a CSS variable (`var(--color-positive)`). Components only ever use those classes, so an edit there cascades through the whole platform on the next render.

| To change…                       | Edit                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| The green used for HIGH / Buy / heating | `--color-positive` (and `--color-positive-fg` for text on it). Buttons, badges, timer ring, mark, glows all follow. |
| The ground / card colours        | `--color-canvas`, `--color-surface`, `--color-surface-raised`, `--color-surface-overlay`      |
| Text colours                     | `--color-fg`, `--color-fg-secondary`, `--color-fg-muted`, `--color-fg-faint`                  |
| The interface typeface           | swap the import in `lib/fonts.ts`, keep the `--font-geist-sans` variable (or point `--font-sans` at a new one) |
| The numeric / label typeface     | same, for `--font-jetbrains-mono` → `--font-mono`                                             |
| Type scale                       | `--text-*` and the paired `--text-*--line-height`                                             |
| Corner radius                    | `--radius-*`                                                                                  |
| Shadows and glows                | `--shadow-*` (glows derive from the semantic colours through `color-mix`, so they recolour too) |
| Banner / tab bar / rail sizes    | `--spacing-banner`, `--spacing-tabbar`, `--spacing-rail`, `--spacing-shell`, `--spacing-touch` |
| Motion                           | `--animate-*`, `--default-transition-duration`, `--ease-out-expo`                              |

The stock Tailwind palette, fonts, radii and shadows are reset (`--color-*: initial;` etc.), so a class like `bg-red-500` or `text-gray-400` does not compile to anything. If a component needs a new value, add a token, do not inline it.

Two deliberate mirrors exist outside the token file and are commented as such: `viewport.themeColor` in `app/layout.tsx` (browser chrome cannot read CSS) and `app/icon.svg` (favicons cannot either). Update them when recolouring the ground or the green.

A unit test, `lib/__tests__/design-tokens.test.ts`, fails the suite if any file under `app/` or `components/` contains a hex colour, a colour function, a pixel literal or a Tailwind arbitrary value (`w-[…]`). That is the enforcement.

## Palette

Inherited from the previous platform and kept: a near-black ground with a faint cool bias, the signature green, red for the other direction, electric blue and amber as accents.

| Token                | Value                       | Role                                         |
| -------------------- | --------------------------- | -------------------------------------------- |
| `canvas`             | `oklch(10% 0.008 240)`      | page background                              |
| `surface`            | `oklch(13.5% 0.01 240)`     | cards, panels                                |
| `surface-raised`     | `oklch(17% 0.012 240)`      | hover, inputs, chips                         |
| `surface-overlay`    | `oklch(20% 0.014 240)`      | sheets, menus                                |
| `line` / `line-strong` | `oklch(22% …)` / `oklch(30% …)` | hairlines / emphasised borders          |
| `fg` … `fg-faint`    | 93% → 40% lightness         | four text levels                             |
| `positive`           | `oklch(72% 0.18 145)`       | HIGH, Buy, heating, the brand mark           |
| `negative`           | `oklch(65% 0.21 25)`        | LOW, Sell, cooling                           |
| `neutral`            | `oklch(78% 0.16 65)`        | flat, standby                                |
| `accent`             | `oklch(65% 0.22 250)`       | focus rings, links, interface emphasis       |

Direction colour is the platform's one loud voice. `accent` is for the interface, never for direction. Numbers themselves stay `fg`; only the change beside them carries colour.

## Typography

- **Geist Sans** for interface text (`font-sans`).
- **JetBrains Mono** for every number, label and the timer (`font-mono`), always with tabular figures.

Two utilities encode the signature treatments so they are written once:

- `num` — mono, tabular numerals, slightly tightened. Put it on anything numeric.
- `text-label` — the uppercase mono micro caption (11px, tracked). Eyebrows, section titles, badges, the banner's captions.

Scale: `text-2xs` (11px) → `text-6xl` (60px), each with a paired line height. Headings use `tracking-tight`; the score uses `tracking-tighter`.

## Components (`components/ui`)

| Component            | Notes                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `Button`             | `primary` (inverse, quiet), `buy` (green), `sell` (red), `outline`, `ghost`; sizes `sm md lg icon`; `loading`. `buttonClassName()` gives the same look to a `Link`. |
| `Card`               | `default`, `raised`, `ghost`; `interactive` lifts on hover. `CardHeader / Title / Description / Content / Footer`. |
| `Badge`              | Mono micro label; tones `neutral positive negative warning accent outline`; optional status `dot`. |
| `Avatar`             | Photo or initials on a raised surface; sizes `xs`–`2xl`; ring variants.                           |
| `ScoreDisplay`       | The Momentum Score: integer bright, decimal quieter, direction read at the baseline; sizes `sm md lg xl`; `flash` on change. |
| `DirectionIndicator` | Heating / cooling / flat: arrow + colour + signed change; `directionOf()` applies the flat threshold (0.05). |
| `CountdownTimer`     | Ring + `0:27` digits from the shared Engine clock; red and pulsing in the last 5 s; sizes `banner`, `lg`. |
| `Skeleton*`          | `Skeleton`, `SkeletonText`, `SkeletonCircle`, `SkeletonPersonRow`, `SkeletonStat`, `SkeletonFeedItem`. |
| `Input`, `Field`     | One height and radius, accent focus; `Field` adds label, hint and error.                          |
| `Sheet`              | Modal surface: bottom sheet on mobile, centred dialog on desktop. Sits **below the banner**, so the timer stays visible above every modal. |
| `PageHeader`, `SectionHeader`, `PhaseNotice` | Page rhythm and the "arrives in phase N" marker for placeholder slots.  |

`/design` renders all of them with sample values.

## The Engine clock

`components/engine/engine-clock.ts` is a single module-level store read through `useSyncExternalStore`, so every timer on a page ticks on the same frame. Ticks are aligned to wall-clock multiples of 30 s (…:00 and …:30), the cadence the cron heartbeat uses, so the countdown needs no server round trip and is identical on every client. `useEngineClock()` returns `secondsLeft`, `progress`, `urgent`, `justTicked`.

## The shell (`components/shell`)

- **Top banner** (56px, fixed, translucent): mark and wordmark, desktop navigation, platform pulse (Market Mood + Engine status), the countdown, search (`⌘K`), profile. Layered above sheets (`--z-banner` > `--z-overlay`).
- **Bottom tab bar** (mobile, < md): Home, Portfolio, Feed, Profile. Clears the home indicator via `pb-safe`.
- **Two-panel layout** (desktop, ≥ lg): main column plus a sticky 21rem right rail. A route opts into the rail by adding a page under `app/(app)/@rail`; Home does. Everything else gets the full width.
- Pages fill slots; the shell decides placement. Content max width is `--spacing-shell` (80rem).

Layering lives in `:root` as `--z-*` custom properties, used as `z-(--z-banner)`.

## Quality bar

- No default browser styling: base layer sets ground, text, selection, focus rings, scrollbars, `cursor: pointer` on buttons.
- Spacing on the 4px scale only; structural sizes are named tokens.
- Transitions on every interactive element (160ms default); `prefers-reduced-motion` collapses all motion.
- Loading states: `app/(app)/loading.tsx` plus per-slot skeletons; placeholders never render empty.
- Tap targets are at least `--spacing-touch` (44px); text on coloured buttons uses the paired `*-fg` token for contrast.
