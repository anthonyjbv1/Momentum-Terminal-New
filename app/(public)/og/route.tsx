import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { FEATURED, HEADLINES, OG } from "@/lib/landing/copy";
import { readFeatured } from "@/lib/landing/featured";

/**
 * GET /og — the share image (Phase 28): the founder's live Momentum Score,
 * in the platform's own black-and-white, at 1200x630.
 *
 * Rendered on request from the same one-tick memo the page reads, so a link
 * unfurled now carries the number the page shows now. Cached at the edge for
 * a minute: a preview is not a live surface. When the read fails the image
 * carries the headline and no number — the same rule as the page.
 *
 * ONLY THE FOUNDER. No other person's name reaches this file: the copy it
 * draws from is lib/landing/copy.ts and the payload names nobody.
 *
 * TOKENS CANNOT REACH HERE. The image is drawn by Satori outside any
 * browser, so CSS variables do not cascade into it; the four values below
 * are the tokens' own (canvas, fg, fg-muted, fg-faint) written out, and the
 * file is allowlisted in the design-token guard for exactly that reason.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WIDTH = 1200;
const HEIGHT = 630;
const CANVAS = "#000000";
const FG = "#f7f7f7";
const FG_MUTED = "#8c8c8c";
const FG_FAINT = "#5c5c5c";

/**
 * The vendored WOFF files (Satori reads TTF/OTF/WOFF, not the woff2 the
 * app's own @fontsource-variable packages ship), read from the project root
 * the way the Next image-generation docs read a local font in the Node
 * runtime; next.config.ts traces the directory into this route's bundle.
 */
const fontFile = (name: string) => readFile(join(process.cwd(), "lib", "og", "fonts", name));

const utcTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

export async function GET() {
  const [inter400, inter600, mono600] = await Promise.all([fontFile("inter-latin-400-normal.woff"), fontFile("inter-latin-600-normal.woff"), fontFile("jetbrains-mono-latin-600-normal.woff")]);

  let score: string | null = null;
  let asOf: string | null = null;
  try {
    const payload = await readFeatured();
    if (payload) {
      score = payload.score.toFixed(1);
      asOf = payload.lastTickAt ? `${OG.asOf} ${utcTime.format(Date.parse(payload.lastTickAt))} UTC` : null;
    }
  } catch (error) {
    console.warn("[og] featured read failed:", error instanceof Error ? error.message : error);
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: WIDTH,
          height: HEIGHT,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: CANVAS,
          color: FG,
          fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, fontSize: 30 }}>
            <span style={{ fontWeight: 600 }}>Momentum</span>
            <span style={{ color: FG_MUTED }}>Terminal</span>
          </div>
          <div style={{ display: "flex", fontSize: 24, color: FG_MUTED }}>{OG.live}</div>
        </div>

        {score ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", fontSize: 26, color: FG_MUTED, letterSpacing: 2, textTransform: "uppercase" }}>{OG.scoreLabel}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4, fontFamily: "JetBrains Mono", fontWeight: 600, letterSpacing: -6 }}>
              <span style={{ fontSize: 260, lineHeight: 1 }}>{score.split(".")[0]}</span>
              <span style={{ fontSize: 120, lineHeight: 1, color: FG_MUTED }}>.{score.split(".")[1]}</span>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", fontSize: 88, fontWeight: 600, letterSpacing: -3, lineHeight: 1.05, maxWidth: 1000 }}>{HEADLINES.chosen}</div>
        )}

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 40, fontWeight: 600 }}>{FEATURED.name}</span>
            <span style={{ fontSize: 26, color: FG_MUTED }}>{FEATURED.role}</span>
          </div>
          {asOf ? <span style={{ fontSize: 22, color: FG_FAINT, fontFamily: "JetBrains Mono" }}>{asOf}</span> : null}
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: [
        { name: "Inter", data: inter400, weight: 400, style: "normal" },
        { name: "Inter", data: inter600, weight: 600, style: "normal" },
        { name: "JetBrains Mono", data: mono600, weight: 600, style: "normal" },
      ],
      headers: { "cache-control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" },
    },
  );
}
