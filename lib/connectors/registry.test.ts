import { describe, expect, it } from "vitest";

import { makePerson, makeSource } from "@/lib/__tests__/fixtures";

import { buildRegistry, connectorRegistry, getConnector, listConnectorNames } from "./registry";
import { createStubConnector } from "./stub";

/** Every name in the data_sources seed must have a connector, and vice versa. */
const SEEDED_SOURCE_NAMES = ["youtube", "youtube_comments", "twitch", "spotify", "forbes", "finnhub", "newsdata", "billboard", "apisports", "rss", "publisher_rss"];
/** Implemented connectors; the rest are interface-compliant stubs. */
const IMPLEMENTED = ["youtube", "youtube_comments", "spotify", "rss", "twitch", "apisports", "publisher_rss"];
/** Connectors that need a credential and say so. */
const CREDENTIALED = ["youtube", "youtube_comments", "spotify", "twitch", "apisports"];

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
    for (const name of SEEDED_SOURCE_NAMES.filter((n) => !IMPLEMENTED.includes(n))) {
      const connector = connectorRegistry.get(name);
      expect(connector, name).toBeDefined();
      expect(connector!.name).toBe(name);
      expect(connector!.fetchMetrics, name).toBeUndefined();
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

  it("credentialed connectors report themselves unavailable without their credentials", () => {
    const saved = {
      youtube: process.env.YOUTUBE_API_KEY,
      id: process.env.SPOTIFY_CLIENT_ID,
      secret: process.env.SPOTIFY_CLIENT_SECRET,
      twitchId: process.env.TWITCH_CLIENT_ID,
      twitchSecret: process.env.TWITCH_CLIENT_SECRET,
      apisports: process.env.APISPORTS_API_KEY,
    };
    for (const name of ["YOUTUBE_API_KEY", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "APISPORTS_API_KEY"]) {
      delete process.env[name];
    }
    try {
      for (const name of CREDENTIALED) {
        const availability = connectorRegistry.get(name)!.available!();
        expect(availability.ok, name).toBe(false);
        expect(availability.ok ? "" : availability.reason).toMatch(/not set/);
      }
      expect(connectorRegistry.get("rss")!.available).toBeUndefined();
      expect(connectorRegistry.get("publisher_rss")!.available).toBeUndefined();
      // The two news connectors are one story family; nothing else is.
      expect(connectorRegistry.get("rss")!.storyFamily).toBe("news");
      expect(connectorRegistry.get("publisher_rss")!.storyFamily).toBe("news");
      expect(connectorRegistry.get("apisports")!.storyFamily).toBeUndefined();
    } finally {
      if (saved.youtube !== undefined) process.env.YOUTUBE_API_KEY = saved.youtube;
      if (saved.id !== undefined) process.env.SPOTIFY_CLIENT_ID = saved.id;
      if (saved.secret !== undefined) process.env.SPOTIFY_CLIENT_SECRET = saved.secret;
      if (saved.twitchId !== undefined) process.env.TWITCH_CLIENT_ID = saved.twitchId;
      if (saved.twitchSecret !== undefined) process.env.TWITCH_CLIENT_SECRET = saved.twitchSecret;
      if (saved.apisports !== undefined) process.env.APISPORTS_API_KEY = saved.apisports;
    }
  });
});
