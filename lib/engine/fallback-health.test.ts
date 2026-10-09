import { describe, expect, it } from "vitest";

import { fallbackReason, fallbackStatus } from "./fallback-health";

/** The outage of 2026-10-09: every sentiment call refused from 17:16 to 17:46 UTC, thirteen signals scored by the rules. */
const CREDIT = 'invalid_request: Anthropic rejected the request: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

describe("the fallback warning", () => {
  it("names every tick that scored by the rules fallback, with the provider's reason from the ledger, and a summary line when there is more than one", () => {
    const ticks = [
      { tickNumber: 65935, startedAt: "2026-10-09T17:46:38.518Z", scoring: { fallbacks: 1, llmScored: 0, llmCalls: 1 } },
      { tickNumber: 65934, startedAt: "2026-10-09T17:46:08.516Z", scoring: { fallbacks: 5, llmScored: 0, llmCalls: 4 } },
      { tickNumber: 65933, startedAt: "2026-10-09T17:45:38.000Z", scoring: { fallbacks: 0, llmScored: 2, llmCalls: 1 } },
      { tickNumber: 65932, startedAt: "2026-10-09T17:45:08.000Z", scoring: null },
    ];
    const failures = [
      { tickNumber: 65935, error: CREDIT },
      { tickNumber: 65934, error: CREDIT },
      { tickNumber: 65934, error: CREDIT },
      { tickNumber: null, error: "timeout" },
    ];
    const status = fallbackStatus(ticks, failures);
    expect(status.ticks.map((t) => [t.tickNumber, t.fallbacks, t.reasons.length])).toEqual([
      [65935, 1, 1],
      [65934, 5, 1],
    ]);
    expect(status.warnings).toEqual([
      "2 of the last 4 scoring ticks fell back to the rules scorer (6 signals); the model was not reached",
      "tick 65935 (2026-10-09T17:46:38.518Z): 1 signal scored by the rules fallback instead of the model (0 by the model); invalid_request: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      "tick 65934 (2026-10-09T17:46:08.516Z): 5 signals scored by the rules fallback instead of the model (0 by the model); invalid_request: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    ]);
  });

  it("is quiet when every tick reached the model, and says so when a fallback has no failed call behind it", () => {
    expect(fallbackStatus([{ tickNumber: 1, startedAt: "2026-10-09T18:16:08.298Z", scoring: { fallbacks: 0, llmScored: 6 } }], [])).toEqual({ ticks: [], warnings: [] });
    const omitted = fallbackStatus([{ tickNumber: 2, startedAt: "2026-10-09T18:16:38.000Z", scoring: { fallbacks: 1, llmScored: 2 } }], []);
    expect(omitted.warnings).toEqual(["tick 2 (2026-10-09T18:16:38.000Z): 1 signal scored by the rules fallback instead of the model (2 by the model); no failed call recorded for the tick (the model omitted the signal, or the response did not match the schema)"]);
  });

  it("reads the reason to one line: the kind and the provider's message, or the text as recorded, trimmed", () => {
    expect(fallbackReason(CREDIT)).toBe("invalid_request: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
    expect(fallbackReason("timeout: the request took longer than 20000 ms")).toBe("timeout: the request took longer than 20000 ms");
    expect(fallbackReason("  ")).toBe("no reason recorded");
    expect(fallbackReason(null)).toBe("no reason recorded");
    expect(fallbackReason(`x: ${"y".repeat(400)}`)).toHaveLength(160);
  });
});
