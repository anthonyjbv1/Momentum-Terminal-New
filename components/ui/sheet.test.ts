import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE DESKTOP DIALOG ENDS INSIDE THE WINDOW. The panel used to sit `top-20`
 * below the overlay's top edge while allowed the overlay's full height
 * (`max-h-full`), so at its limit it hung 80 px past the window — and the
 * pinned footer with the Review and Confirm buttons was the part cut off
 * (1280×720 and 1366×768, from Phase 29's taller trade sheet on). The layout
 * itself is measured in a browser; what a unit test can hold is the rule
 * that makes it true: the desktop top offset and the height limit come from
 * the SAME token, the limit being the container less that gap above and below.
 */

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The panel's class list: every string literal inside the cn(...) call on the element with role="dialog". */
function panelClasses(source: string): string[] {
  const start = source.indexOf('role="dialog"');
  const cnStart = source.indexOf("className={cn(", start);
  const cnEnd = source.indexOf(")}", cnStart);
  const call = source.slice(cnStart, cnEnd);
  return [...call.matchAll(/"([^"]*)"/g)].flatMap((match) => match[1].split(/\s+/)).filter(Boolean);
}

describe("the Sheet's desktop geometry", () => {
  const classes = panelClasses(read("components/ui/sheet.tsx"));

  it("takes its desktop top offset and its height limit from the dialog gap", () => {
    expect(classes).toContain("sm:top-dialog-gap");
    expect(classes).toContain("sm:max-h-dialog");
  });

  it("has no other desktop top offset that the height limit would not know about", () => {
    expect(classes.filter((name) => name.startsWith("sm:top-"))).toEqual(["sm:top-dialog-gap"]);
    expect(classes.filter((name) => name.startsWith("sm:max-h-"))).toEqual(["sm:max-h-dialog"]);
  });

  it("limits the height to the container less the gap above and below", () => {
    const css = read("app/globals.css");
    const utility = css.match(/@utility max-h-dialog \{([^}]*)\}/);
    expect(utility?.[1].replace(/\s+/g, " ").trim()).toBe("max-height: calc(100% - 2 * var(--spacing-dialog-gap));");
    expect(read("app/styles/tokens.css")).toMatch(/--spacing-dialog-gap:\s*[^;]+;/);
  });

  it("keeps the phone's bottom sheet: flush with the bottom, the full height below the banner", () => {
    expect(classes).toEqual(expect.arrayContaining(["inset-x-0", "bottom-0", "max-h-full"]));
  });
});
