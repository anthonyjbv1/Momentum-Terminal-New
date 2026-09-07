import { afterEach, describe, expect, it } from "vitest";

import { isEngineCronEnabled } from "@/lib/env";

describe("ENGINE_CRON_ENABLED", () => {
  afterEach(() => {
    delete process.env.ENGINE_CRON_ENABLED;
  });

  it('is on only for the exact string "true"', () => {
    for (const value of [undefined, "", "false", "1", "TRUE", "yes", "on"]) {
      if (value === undefined) delete process.env.ENGINE_CRON_ENABLED;
      else process.env.ENGINE_CRON_ENABLED = value;
      expect(isEngineCronEnabled(), `value=${value}`).toBe(false);
    }
    process.env.ENGINE_CRON_ENABLED = "true";
    expect(isEngineCronEnabled()).toBe(true);
    process.env.ENGINE_CRON_ENABLED = " true ";
    expect(isEngineCronEnabled()).toBe(true);
  });
});
