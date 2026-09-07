import { describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";

import { buildRegistry, connectorRegistry, getConnector, listConnectorNames } from "./registry";
import { createStubConnector } from "./stub";

/** Every name in the data_sources seed must have a connector, and vice versa. */
const SEEDED_SOURCE_NAMES = ["youtube", "twitch", "spotify", "forbes", "finnhub", "newsdata", "billboard", "apisports", "rss"];

describe("connector registry", () => {
  it("registers exactly the seeded data sources", () => {
    expect(listConnectorNames().sort()).toEqual([...SEEDED_SOURCE_NAMES].sort());
  });

  it("returns undefined for unknown sources", () => {
    expect(getConnector("myspace")).toBeUndefined();
  });

  it("rejects duplicate names", () => {
    expect(() => buildRegistry([createStubConnector("x"), createStubConnector("x")])).toThrow(/Duplicate connector/);
  });

  it("stub connectors are interface-compliant and return no signals", async () => {
    const person = makePerson();
    for (const name of SEEDED_SOURCE_NAMES.filter((n) => n !== "youtube")) {
      const connector = connectorRegistry.get(name);
      expect(connector, name).toBeDefined();
      expect(connector!.name).toBe(name);
      const signals = await connector!.fetchForPerson(person, "anything", {
        source: makeSource({ name }),
        config: {},
        snapshots: { latest: async () => null, record: () => undefined },
        now: new Date(),
        fetch: globalThis.fetch,
      });
      expect(signals).toEqual([]);
    }
  });
});
