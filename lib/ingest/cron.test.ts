import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { INGEST_CRON_DEFAULTS, authorizeIngestCronRequest, runScheduledIngestion } from "./cron";
import type { IngestSummary } from "./runner";

const summary = (): IngestSummary => ({
  runId: "run-1",
  trigger: "cron",
  forced: false,
  startedAt: "2026-09-14T16:00:00.000Z",
  finishedAt: "2026-09-14T16:00:09.000Z",
  durationMs: 9000,
  sourcesRun: [],
  sourcesSkipped: [],
  configProblems: [],
  totals: { sources: 4, people: 5, signalsCreated: 7, snapshotsRecorded: 7, observations: 7, errors: 0, blockedDropped: 0, duplicatesCollapsed: 0, excludedFiltered: 0 },
  errors: [],
  budget: { ms: 35_000, exhausted: false },
});

const quiet = () => undefined;

describe("runScheduledIngestion", () => {
  it("does nothing at all when the flag is off, and says so without a secret", async () => {
    let ran = false;
    const result = await runScheduledIngestion({
      enabled: false,
      run: async () => {
        ran = true;
        return summary();
      },
      log: quiet,
    });
    expect(ran).toBe(false);
    expect(result).toMatchObject({ enabled: false, status: "skipped", reason: 'INGEST_CRON_ENABLED is not "true"' });
    expect(result.summary).toBeUndefined();
  });

  it("skips rather than polling twice when a run is still in flight", async () => {
    let ran = false;
    const startedAt = new Date("2026-09-14T15:58:00.000Z");
    const result = await runScheduledIngestion({
      enabled: true,
      openRun: { id: "run-0", startedAt },
      run: async () => {
        ran = true;
        return summary();
      },
      log: quiet,
    });
    expect(ran).toBe(false);
    expect(result).toMatchObject({ enabled: true, status: "skipped" });
    expect(result.reason).toContain("has not finished");
  });

  it("runs when enabled with nothing in flight, and carries the summary", async () => {
    const result = await runScheduledIngestion({ enabled: true, openRun: null, run: async () => summary(), log: quiet });
    expect(result).toMatchObject({ enabled: true, status: "ran" });
    expect(result.summary?.totals.snapshotsRecorded).toBe(7);
  });

  it("reports a failed run instead of throwing, so one bad hour does not break the schedule", async () => {
    const result = await runScheduledIngestion({
      enabled: true,
      run: async () => {
        throw new Error("upstream exploded");
      },
      log: quiet,
    });
    expect(result).toMatchObject({ enabled: true, status: "ran", error: "upstream exploded" });
  });

  it("blocks for less than the fifteen-minute schedule, and for longer than one invocation can last", () => {
    // Above the route's maxDuration (60 s) so a live run always wins; below the
    // schedule so a crashed run — its row never closed — is already past the
    // window by the next fire and blocks no scheduled poll at all.
    expect(INGEST_CRON_DEFAULTS.staleAfterMinutes).toBeGreaterThan(1);
    expect(INGEST_CRON_DEFAULTS.staleAfterMinutes).toBeLessThan(15);
  });

  it("closes the run inside the platform's 60-second kill: the budget plus the longest poll it can still start fits", () => {
    // The poll in flight when the budget runs out may take one connector
    // timeout, or the publisher catalogue's fetch budget (15 s) plus one feed
    // timeout (6 s), whichever is longer; the close still has to happen after.
    const longestPollMs = Math.max(INGEST_CRON_DEFAULTS.fetchTimeoutMs, 15_000 + 6_000);
    expect(INGEST_CRON_DEFAULTS.runBudgetMs + longestPollMs).toBeLessThan(58_000);
    expect(INGEST_CRON_DEFAULTS.runBudgetMs).toBeGreaterThanOrEqual(30_000);
  });
});

describe("authorizeIngestCronRequest", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it("accepts Vercel's cron bearer or an operator's ingest secret, and refuses anything else", () => {
    const secrets = { cronSecret: "cron-secret", ingestSecret: "ingest-secret" };
    expect(authorizeIngestCronRequest(headers({ authorization: "Bearer cron-secret" }), secrets).ok).toBe(true);
    expect(authorizeIngestCronRequest(headers({ "x-ingest-secret": "ingest-secret" }), secrets).ok).toBe(true);
    expect(authorizeIngestCronRequest(headers({ authorization: "Bearer wrong" }), secrets)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeIngestCronRequest(headers({}), secrets)).toMatchObject({ ok: false, status: 401 });
  });

  it("fails closed when the server has neither secret configured", () => {
    expect(authorizeIngestCronRequest(headers({ authorization: "Bearer anything" }), { cronSecret: null, ingestSecret: null })).toMatchObject({ ok: false, status: 503 });
  });

  it("never authorises with the ENGINE's secret: the two jobs are separately gated", () => {
    expect(authorizeIngestCronRequest(headers({ "x-engine-secret": "engine-secret" }), { cronSecret: "cron-secret", ingestSecret: "ingest-secret" })).toMatchObject({ ok: false, status: 401 });
  });
});

describe("the ingestion path", () => {
  /** Every source file the ingestion path is built from. */
  function sourceFiles(root: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("makes NO LLM calls: nothing it imports reaches the model layer, so the hourly job costs nothing but HTTP", () => {
    const files = [...sourceFiles("lib/ingest"), ...sourceFiles("lib/connectors"), "app/api/ingest/route.ts", "app/api/ingest/cron/route.ts"];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of ['from "@/lib/llm', 'from "../llm', 'from "./llm', "@anthropic-ai/sdk"]) {
        expect(source, `${relative(".", file)} imports ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("reaches the Engine's sentiment lexicon only, which is pure keyword matching and calls nothing", () => {
    // The one lib/engine import the connectors make (the comment digest's lexicon) must stay a local function.
    const rules = readFileSync("lib/engine/sentiment/rules.ts", "utf8");
    expect(rules).not.toContain('from "@/lib/llm');
    expect(rules).not.toContain("await ");
  });
});
