import { beforeEach, describe, expect, it, vi } from "vitest";

/** The rail's phone check (2026-10-04): the client hint first, the user agent second, an iPad never a phone. */

let sent: Record<string, string> = {};
vi.mock("next/headers", () => ({ headers: async () => ({ get: (name: string) => sent[name.toLowerCase()] ?? null }) }));

beforeEach(() => {
  sent = {};
});

describe("isPhoneRequest", () => {
  it("trusts the client hint when the browser sends one", async () => {
    const { isPhoneRequest } = await import("./phone");
    sent = { "sec-ch-ua-mobile": "?1", "user-agent": "Mozilla/5.0 (Windows NT 10.0)" };
    expect(await isPhoneRequest()).toBe(true);
    sent = { "sec-ch-ua-mobile": "?0", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1" };
    expect(await isPhoneRequest()).toBe(false);
  });

  it("reads the user agent otherwise: iPhone and Android phones yes, iPad and desktops no", async () => {
    const { isPhoneRequest } = await import("./phone");
    const cases: Array<[string, boolean]> = [
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", true],
      ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36", true],
      ["Mozilla/5.0 (Linux; Android 14; SM-X900) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36", false],
      ["Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1", false],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", false],
      ["", false],
    ];
    for (const [agent, expected] of cases) {
      sent = { "user-agent": agent };
      expect(await isPhoneRequest(), agent).toBe(expected);
    }
  });
});
