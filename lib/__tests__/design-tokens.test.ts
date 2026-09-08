import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards the design-token rule: no visual value may be hardcoded in a
 * component or page. Colours, pixel sizes and Tailwind arbitrary values
 * belong in app/styles/tokens.css only.
 */

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components"];

/** Files allowed to carry a literal, each with the reason. */
const ALLOWED: Record<string, string> = {
  "app/layout.tsx": "viewport themeColor: browser chrome cannot read CSS variables (mirrors --color-canvas)",
};

const RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: "hex colour", pattern: /#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i },
  { name: "colour function", pattern: /\b(?:oklch|oklab|rgba?|hsla?)\(/ },
  { name: "pixel value", pattern: /\b\d+(?:\.\d+)?px\b/ },
  {
    name: "arbitrary Tailwind value",
    pattern:
      /(?:^|[\s"'`{])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|shadow|from|via|to|w|h|size|min-w|min-h|max-w|max-h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-x|space-y|rounded|inset|top|bottom|left|right|leading|tracking|font|z|opacity|scale|duration|delay|divide)-\[/,
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("design tokens are the only source of visual values", () => {
  const files = SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir)));

  it("scans the UI source tree", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = relative(ROOT, file);
    if (ALLOWED[rel]) continue;

    it(`${rel} has no hardcoded visual values`, () => {
      const source = readFileSync(file, "utf8");
      const offences: string[] = [];
      source.split("\n").forEach((line, index) => {
        for (const rule of RULES) {
          if (rule.pattern.test(line)) offences.push(`${index + 1}: [${rule.name}] ${line.trim()}`);
        }
      });
      expect(offences).toEqual([]);
    });
  }
});
