# Momentum Terminal design system

Editorial monochrome. Jet-black ground, soft grey cards, white type, generous space. One token file drives everything; components never name a colour, size or font directly.

## How to change the look

Every visual value lives in **`app/styles/tokens.css`**, inside one `@theme` block. Tailwind 4 turns each variable into a utility class (`bg-surface`, `text-fg-muted`, `rounded-2xl`, `shadow-card`, `h-banner`) and a CSS variable (`var(--color-positive)`). Components only ever use those classes, so an edit there cascades through the whole platform on the next render.

| To change…                       | Edit                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| The green used for Buy / heating | `--color-positive` (and `--color-positive-fg` for text on it). Buy buttons, heating reads, positive badges follow. |
| The red used for Sell / cooling  | `--color-negative`, `--color-negative-fg`                                                     |
| The ground / card greys          | `--color-canvas`, `--color-surface`, `--color-surface-raised`, `--color-surface-overlay`      |
| Text colours                     | `--color-fg`, `--color-fg-secondary`, `--color-fg-muted`, `--color-fg-faint`                  |
| The interface typeface           | point the `inter` `path` in `lib/fonts.ts` at a new file, keep the `--font-inter` variable (or point `--font-sans` at a new one) |
| The numeric typeface             | same, for `--font-jetbrains-mono` → `--font-mono`                                             |
| Type scale                       | `--text-*` and the paired `--text-*--line-height`                                             |
| Corner radius                    | `--radius-*` (cards use `2xl`, sheets `3xl`, buttons `full`)                                  |
| Elevation                        | `--shadow-*` (an inner highlight, not a drop shadow)                                          |
| Banner / tab bar / rail sizes    | `--spacing-banner`, `--spacing-tabbar`, `--spacing-rail`, `--spacing-shell`, `--spacing-touch` |
| Motion                           | `--animate-*`, `--default-transition-duration`, `--ease-out-expo`                              |

The stock Tailwind palette, fonts, radii and shadows are reset (`--color-*: initial;` etc.), so a class like `bg-red-500` or `text-gray-400` does not compile to anything. If a component needs a new value, add a token, do not inline it.

One deliberate mirror exists outside the token file and is commented as such: `viewport.themeColor` in `app/layout.tsx`, because browser chrome cannot read CSS. Update it when recolouring the ground.

A unit test, `lib/__tests__/design-tokens.test.ts`, fails the suite if any file under `app/` or `components/` contains a hex colour, a colour function, a pixel literal or a Tailwind arbitrary value (`w-[…]`). That is the enforcement.

## Palette

Monochrome with two exceptions. Every grey has zero chroma: there is no cast.

