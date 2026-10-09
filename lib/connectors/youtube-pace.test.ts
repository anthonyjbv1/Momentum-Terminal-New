import { describe, expect, it } from "vitest";

import { ageMatchedPace, DEFAULT_PACE_OPTIONS, viewsAtAge, type VideoViewSample } from "./youtube-pace";

/**
 * THE AGE-MATCHED PACE (YOUTUBE_PACE_AGE_MATCHED_ENABLED, 2026-10-09), on
 * the shape of MrBeast's ledger: uploads a week apart, each pulling views on
 * the same curve. The pace metric it replaces fired −1.50 on 09-18, 09-27,
 * 10-03 and 10-09 as an upload left the ten-video basket; judged at its own
 * age against the others at the same age, the same newest upload reads 0.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-09T16:15:00.000Z");

/** A video's views at an age, in hours: the one curve every MrBeast upload follows here, scaled. */
const curve = (ageHours: number, scale = 1) => Math.round(scale * 60_000_000 * (1 - Math.exp(-ageHours / 72)));

/** A ledger: an upload every seven days, sampled hourly from publication to now (or to `until`), on the curve times `scale`. */
function ledger(input: { uploads: Array<{ id: string; publishedDaysAgo: number; scale?: number; sampleEveryHours?: number }> }): VideoViewSample[] {
  const rows: VideoViewSample[] = [];
  for (const upload of input.uploads) {
    const publishedAt = new Date(NOW.getTime() - upload.publishedDaysAgo * DAY);
    const every = upload.sampleEveryHours ?? 1;
    for (let age = 0; publishedAt.getTime() + age * HOUR <= NOW.getTime(); age += every) {
      rows.push({ videoId: upload.id, publishedAt, views: curve(age, upload.scale), recordedAt: new Date(publishedAt.getTime() + age * HOUR) });
    }
  }
  return rows;
}

const MRBEAST = ledger({
  uploads: [
    { id: "newest", publishedDaysAgo: 3 },
    { id: "w1", publishedDaysAgo: 10 },
    { id: "w2", publishedDaysAgo: 17 },
    { id: "w3", publishedDaysAgo: 24 },
    { id: "w4", publishedDaysAgo: 31 },
  ],
});

describe("viewsAtAge", () => {
  it("interpolates between the two samples that bracket the age, returns the exact sample at it, and null when the ledger does not reach it", () => {
    const publishedAt = new Date("2026-10-01T00:00:00.000Z");
    const samples: VideoViewSample[] = [24, 48, 96].map((age) => ({ videoId: "v", publishedAt, views: age * 1000, recordedAt: new Date(publishedAt.getTime() + age * HOUR) }));
    expect(viewsAtAge(samples, 48)).toBe(48_000);
    expect(viewsAtAge(samples, 72)).toBe(72_000);
    expect(viewsAtAge(samples, 30)).toBe(30_000);
    expect(viewsAtAge(samples, 12)).toBeNull();
    expect(viewsAtAge(samples, 100)).toBeNull();
    expect(viewsAtAge([], 48)).toBeNull();
    // An undated sample is never a point.
    expect(viewsAtAge([{ videoId: "v", publishedAt: null, views: 1, recordedAt: NOW }], 1)).toBeNull();
  });
});

describe("ageMatchedPace", () => {
  it("reads MrBeast's newest upload at 0: three days in, exactly the channel's usual pace at three days, against four peers", () => {
    const pace = ageMatchedPace(MRBEAST, NOW);
    expect(pace).toMatchObject({ reading: 0, videoId: "newest", ageHours: 72, peers: 4, views: curve(72), typical: curve(72) });
  });

  it("reads a newest upload at half the usual pace as −1 and at twice it as +1: log2 of the ratio", () => {
    const slow = ledger({ uploads: [{ id: "newest", publishedDaysAgo: 3, scale: 0.5 }, { id: "w1", publishedDaysAgo: 10 }, { id: "w2", publishedDaysAgo: 17 }, { id: "w3", publishedDaysAgo: 24 }] });
    expect(ageMatchedPace(slow, NOW)?.reading).toBe(-1);
    const fast = ledger({ uploads: [{ id: "newest", publishedDaysAgo: 3, scale: 2 }, { id: "w1", publishedDaysAgo: 10 }, { id: "w2", publishedDaysAgo: 17 }, { id: "w3", publishedDaysAgo: 24 }] });
    expect(ageMatchedPace(fast, NOW)?.reading).toBe(1);
  });

  it("is silent while the newest upload is under six hours old, past fourteen days, or has fewer than three peers reaching its age", () => {
    expect(ageMatchedPace(ledger({ uploads: [{ id: "n", publishedDaysAgo: 0.2 }, { id: "a", publishedDaysAgo: 10 }, { id: "b", publishedDaysAgo: 17 }, { id: "c", publishedDaysAgo: 24 }] }), NOW)).toBeNull();
    expect(ageMatchedPace(ledger({ uploads: [{ id: "n", publishedDaysAgo: 15 }, { id: "a", publishedDaysAgo: 30 }, { id: "b", publishedDaysAgo: 45 }, { id: "c", publishedDaysAgo: 60 }] }), NOW)).toBeNull();
    // Two peers only.
    expect(ageMatchedPace(ledger({ uploads: [{ id: "n", publishedDaysAgo: 3 }, { id: "a", publishedDaysAgo: 10 }, { id: "b", publishedDaysAgo: 17 }] }), NOW)).toBeNull();
    // Three peers, but one's ledger stops before three days (sampled from the day the ledger started): not a peer.
    const late = ledger({ uploads: [{ id: "n", publishedDaysAgo: 3 }, { id: "a", publishedDaysAgo: 10 }, { id: "b", publishedDaysAgo: 17 }] });
    const stub = { videoId: "c", publishedAt: new Date(NOW.getTime() - 24 * DAY), views: 1, recordedAt: new Date(NOW.getTime() - 20 * DAY) };
    expect(ageMatchedPace([...late, stub], NOW)).toBeNull();
    expect(ageMatchedPace([], NOW)).toBeNull();
    expect(DEFAULT_PACE_OPTIONS).toEqual({ minAgeHours: 6, maxAgeDays: 14, minPeers: 3 });
  });

  it("is the newest upload against uploads published before it, from whatever samples bracket the age, and an undated upload is neither", () => {
    // Peers sampled every six hours still bracket the age; an undated row is ignored.
    const sparse = ledger({ uploads: [{ id: "newest", publishedDaysAgo: 3 }, { id: "w1", publishedDaysAgo: 10, sampleEveryHours: 6 }, { id: "w2", publishedDaysAgo: 17, sampleEveryHours: 6 }, { id: "w3", publishedDaysAgo: 24, sampleEveryHours: 6 }] });
    const undated: VideoViewSample = { videoId: "mystery", publishedAt: null, views: 999_999_999, recordedAt: NOW };
    expect(ageMatchedPace([...sparse, undated], NOW)).toMatchObject({ reading: 0, videoId: "newest", peers: 3 });
    // The newest upload's views are its newest sample's.
    const bumped = MRBEAST.map((s) => (s.videoId === "newest" && s.recordedAt.getTime() === NOW.getTime() ? { ...s, views: curve(72) * 4 } : s));
    expect(ageMatchedPace(bumped, NOW)?.reading).toBe(2);
  });
});
