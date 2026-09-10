import { describe, expect, it } from "vitest";

import { SHORTING_ENABLED_DEFAULT, maxSellCents, resolveOrder } from "./direction";

describe("position direction gating", () => {
  it("launches long-only", () => {
    expect(SHORTING_ENABLED_DEFAULT).toBe(false);
  });

  it("Buy opens or increases a HIGH position", () => {
    expect(resolveOrder({ netBeforeCents: 0, side: "BUY", amountCents: 500, shortingEnabled: false })).toEqual({
      ok: true,
      resolution: { reduceCents: 0, openCents: 500, openDirection: "HIGH", netAfterCents: 500 },
    });
    expect(resolveOrder({ netBeforeCents: 800, side: "BUY", amountCents: 500, shortingEnabled: false })).toMatchObject({
      ok: true,
      resolution: { openCents: 500, openDirection: "HIGH", netAfterCents: 1300 },
    });
  });

  it("Sell closes or reduces an existing position", () => {
    expect(resolveOrder({ netBeforeCents: 800, side: "SELL", amountCents: 500, shortingEnabled: false })).toEqual({
      ok: true,
      resolution: { reduceCents: 500, openCents: 0, openDirection: null, netAfterCents: 300 },
    });
    expect(resolveOrder({ netBeforeCents: 500, side: "SELL", amountCents: 500, shortingEnabled: false })).toMatchObject({
      ok: true,
      resolution: { reduceCents: 500, openCents: 0, netAfterCents: 0 },
    });
  });

  it("rejects a Sell that would take the net position negative while shorting is disabled", () => {
    const outcome = resolveOrder({ netBeforeCents: 200, side: "SELL", amountCents: 500, shortingEnabled: false });
    expect(outcome).toMatchObject({ ok: false, reason: "shorting_disabled", maxSellCents: 200 });
    expect(resolveOrder({ netBeforeCents: 0, side: "SELL", amountCents: 1, shortingEnabled: false }).ok).toBe(false);
    expect(maxSellCents(200, false)).toBe(200);
    expect(maxSellCents(-50, false)).toBe(0);
  });

  it("with shorting enabled the same Sell opens a LOW position past the HIGH it closes", () => {
    expect(resolveOrder({ netBeforeCents: 200, side: "SELL", amountCents: 500, shortingEnabled: true })).toEqual({
      ok: true,
      resolution: { reduceCents: 200, openCents: 300, openDirection: "LOW", netAfterCents: -300 },
    });
    expect(maxSellCents(200, true)).toBeNull();
  });

  it("a Buy covers a short before going long, whatever the gate says", () => {
    const covered = { ok: true, resolution: { reduceCents: 300, openCents: 200, openDirection: "HIGH", netAfterCents: 200 } };
    expect(resolveOrder({ netBeforeCents: -300, side: "BUY", amountCents: 500, shortingEnabled: true })).toEqual(covered);
    expect(resolveOrder({ netBeforeCents: -300, side: "BUY", amountCents: 500, shortingEnabled: false })).toEqual(covered);
  });

  it("insists on integer cents", () => {
    expect(() => resolveOrder({ netBeforeCents: 0, side: "BUY", amountCents: 0, shortingEnabled: false })).toThrow(RangeError);
    expect(() => resolveOrder({ netBeforeCents: 0, side: "BUY", amountCents: 12.5, shortingEnabled: false })).toThrow(RangeError);
  });
});