| Token                | Value                | Role                                          |
| -------------------- | -------------------- | --------------------------------------------- |
| `canvas`             | `oklch(0% 0 0)`      | jet-black page ground (the logo's black)      |
| `surface`            | `oklch(17% 0 0)`     | cards, panels                                 |
| `surface-raised`     | `oklch(22% 0 0)`     | hover, inputs, chips, nested tiles            |
| `surface-overlay`    | `oklch(20% 0 0)`     | sheets, menus                                 |
| `line` / `line-strong` | `oklch(24% …)` / `oklch(34% …)` | hairline dividers / focus edges   |
| `fg` … `fg-faint`    | 97% → 42% lightness  | four text levels                              |
| `positive`           | `oklch(73% 0.17 148)` | **HIGH, Buy, heating.** One of two colours.  |
| `negative`           | `oklch(66% 0.2 25)`  | **LOW, Sell, cooling.** The other one.        |
| `neutral`            | `oklch(66% 0 0)`     | flat direction, standby: grey                 |
| `accent`             | `oklch(97% 0 0)`     | focus rings, emphasis: white                  |

The rule: green and red appear only on trading actions and directional score movement. Navigation, focus, status, links, the timer, the mark: all white or grey. Numbers themselves stay `fg`; only the change beside them carries colour.

## Typography

- **Inter** for the interface (`font-sans`): headings, body, labels, buttons, badges.
- **JetBrains Mono** for numbers only, through the `num` utility: scores, prices, deltas, percentages, the countdown. Always tabular.

Hierarchy carries the design: page titles are `text-4xl sm:text-5xl font-bold tracking-tighter`, section labels are `text-label` (12px, uppercase, quietly tracked, muted), body is 16px with comfortable line height, captions are 14px muted. Weight contrast (bold titles, regular body, medium labels) does the work; size steps are generous.

## Components (`components/ui`)

| Component            | Notes                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `Button`             | Pills. `primary` (white on black), `buy` (green), `sell` (red), `outline` (soft grey surface), `ghost`; sizes `sm md lg icon`; `loading`. `buttonClassName()` gives the same look to a `Link`. |
| `Card`               | `rounded-2xl`, no border, inner highlight only; `default`, `raised`, `ghost`; `interactive` brightens and lifts on hover. `CardHeader / Title / Description / Content / Footer` with 24px padding. |
| `Badge`              | Small pill, 12px medium; tones `neutral positive negative warning accent outline`; optional status `dot`. Grey unless the meaning is direction or live status. |
| `Avatar`             | Photo or initials on a raised surface; sizes `xs`–`2xl`; ring variants.                           |
| `ScoreDisplay`       | The Momentum Score: bright integer, quiet decimal, direction read at the baseline; sizes `sm md lg xl`; `flash` on change. |
| `DirectionIndicator` | Heating / cooling / flat: arrow + colour + signed change; flat is grey; `directionOf()` applies the 0.05 threshold. |
| `CountdownTimer`     | Small mono digits over a hairline that fills across the 30-second cycle. Grey, white in the last 5 s, never coloured. Sizes `banner`, `lg`. |
| `Skeleton*`          | `Skeleton`, `SkeletonText`, `SkeletonCircle`, `SkeletonPersonRow`, `SkeletonStat`, `SkeletonFeedItem`. |
| `Input`, `Field`     | Soft grey field, no border until focus; `Field` adds label, hint and error.                       |
| `Sheet`              | Modal surface: bottom sheet on mobile, centred dialog on desktop, `rounded-3xl`, no border. Sits **below the banner**, so the timer stays visible above every modal. |
| `PageHeader`, `SectionHeader`, `PhaseNotice` | Page rhythm and the quiet "arrives in phase N" marker for placeholder slots. |

`/design` renders all of them with sample values.

## The mark

The brand artwork lives at **`public/brand/momentum-mark.png`** and is used unmodified. `components/brand/momentum-mark.tsx` renders it through `next/image`, which downscales and serves a modern format per request.

The file is a white orbital mark on an opaque black tile, so the component applies `mix-blend-mode: screen`: screen keeps white pixels white and lets black pixels show whatever is behind them, anti-aliased edges included. The black tile therefore disappears on the banner and on grey cards without the file being edited. To swap the mark, replace that one PNG.

`app/icon.png` is the favicon: a straight 512 × 512 Lanczos downscale of the same file, so browser tabs get the artwork at icon weight rather than a 700 KB download. Regenerate it after replacing the mark:

```bash
node -e 'require("sharp")("public/brand/momentum-mark.png").resize(512,512,{kernel:"lanczos3"}).png().toFile("app/icon.png")'
```

## The Engine clock

`components/engine/engine-clock.ts` is a single module-level store read through `useSyncExternalStore`, so every timer on a page ticks on the same frame. Ticks are aligned to wall-clock multiples of 30 s (…:00 and …:30), the cadence the cron heartbeat uses, so the countdown needs no server round trip and is identical on every client. `useEngineClock()` returns `secondsLeft`, `progress`, `urgent`, `justTicked`.

## The shell (`components/shell`)

- **Top banner** (64px, fixed, translucent, hairline base): mark and wordmark, desktop navigation (active item white, others grey), the Mood pill, the quiet countdown, a round search button (a pill field on desktop, `⌘K`), profile. Layered above sheets (`--z-banner` > `--z-overlay`).
- **Bottom tab bar** (mobile, < md): four icons, the active one white. Clears the home indicator via `pb-safe`.
- **Two-panel layout** (desktop, ≥ lg): main column plus a sticky 22rem right rail, no divider. A route opts into the rail by adding a page under `app/(app)/@rail`; Home does. Everything else gets the full width.
- Pages fill slots; the shell decides placement. Content max width is `--spacing-shell` (80rem).

Layering lives in `:root` as `--z-*` custom properties, used as `z-(--z-banner)`.

## Quality bar

- No default browser styling: base layer sets ground, text, selection, focus rings, scrollbars, `cursor: pointer` on buttons.
- Spacing on the 4px scale only; structural sizes are named tokens. Sections sit 40px apart; cards pad 24px.
- Transitions on every interactive element (180ms default); `prefers-reduced-motion` collapses all motion.
- Loading states: `app/(app)/loading.tsx` plus per-slot skeletons; placeholders never render empty.
- Tap targets are at least `--spacing-touch` (44px); text on coloured buttons uses the paired `*-fg` token for contrast.
