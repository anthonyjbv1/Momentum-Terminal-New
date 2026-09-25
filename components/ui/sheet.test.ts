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

describe("the wide dialog (Phase 29e)", () => {
  const source = read("components/ui/sheet.tsx");

  it("is the md dialog below lg: every class the wide variant adds is an lg: class", () => {
    const sizeLine = source.split("\n").find((line) => line.includes('size === "wide" ?'));
    expect(sizeLine).toBeDefined();
    const wideSize = sizeLine?.match(/size === "wide" \? "([^"]*)"/)?.[1].split(/\s+/) ?? [];
    expect(wideSize).toEqual(["sm:max-w-lg", "lg:max-w-dialog-wide"]);
    const added = [...source.matchAll(/wide && "([^"]*)"/g)].flatMap((match) => match[1].split(/\s+/));
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) expect(name.startsWith("lg:"), name).toBe(true);
  });

  it("is never wider than the window less the dialog gap either side, and the limit is not Tailwind's own", () => {
    const css = read("app/globals.css");
    const utility = css.match(/@utility max-w-dialog-wide \{([^}]*)\}/);
    expect(utility?.[1].replace(/\s+/g, " ").trim()).toBe("max-width: min(var(--spacing-dialog-wide-limit), 100% - 2 * var(--spacing-dialog-gap));");
    // A spacing token named dialog-wide would generate Tailwind's own max-w-dialog-wide (the width alone) and override this one.
    expect(read("app/styles/tokens.css")).not.toMatch(/--spacing-dialog-wide:/);
  });

  it("the trade sheet is the one wide dialog", () => {
    expect(read("components/trade/trade-sheet.tsx")).toContain('size="wide"');
  });
});
