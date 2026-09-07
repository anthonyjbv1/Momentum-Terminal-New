import { beforeEach, describe, expect, it } from "vitest";

import { fakeFetch, makePerson, makeSource, youtubeChannelsResponse } from "@/lib/__tests__/fixtures";

import { ConnectorError, type SnapshotStore, type SnapshotValue } from "./types";
import { detectYouTubeSignals, milestoneStep, readYouTubeConfig, youtubeConnector } from "./youtube";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const EARLIER = new Date("2026-09-07T11:00:00.000Z");

function memorySnapshots(initial: Record<string, number> = {}) {
  const stored = new Map<string, SnapshotValue>(
    Object.entries(initial).map(([key, value]) => [key, { metricKey: key, value, recordedAt: EARLIER }]),
  );
  const recorded: Array<{ metricKey: string; value: number }> = [];
  const store: SnapshotStore = {
    async latest(metricKey) {
      return stored.get(metricKey) ?? null;
    },
    record(metricKey, value) {
      recorded.push({ metricKey, value });
    },
  };
  return { store, recorded };
}

function previousOf(values: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { metricKey: key, value, recordedAt: EARLIER }]),
  );
}

const person = makePerson();
const config = readYouTubeConfig({});

describe("milestoneStep", () => {
  it("uses one hundredth of the order of magnitude, floored at minStep", () => {
    expect(milestoneStep(516_000_000, 1_000)).toBe(1_000_000);
    expect(milestoneStep(45_000_000, 1_000)).toBe(100_000);
    expect(milestoneStep(2_310_000_000, 100_000)).toBe(10_000_000);
    expect(milestoneStep(12_345, 1_000)).toBe(1_000);
    expect(milestoneStep(0, 1_000)).toBe(1_000);
  });
});

describe("detectYouTubeSignals", () => {
  const channel = {
    channelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
    title: "MrBeast",
    subscriberCount: 516_200_000,
    viewCount: 90_000_000_000,
    videoCount: 901,
    hiddenSubscriberCount: false,
    raw: {},
  };

  it("emits one baseline signal on first contact", () => {
    const signals = detectYouTubeSignals({ person, channel, previous: {}, now: NOW, config });
    expect(signals).toHaveLength(1);
    expect(signals[0].headline).toBe("MrBeast stands at 516.2M subscribers, 90B total views and 901 videos on YouTube");
    expect(signals[0].dedupeKey).toBe("youtube:UCX6OQ3DkcsbYNE6H8uQQuVA:baseline");
    expect(signals[0].rawPayload.kind).toBe("baseline");
    expect(signals[0].occurredAt).toBe(NOW);
  });

  it("emits a milestone signal when a subscriber boundary is crossed", () => {
    const signals = detectYouTubeSignals({
      person,
      channel,
      previous: previousOf({ subscriber_count: 515_900_000, view_count: 90_000_000_000, video_count: 901 }),
      now: NOW,
      config,
    });
    expect(signals.map((s) => s.headline)).toEqual(["MrBeast crosses 516M subscribers on YouTube"]);
    expect(signals[0].dedupeKey).toBe("youtube:UCX6OQ3DkcsbYNE6H8uQQuVA:subscriber_count:milestone:516000000");
    expect(signals[0].rawPayload).toMatchObject({ kind: "milestone", previous: 515_900_000, current: 516_200_000 });
  });

  it("emits a relative-change signal when no milestone is crossed but the move is large", () => {
    const signals = detectYouTubeSignals({
      person,
      channel: { ...channel, subscriberCount: 516_950_000 },
      previous: previousOf({ subscriber_count: 516_100_000, view_count: 90_000_000_000, video_count: 901 }),
      now: NOW,
      config,
    });
    // +850K on 516.1M is +0.16%: below the 0.5% default threshold -> no signal.
    expect(signals).toHaveLength(0);

    const bigMove = detectYouTubeSignals({
      person,
      channel: { ...channel, subscriberCount: 516_950_000 },
      previous: previousOf({ subscriber_count: 516_100_000, view_count: 90_000_000_000, video_count: 901 }),
      now: NOW,
      config: { ...config, subscriber_min_relative_change: 0.001 },
    });
    expect(bigMove.map((s) => s.headline)).toEqual(["MrBeast gains 850K YouTube subscribers (+0.16%) since last check"]);
  });

  it("reports drops below a milestone", () => {
    const signals = detectYouTubeSignals({
      person,
      channel: { ...channel, subscriberCount: 515_900_000 },
      previous: previousOf({ subscriber_count: 516_100_000, view_count: 90_000_000_000, video_count: 901 }),
      now: NOW,
      config,
    });
    expect(signals.map((s) => s.headline)).toEqual(["MrBeast drops below 516M subscribers on YouTube"]);
  });

  it("reports new uploads and view milestones", () => {
    const signals = detectYouTubeSignals({
      person,
      channel: { ...channel, viewCount: 90_010_000_000, videoCount: 903 },
      previous: previousOf({ subscriber_count: 516_200_000, view_count: 89_995_000_000, video_count: 901 }),
      now: NOW,
      config,
    });
    expect(signals.map((s) => s.headline)).toEqual([
      "MrBeast's YouTube channel passes 90B total views",
      "MrBeast uploads 2 new videos on YouTube (903 total)",
    ]);
  });

  it("ignores metrics without a previous snapshot once contact is established", () => {
    const signals = detectYouTubeSignals({
      person,
      channel,
      previous: previousOf({ video_count: 901 }),
      now: NOW,
      config,
    });
    expect(signals).toHaveLength(0);
  });
});

