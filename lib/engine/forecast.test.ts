import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { makePerson } from "@/lib/__tests__/fixtures";

import { DEFAULT_ENGINE_CONFIG } from "./config";
import { rulesBasedScorer } from "./sentiment/rules";
import { createMemoryEngineStore, type MemoryEngineSeed } from "./store";
import { runEngineTick } from "./tick";
import type { EngineSignal } from "./types";

/**
 * PHASE 19 — THE ONE HARD RULE: votes influence NOTHING.
 *
 * The Forecast force exists in the config at weight 0.00 and nowhere else.
 * These tests assert it rather than trust a comment: the weight is pinned,
 * no force module reads it, the Engine's source never names the votes
 * table, and a tick run beside a full set of votes scores exactly as a tick
 * run without them. lib/forecast/forecast.db.test.ts proves the same on real
 * Postgres for every read the store makes and the write it commits.
 */

const NOW = new Date("2026-09-19T12:00:00.000Z");
const ROOT = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the Forecast force weight", () => {
  it("ships at exactly 0.00", () => {
    expect(DEFAULT_ENGINE_CONFIG.forecast.weight).toBe(0);
    expect(DEFAULT_ENGINE_CONFIG.forecast).toEqual({ weight: 0 });
  });

  it("is read by no force, no scorer and no store: nothing in the Engine multiplies by it yet", () => {
    const engine = sourceFiles(join(ROOT, "lib", "engine"));
    const readers = engine
      .filter((file) => /\bforecast\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file))
      .sort();
    // Only the config declares it: no force, scorer, store or tick names it,
    // so nothing can read `config.forecast.weight` and multiply by it.
    expect(readers).toEqual(["lib/engine/config.ts"]);
    const config = readFileSync(join(ROOT, "lib", "engine", "config.ts"), "utf8");
    expect(config).toMatch(/forecast: \{ weight: 0 \}/);
  });

  it("the Engine never names the votes table or the crowd's vocabulary in its read or write path", () => {
    const engine = sourceFiles(join(ROOT, "lib", "engine"));
    const offenders = engine
      .filter((file) => file !== join(ROOT, "lib", "engine", "config.ts"))
      .filter((file) => /forecast_votes|cast_forecast_vote|forecast_summary|ForecastVote|lib\/forecast/.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
    // And the store reads exactly the tables it always has.
    const store = readFileSync(join(ROOT, "lib", "engine", "store.ts"), "utf8");
    const tables = [...store.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1]);
    expect(new Set(tables)).toEqual(new Set(["people", "signals", "positions", "trade_events", "inverse_pairs", "engine_ticks"]));
    const rpcs = [...store.matchAll(/\.rpc\("([a-z_]+)"/g)].map((match) => match[1]);
    expect(new Set(rpcs)).toEqual(new Set(["person_signal_volume", "apply_engine_tick"]));
  });
});

describe("a tick with votes present equals a tick without", () => {
  const drake = makePerson({ id: "p-drake", slug: "drake", display_name: "Drake", revert_target: 65, category: "musician" });
  const mrbeast = makePerson({ id: "p-mrbeast", slug: "mrbeast", display_name: "MrBeast", revert_target: 68 });
  const praise = (id: string, personId: string): EngineSignal => ({
    id,
    personId,
    headline: "MrBeast crosses 500M subscribers",
    rawPayload: { kind: "milestone" },
    sourceName: "youtube",
    sourceTier: 2,
    occurredAt: NOW,
    createdAt: NOW,
  });
  const seed = (): MemoryEngineSeed => ({ people: [drake, mrbeast], signals: [praise("s1", "p-drake"), praise("s2", "p-mrbeast")], openCapitalCents: { "p-drake": 250_000 } });

  it("identical scores, forces, events and processed signals, whatever the crowd said and whether or not a person is paused", async () => {
    const quiet = createMemoryEngineStore(seed());
    const withoutVotes = await runEngineTick({ store: quiet, scorer: rulesBasedScorer, now: NOW });

    // The only thing about votes a tick could ever see is the people row's
    // pause flag, and a whole crowd of votes decorating the store; neither
    // is read. Rising on one, falling on the other, one of them paused.
    const loud = createMemoryEngineStore({
      ...seed(),
      people: [{ ...drake, forecast_paused: true }, { ...mrbeast, forecast_paused: false }],
    });
    Object.assign(loud, {
      forecastVotes: [
        { personId: "p-drake", direction: "rising", reason: "professional", scoreAtVote: 50 },
        { personId: "p-drake", direction: "rising", reason: "media", scoreAtVote: 50 },
        { personId: "p-mrbeast", direction: "falling", reason: "financial", scoreAtVote: 50 },
        { personId: "p-mrbeast", direction: "falling", reason: "social", scoreAtVote: 50 },
        { personId: "p-mrbeast", direction: "falling", reason: "other", scoreAtVote: 50 },
      ],
    });
    const withVotes = await runEngineTick({ store: loud, scorer: rulesBasedScorer, now: NOW });

    expect(withVotes.people).toEqual(withoutVotes.people);
    expect(withVotes.signals).toEqual(withoutVotes.signals);
    expect(withVotes.mood).toBe(withoutVotes.mood);
    expect(loud.scoreEvents).toEqual(quiet.scoreEvents);
    // The history rows carry the wall-clock moment each tick finished; everything else must match.
    const history = (store: typeof quiet) => store.scoreHistory.map((row) => ({ ...row, recordedAt: null }));
    expect(history(loud)).toEqual(history(quiet));
    expect(loud.processedSignals).toEqual(quiet.processedSignals);
    expect(loud.people.map((p) => p.current_score)).toEqual(quiet.people.map((p) => p.current_score));
    // No person's forces include a sixth.
    for (const person of withVotes.people) expect(Object.keys(person.forces)).not.toContain("forecast");
  });
});
