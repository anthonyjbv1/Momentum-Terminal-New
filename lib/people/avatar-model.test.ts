import { describe, expect, it } from "vitest";

import { copyViolations } from "@/lib/copy-rules";

import {
  AVATAR_REFRESH_HOURS,
  avatarChannelFor,
  avatarCredit,
  avatarRecordJson,
  isAvatarStale,
  isAvatarUrl,
  readAvatarRecord,
  twitchAvatarFrom,
  youtubeAvatarFrom,
  type AvatarRecord,
} from "./avatar-model";

const NOW = new Date("2026-09-29T12:00:00Z");

describe("which channel a person's avatar comes from", () => {
  const trending = { source: "youtube_trending", externalIdentifier: "MrBeast", config: { channel_ids: ["UCX6OQ3DkcsbYNE6H8uQQuVA"] } };

  it("is the YouTube channel mapping, else the Twitch login, else the first pinned Trending channel; creators and musicians only", () => {
    expect(avatarChannelFor({ category: "creator" }, [trending, { source: "youtube", externalIdentifier: "UCX6OQ3DkcsbYNE6H8uQQuVA", config: null }])).toEqual({ source: "youtube", identifier: "UCX6OQ3DkcsbYNE6H8uQQuVA", mappingSource: "youtube" });
    expect(avatarChannelFor({ category: "creator" }, [{ source: "twitch", externalIdentifier: "kaicenat", config: null }, { source: "youtube_trending", externalIdentifier: "Kai Cenat", config: { channel_ids: ["UCoEmptob-eEGKk18c2VplJg"] } }])).toEqual({ source: "twitch", identifier: "kaicenat", mappingSource: "twitch" });
    expect(avatarChannelFor({ category: "musician" }, [{ source: "youtube_trending", externalIdentifier: "Drake", config: { channel_ids: ["UCByOQJjav0CUDwxCk-jVNRQ", "UCQznUf1SjfDqx65hX3zRDiA"] } }])).toEqual({ source: "youtube", identifier: "UCByOQJjav0CUDwxCk-jVNRQ", mappingSource: "youtube_trending" });
    // A name-matched Trending mapping with no pinned channel is not a channel of their own.
    expect(avatarChannelFor({ category: "creator" }, [{ source: "youtube_trending", externalIdentifier: "Someone", config: { channel_ids: [] } }])).toBeNull();
    // Everyone else keeps initials, whatever is mapped.
    expect(avatarChannelFor({ category: "executive" }, [{ source: "youtube", externalIdentifier: "UC123456", config: null }])).toBeNull();
    expect(avatarChannelFor({ category: "athlete" }, [trending])).toBeNull();
    expect(avatarChannelFor({ category: "founder" }, [trending])).toBeNull();
  });
});

describe("the record", () => {
  const record: AvatarRecord = { url: "https://yt3.ggpht.com/abc=s800-c-k-c0x00ffffff-no-rj", source: "youtube", channel: "MrBeast", handle: "@MrBeast", refreshedAt: "2026-09-29T00:00:00.000Z" };

  it("round-trips through the mapping's config and refuses anything malformed or off the platforms' hosts", () => {
    expect(readAvatarRecord({ avatar: avatarRecordJson(record) })).toEqual(record);
    expect(readAvatarRecord({ avatar: { ...avatarRecordJson(record), url: "https://example.com/a.jpg" } })).toBeNull();
    expect(readAvatarRecord({ avatar: { ...avatarRecordJson(record), refreshed_at: "yesterday" } })).toBeNull();
    expect(readAvatarRecord({ avatar: "x" })).toBeNull();
    expect(readAvatarRecord(null)).toBeNull();
    expect(isAvatarUrl("https://static-cdn.jtvnw.net/jtv_user_pictures/x-profile_image-300x300.png", "twitch")).toBe(true);
    expect(isAvatarUrl("https://static-cdn.jtvnw.net/x.png", "youtube")).toBe(false);
  });

  it("is stale past its platform's window, when absent, and when the channel has changed platform", () => {
    const youtube = { source: "youtube" as const, identifier: "UC1", mappingSource: "youtube" };
    const fresh = Date.parse(record.refreshedAt) + 1000;
    expect(isAvatarStale(record, youtube, fresh)).toBe(false);
    expect(isAvatarStale(record, youtube, Date.parse(record.refreshedAt) + AVATAR_REFRESH_HOURS.youtube * 3_600_000 + 1)).toBe(true);
    expect(isAvatarStale(null, youtube, fresh)).toBe(true);
    expect(isAvatarStale(record, { source: "twitch", identifier: "x", mappingSource: "twitch" }, fresh)).toBe(true);
    expect(AVATAR_REFRESH_HOURS).toEqual({ youtube: 720, twitch: 24 });
  });
});

describe("what the platforms answer", () => {
  it("takes YouTube's largest thumbnail, the title and the handle; nothing without a thumbnail", () => {
    const item = { id: "UCX6OQ3DkcsbYNE6H8uQQuVA", snippet: { title: "MrBeast", customUrl: "@mrbeast", thumbnails: { default: { url: "https://yt3.ggpht.com/a=s88" }, high: { url: "https://yt3.ggpht.com/a=s800" } } } };
    expect(youtubeAvatarFrom(item, NOW)).toEqual({ url: "https://yt3.ggpht.com/a=s800", source: "youtube", channel: "MrBeast", handle: "@mrbeast", refreshedAt: NOW.toISOString() });
    expect(youtubeAvatarFrom({ id: "x", snippet: { title: "No picture" } }, NOW)).toBeNull();
    expect(youtubeAvatarFrom(undefined, NOW)).toBeNull();
  });

  it("takes a Twitch user's profile image, display name and login", () => {
    const user = { login: "kaicenat", display_name: "KaiCenat", profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/x-profile_image-300x300.png" };
    expect(twitchAvatarFrom(user, NOW)).toEqual({ url: user.profile_image_url, source: "twitch", channel: "KaiCenat", handle: "kaicenat", refreshedAt: NOW.toISOString() });
    expect(twitchAvatarFrom({ login: "x" }, NOW)).toBeNull();
  });
});

describe("the credit", () => {
  it("names the platform and the channel, linked to the channel, in the house voice", () => {
    expect(avatarCredit({ url: "https://yt3.ggpht.com/a", source: "youtube", channel: "MrBeast", handle: "@MrBeast", refreshedAt: NOW.toISOString() })).toEqual({ platform: "YouTube", channel: "MrBeast", url: "https://www.youtube.com/%40MrBeast" });
    expect(avatarCredit({ url: "https://static-cdn.jtvnw.net/a.png", source: "twitch", channel: "KaiCenat", handle: "kaicenat", refreshedAt: NOW.toISOString() })).toEqual({ platform: "Twitch", channel: "KaiCenat", url: "https://www.twitch.tv/kaicenat" });
    expect(avatarCredit(null)).toBeNull();
    expect(copyViolations("Photo: YouTube · MrBeast")).toEqual([]);
  });
});
