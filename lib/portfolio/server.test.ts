import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RANGES } from "@/lib/person/profile-model";

/**
 * The value series read after the tab-switch lag fix (2026-10-04): the
 * server renders 1H and 24H, the series route reads 7D and ALL on demand,
 * and both ask the database for exactly what the page asked for before: the
 * same RPC, the same since and points per range from RANGES. The proof that
 * the values are unchanged is that the arguments are, call for call.
 */

const rpc = vi.fn();

vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/supabase-server", () => ({ createSupabaseServerClient: async () => ({ rpc }) }));

const row = (at: string, cents: number) => ({ bucket_at: at, value_cents: cents, open_cents: cents, samples: 1 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
  rpc.mockReset();
  rpc.mockImplementation(async (_name: string, args: { p_since?: string; p_points: number }) => ({ data: [row("2026-10-04T11:00:00Z", 1000_00), row(`2026-10-04T11:${String(args.p_points % 60).padStart(2, "0")}:00Z`, 1001_00)], error: null }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("getMyValueSeries", () => {
  it("reads only 1H and 24H by default, with RANGES' own since and points", async () => {
    const { getMyValueSeries, SERVER_RENDERED_RANGES } = await import("./server");
    const series = await getMyValueSeries();
    expect(SERVER_RENDERED_RANGES).toEqual(["1h", "24h"]);
    expect(rpc).toHaveBeenCalledTimes(2);
    for (const key of ["1h", "24h"] as const) {
      const range = RANGES.find((r) => r.key === key)!;
      expect(rpc).toHaveBeenCalledWith("my_portfolio_value_series", { p_since: new Date(Date.now() - range.windowMs!).toISOString(), p_points: range.points });
      expect(series[key]).toHaveLength(2);
    }
    expect(series["7d"]).toEqual([]);
    expect(series.all).toEqual([]);
  });

  it("reads 7D and ALL on demand with exactly the arguments the page used before: since from the window, points from RANGES, no since for ALL", async () => {
    const { getMyValueSeries } = await import("./server");
    const series = await getMyValueSeries(["7d", "all"]);
    expect(rpc).toHaveBeenCalledTimes(2);
    const sevenDays = RANGES.find((r) => r.key === "7d")!;
    const all = RANGES.find((r) => r.key === "all")!;
    expect(rpc).toHaveBeenCalledWith("my_portfolio_value_series", { p_since: new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(), p_points: sevenDays.points });
    expect(rpc).toHaveBeenCalledWith("my_portfolio_value_series", { p_since: undefined, p_points: all.points });
    expect(series["7d"].map((point) => [point.at, point.score])).toEqual([
      ["2026-10-04T11:00:00Z", 100000],
      [`2026-10-04T11:${sevenDays.points % 60}:00Z`, 100100],
    ]);
    expect(series["1h"]).toEqual([]);
  });

  it("the union of the server's ranges and the route's is every range, each read exactly once", async () => {
    const { getMyValueSeries, SERVER_RENDERED_RANGES } = await import("./server");
    await getMyValueSeries(SERVER_RENDERED_RANGES);
    await getMyValueSeries(["7d"]);
    await getMyValueSeries(["all"]);
    const points = rpc.mock.calls.map((call) => (call[1] as { p_points: number }).p_points).sort((a, b) => a - b);
    expect(points).toEqual(RANGES.map((range) => range.points).sort((a, b) => a - b));
  });
});