describe("youtubeConnector", () => {
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = "test-key";
  });

  it("fetches channel statistics with the server-side key and records snapshots", async () => {
    const fetch = fakeFetch(youtubeChannelsResponse({}));
    const { store, recorded } = memorySnapshots();

    const signals = await youtubeConnector.fetchForPerson(person, "UCX6OQ3DkcsbYNE6H8uQQuVA", {
      source: makeSource(),
      config: {},
      snapshots: store,
      now: NOW,
      fetch,
    });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toContain("https://www.googleapis.com/youtube/v3/channels?");
    expect(fetch.calls[0]).toContain("id=UCX6OQ3DkcsbYNE6H8uQQuVA");
    expect(fetch.calls[0]).toContain("key=test-key");
    expect(recorded).toEqual([
      { metricKey: "subscriber_count", value: 516_000_000 },
      { metricKey: "view_count", value: 90_000_000_000 },
      { metricKey: "video_count", value: 900 },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].rawPayload.kind).toBe("baseline");
  });

  it("diffs against stored snapshots on later runs", async () => {
    const fetch = fakeFetch(youtubeChannelsResponse({ subscriberCount: "517000000" }));
    const { store } = memorySnapshots({ subscriber_count: 516_900_000, view_count: 90_000_000_000, video_count: 900 });

    const signals = await youtubeConnector.fetchForPerson(person, "UCX6OQ3DkcsbYNE6H8uQQuVA", {
      source: makeSource(),
      config: {},
      snapshots: store,
      now: NOW,
      fetch,
    });

    expect(signals.map((s) => s.headline)).toEqual(["MrBeast crosses 517M subscribers on YouTube"]);
  });

  it("skips the subscriber metric when the channel hides it", async () => {
    const fetch = fakeFetch(youtubeChannelsResponse({ hiddenSubscriberCount: true }));
    const { store, recorded } = memorySnapshots();

    await youtubeConnector.fetchForPerson(person, "UCX6OQ3DkcsbYNE6H8uQQuVA", {
      source: makeSource(),
      config: {},
      snapshots: store,
      now: NOW,
      fetch,
    });

    expect(recorded.map((r) => r.metricKey)).toEqual(["view_count", "video_count"]);
  });

  it("throws a ConnectorError on API failures without leaking the key", async () => {
    const fetch = fakeFetch({ error: { code: 403, message: "quotaExceeded" } }, { status: 403 });
    const { store } = memorySnapshots();

    await expect(
      youtubeConnector.fetchForPerson(person, "UCX6OQ3DkcsbYNE6H8uQQuVA", {
        source: makeSource(),
        config: {},
        snapshots: store,
        now: NOW,
        fetch,
      }),
    ).rejects.toMatchObject({ name: "ConnectorError", status: 403, message: expect.not.stringContaining("test-key") });
  });

  it("throws when the channel does not exist", async () => {
    const fetch = fakeFetch({ items: [] });
    const { store } = memorySnapshots();

    await expect(
      youtubeConnector.fetchForPerson(person, "UCdoesnotexist", {
        source: makeSource(),
        config: {},
        snapshots: store,
        now: NOW,
        fetch,
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });
});
