import { describe, expect, it } from "vitest";

import { Y_PADDING, Y_RANGE_FLOOR, blendSeries, easeOutCubic, gridValues, monotonePath, scoreDomain, seriesPath } from "./chart-math";

describe("scoreDomain", () => {
  it("never spans fewer than the floor, centred on the data", () => {
    expect(Y_RANGE_FLOOR).toBe(2);
    const domain = scoreDomain([{ t: 0, score: 50.0 }, { t: 1, score: 50.02 }], 80);
    const pad = Y_RANGE_FLOOR * Y_PADDING;
    expect(domain.lo).toBeCloseTo(50.01 - 1 - pad, 6);
    expect(domain.hi).toBeCloseTo(50.01 + 1 + pad, 6);
    expect(domain.gravityInRange).toBe(false);
  });

  it("follows the data once it moves more than the floor", () => {
    const domain = scoreDomain([{ t: 0, score: 48 }, { t: 1, score: 53 }], 80);
    expect(domain.hi - domain.lo).toBeCloseTo(5 * (1 + 2 * Y_PADDING), 6);
  });

  it("takes in the gravity target when it is within a span of the data", () => {
    const near = scoreDomain([{ t: 0, score: 50 }, { t: 1, score: 51 }], 52.5);
    expect(near.gravityInRange).toBe(true);
    expect(near.hi).toBeGreaterThanOrEqual(52.5);
    const far = scoreDomain([{ t: 0, score: 50 }, { t: 1, score: 51 }], 65);
    expect(far.gravityInRange).toBe(false);
  });

  it("grids on 1 / 2 / 5 steps", () => {
    expect(gridValues(49, 51.6)).toEqual([49, 50, 51]);
    expect(gridValues(49.4, 50.6)).toEqual([49.5, 50, 50.5]);
    expect(gridValues(40, 60)).toEqual([40, 45, 50, 55, 60]);
  });
});

describe("monotonePath", () => {
  it("passes through every point with cubic segments and no overshoot on a plateau", () => {
    const d = monotonePath([
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 0 },
    ]);
    expect(d.startsWith("M0.00,10.00")).toBe(true);
    expect(d.split(" C")).toHaveLength(4);
    // Between two equal points the control points stay on the plateau.
    expect(d).toContain("C3.33,10.00 6.67,10.00 10.00,10.00");
  });

  it("degrades to a move or a line for one or two points", () => {
    expect(monotonePath([{ x: 1, y: 2 }])).toBe("M1.00,2.00");
    expect(monotonePath([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe("M1.00,2.00 L3.00,4.00");
  });

  it("breaks the line at a gap", () => {
    const d = seriesPath(
      [
        { t: 0, x: 0, y: 0 },
        { t: 30, x: 10, y: 1 },
        { t: 300, x: 20, y: 2 },
        { t: 330, x: 30, y: 3 },
      ],
      90,
    );
    expect(d.match(/M/g)).toHaveLength(2);
  });
});

describe("blendSeries", () => {
  const from = [
    { t: 0, score: 50 },
    { t: 30, score: 50.2 },
  ];

  it("grows a new tick out of the previous last point", () => {
    const to = [...from, { t: 60, score: 50.8 }];
    // At the start the frame IS the previous series: the new segment has no length yet.
    expect(blendSeries(from, to, 0)).toEqual(from);
    const half = blendSeries(from, to, 0.5);
    expect(half).toHaveLength(3);
    expect(half[1]).toEqual({ t: 30, score: 50.2 });
    expect(half[2]).toEqual({ t: 45, score: 50.5 });
    expect(blendSeries(from, to, 1)[2]).toEqual({ t: 60, score: 50.8 });
  });

  it("moves a revised close in place", () => {
    const to = [{ t: 0, score: 50 }, { t: 45, score: 50.6 }];
    const half = blendSeries(from, to, 0.5);
    expect(half).toHaveLength(2);
    expect(half[0]).toEqual({ t: 0, score: 50 });
    expect(half[1].t).toBe(37.5);
    expect(half[1].score).toBeCloseTo(50.4, 9);
  });

  it("keeps a dropped head point riding along mid-transition", () => {
    const to = [{ t: 30, score: 50.2 }, { t: 60, score: 50.8 }];
    expect(blendSeries(from, to, 0.5).map((point) => point.t)).toEqual([0, 30, 45]);
  });

  it("eases out", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 6);
  });
});
