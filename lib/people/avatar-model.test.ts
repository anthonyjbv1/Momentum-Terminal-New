import { describe, expect, it } from "vitest";

import { copyViolations } from "@/lib/copy-rules";

import {
  AVATAR_REFRESH_HOURS,
  apisportsAvatarFrom,
  COMMONS_ALLOWED_LICENSES,
  COMMONS_PORTRAITS,
  commonsAvatarFrom,
  avatarChannelFor,
  avatarCredit,
  avatarRecordJson,
  findSleeperPlayer,
  isAvatarStale,
  isAvatarUrl,
  readAvatarRecord,
  SLEEPER_PLAYERS,
  sleeperAvatarFrom,
  sleeperNameKey,
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
    // Everyone else keeps initials, whatever is mapped, unless a Commons portrait is pinned for them.
    expect(avatarChannelFor({ category: "executive", slug: "someone-new" }, [{ source: "youtube", externalIdentifier: "UC123456", config: null }])).toBeNull();
    expect(avatarChannelFor({ category: "athlete", slug: "patrick-mahomes" }, [trending])).toBeNull();
    // An athlete's own channel is not used; API-Sports is (below).
    expect(avatarChannelFor({ category: "athlete", slug: "patrick-mahomes" }, [{ source: "youtube", externalIdentifier: "UC123456", config: null }])).toBeNull();
    expect(avatarChannelFor({ category: "founder", slug: "anthony-baptiste" }, [trending])).toBeNull();
  });

  it("is the API-Sports headshot for an athlete with a player mapping (decided 2026-09-29)", () => {
    const player = { source: "apisports", externalIdentifier: "1197", config: null };
    expect(avatarChannelFor({ category: "athlete", slug: "patrick-mahomes" }, [trending, player])).toEqual({ source: "apisports", identifier: "1197", mappingSource: "apisports" });
    // A mapping that is not a player id, or a person outside the athlete category, is not a headshot.
    expect(avatarChannelFor({ category: "athlete", slug: "patrick-mahomes" }, [{ ...player, externalIdentifier: "mahomes" }])).toBeNull();
    expect(avatarChannelFor({ category: "executive", slug: "someone-new" }, [player])).toBeNull();
  });

  it("is the pinned Wikimedia Commons portrait for an executive, kept on their news mapping (decided 2026-09-29)", () => {
    const rss = { source: "rss", externalIdentifier: '"Elon Musk"', config: null };
    expect(avatarChannelFor({ category: "executive", slug: "elon-musk" }, [trending, rss])).toEqual({ source: "commons", identifier: "Elon Musk", mappingSource: "rss" });
    expect(avatarChannelFor({ category: "executive", slug: "elon-musk" }, [{ source: "publisher_rss", externalIdentifier: "musk", config: null }])).toEqual({ source: "commons", identifier: "Elon Musk", mappingSource: "publisher_rss" });
    // No news mapping to keep the record on: no portrait.
    expect(avatarChannelFor({ category: "executive", slug: "elon-musk" }, [trending])).toBeNull();
    // A creator with no pin keeps their own channel.
    expect(avatarChannelFor({ category: "creator", slug: "mrbeast" }, [rss, { source: "youtube", externalIdentifier: "UCX6OQ3DkcsbYNE6H8uQQuVA", config: null }])?.source).toBe("youtube");
    // The nine executives and Drake, and nobody else, are pinned.
    expect(Object.keys(COMMONS_PORTRAITS).sort()).toEqual(["drake", "elon-musk", "jeff-bezos", "jensen-huang", "larry-ellison", "larry-page", "mark-zuckerberg", "michael-dell", "sergey-brin", "warren-buffett"]);
  });

  it("lets a pinned portrait outrank a musician's channel (decided 2026-10-06, for Drake)", () => {
    const rss = { source: "rss", externalIdentifier: '"Drake"', config: null };
    const drakeTrending = { source: "youtube_trending", externalIdentifier: "Drake", config: { channel_ids: ["UCByOQJjav0CUDwxCk-jVNRQ"] } };
    expect(avatarChannelFor({ category: "musician", slug: "drake" }, [drakeTrending, rss])).toEqual({ source: "commons", identifier: "Drake (musician)", mappingSource: "rss" });
    // Without a news mapping to keep the record on, the channel stands.
    expect(avatarChannelFor({ category: "musician", slug: "drake" }, [drakeTrending])).toEqual({ source: "youtube", identifier: "UCByOQJjav0CUDwxCk-jVNRQ", mappingSource: "youtube_trending" });
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
    expect(AVATAR_REFRESH_HOURS).toEqual({ youtube: 720, twitch: 24, commons: 720, apisports: 720, sleeper: 720 });
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

describe("an API-Sports headshot", () => {
  it("takes the player's image on API-Sports' media host and their name; nothing off that host or without an image", () => {
    const player = { id: 1197, name: "Patrick Mahomes", image: "https://media.api-sports.io/american-football/players/1197.png" };
    const record = apisportsAvatarFrom(player, NOW);
    expect(record).toEqual({ url: player.image, source: "apisports", channel: "Patrick Mahomes", handle: "1197", refreshedAt: NOW.toISOString() });
    expect(readAvatarRecord({ avatar: avatarRecordJson(record!) })).toEqual(record);
    expect(apisportsAvatarFrom({ ...player, image: "https://example.com/1197.png" }, NOW)).toBeNull();
    expect(apisportsAvatarFrom({ id: 1197, name: "Patrick Mahomes" }, NOW)).toBeNull();
    expect(apisportsAvatarFrom(undefined, NOW)).toBeNull();
    expect(avatarCredit(record)).toEqual({ platform: "API-Sports", channel: "Patrick Mahomes", url: "https://api-sports.io/" });
    expect(copyViolations("Photo: API-Sports · Patrick Mahomes")).toEqual([]);
  });
});

describe("a Sleeper headshot (decided 2026-10-10)", () => {
  const rss = { source: "rss", externalIdentifier: '"Patrick Mahomes"', config: null };
  const player = { source: "apisports", externalIdentifier: "1197", config: null };
  const mahomes = { player_id: "4046", first_name: "Patrick", last_name: "Mahomes", full_name: "Patrick Mahomes", search_full_name: "patrickmahomes", position: "QB", fantasy_positions: ["QB"], team: "KC", active: true, status: "Active" };

  it("outranks the API-Sports headshot for a pinned athlete, kept on their news mapping; the seven NFL players and the NBA four are pinned", () => {
    expect(avatarChannelFor({ category: "athlete", slug: "patrick-mahomes" }, [player, rss])).toEqual({ source: "sleeper", identifier: "patrick-mahomes", mappingSource: "rss" });
    expect(avatarChannelFor({ category: "athlete", slug: "stephen-curry" }, [{ source: "publisher_rss", externalIdentifier: "curry", config: null }])).toEqual({ source: "sleeper", identifier: "stephen-curry", mappingSource: "publisher_rss" });
    // No news mapping to keep the record on: the API-Sports headshot as before.
    expect(avatarChannelFor({ category: "athlete", slug: "patrick-mahomes" }, [player])).toEqual({ source: "apisports", identifier: "1197", mappingSource: "apisports" });
    // An athlete who is not pinned is not read from Sleeper.
    expect(avatarChannelFor({ category: "athlete", slug: "someone-new" }, [player, rss])).toEqual({ source: "apisports", identifier: "1197", mappingSource: "apisports" });
    expect(Object.keys(SLEEPER_PLAYERS).sort()).toEqual(["bijan-robinson", "jahmyr-gibbs", "jamarr-chase", "jaxon-smith-njigba", "josh-allen", "lamar-jackson", "lebron-james", "patrick-mahomes", "shai-gilgeous-alexander", "stephen-curry", "victor-wembanyama"]);
    for (const pin of Object.values(SLEEPER_PLAYERS)) expect(["nfl", "nba"]).toContain(pin.sport);
  });

  it("finds the pinned player by Sleeper's name key and position, preferring an active player on a team over a namesake", () => {
    expect(sleeperNameKey("Ja'Marr Chase")).toBe("jamarrchase");
    expect(sleeperNameKey("Jaxon Smith-Njigba")).toBe("jaxonsmithnjigba");
    expect(sleeperNameKey("Shai Gilgeous-Alexander")).toBe("shaigilgeousalexander");
    const allenLB = { player_id: "5848", full_name: "Josh Allen", search_full_name: "joshallen", position: "LB", fantasy_positions: ["LB"], team: "JAX", active: true };
    const allenQB = { player_id: "4984", full_name: "Josh Allen", search_full_name: "joshallen", position: "QB", fantasy_positions: ["QB"], team: "BUF", active: true };
    const allenRetired = { player_id: "100", full_name: "Josh Allen", position: "QB", team: null, active: false };
    expect(findSleeperPlayer([allenLB, allenRetired, allenQB], SLEEPER_PLAYERS["josh-allen"])?.player_id).toBe("4984");
    expect(findSleeperPlayer([allenLB], SLEEPER_PLAYERS["josh-allen"])).toBeNull();
    // Without Sleeper's own key, the name is keyed the same way; Sleeper's NBA list names the spot (PG, SF, C; seen 2026-10-10), so a G or F pin matches it.
    expect(findSleeperPlayer([{ player_id: "7", first_name: "Shai", last_name: "Gilgeous-Alexander", position: "PG", fantasy_positions: ["PG"], team: "OKC" }], SLEEPER_PLAYERS["shai-gilgeous-alexander"])?.player_id).toBe("7");
    expect(findSleeperPlayer([{ player_id: "8", full_name: "LeBron James", position: "SF", fantasy_positions: ["SF", "PF"], team: "LAL" }], SLEEPER_PLAYERS["lebron-james"])?.player_id).toBe("8");
    expect(findSleeperPlayer([{ player_id: "9", full_name: "Victor Wembanyama", position: "C", team: "SAS" }], SLEEPER_PLAYERS["victor-wembanyama"])?.player_id).toBe("9");
    // A one-letter pin never widens a two-letter one: a QB pin does not match a position merely ending in B.
    expect(findSleeperPlayer([{ player_id: "10", full_name: "Josh Allen", position: "RB", team: "BUF" }], SLEEPER_PLAYERS["josh-allen"])).toBeNull();
    expect(findSleeperPlayer([mahomes], SLEEPER_PLAYERS["lamar-jackson"])).toBeNull();
  });

  it("takes the headshot on Sleeper's CDN for the sport and id, with the player's name; nothing without an id", () => {
    const record = sleeperAvatarFrom(mahomes, "nfl", NOW);
    expect(record).toEqual({ url: "https://sleepercdn.com/content/nfl/players/4046.jpg", source: "sleeper", channel: "Patrick Mahomes", handle: "4046", refreshedAt: NOW.toISOString() });
    expect(readAvatarRecord({ avatar: avatarRecordJson(record!) })).toEqual(record);
    expect(sleeperAvatarFrom({ ...mahomes, player_id: 4046 }, "nba", NOW)?.url).toBe("https://sleepercdn.com/content/nba/players/4046.jpg");
    expect(sleeperAvatarFrom({ ...mahomes, player_id: undefined }, "nfl", NOW)).toBeNull();
    expect(sleeperAvatarFrom({ ...mahomes, player_id: "../x" }, "nfl", NOW)).toBeNull();
    expect(sleeperAvatarFrom(undefined, "nfl", NOW)).toBeNull();
    expect(isAvatarUrl("https://sleepercdn.com/content/nfl/players/4046.jpg", "sleeper")).toBe(true);
    expect(isAvatarUrl("https://sleepercdn.com/content/nfl/players/4046.png", "sleeper")).toBe(false);
    expect(isAvatarUrl("https://example.com/content/nfl/players/4046.jpg", "sleeper")).toBe(false);
    expect(avatarCredit(record)).toEqual({ platform: "Sleeper", channel: "Patrick Mahomes", url: "https://sleeper.com/" });
    expect(copyViolations("Photo: Sleeper · Patrick Mahomes")).toEqual([]);
    expect(isAvatarStale({ ...record!, source: "apisports", url: "https://media.api-sports.io/american-football/players/1197.png" }, { source: "sleeper", identifier: "patrick-mahomes", mappingSource: "rss" }, Date.parse(record!.refreshedAt) + 1000)).toBe(true);
  });
});

describe("a Wikimedia Commons portrait", () => {
  const info = {
    thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Elon_Musk.jpg/512px-Elon_Musk.jpg",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Elon_Musk.jpg",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Elon_Musk.jpg",
    extmetadata: { Artist: { value: '<a href="https://www.flickr.com/people/x">Steve Jurvetson</a>' }, LicenseShortName: { value: "CC BY 2.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by/2.0" } },
  };

  it("keeps the thumbnail on Commons' host, the author as plain text, the licence and the file page; refuses a licence off the list or a file off Commons", () => {
    const record = commonsAvatarFrom("File:Elon_Musk.jpg", info, NOW);
    expect(record).toEqual({
      url: info.thumburl,
      source: "commons",
      channel: "Steve Jurvetson",
      handle: "File:Elon_Musk.jpg",
      refreshedAt: NOW.toISOString(),
      license: "CC BY 2.0",
      licenseUrl: "https://creativecommons.org/licenses/by/2.0",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Elon_Musk.jpg",
    });
    expect(readAvatarRecord({ avatar: avatarRecordJson(record!) })).toEqual(record);
    expect(commonsAvatarFrom("File:X.jpg", { ...info, extmetadata: { ...info.extmetadata, LicenseShortName: { value: "Fair use" } } }, NOW)).toBeNull();
    expect(commonsAvatarFrom("File:X.jpg", { ...info, thumburl: "https://example.com/x.jpg", url: "https://example.com/x.jpg" }, NOW)).toBeNull();
    expect(commonsAvatarFrom("File:X.jpg", undefined, NOW)).toBeNull();
    // Commons answers scaled thumbnails from thumb.wikimedia.org with tracking appended (seen 2026-09-29); the host is Commons', the query is not the picture.
    expect(commonsAvatarFrom("File:X.jpg", { ...info, thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d3/X.jpg/960px-X.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo" }, NOW)?.url).toBe("https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d3/X.jpg/960px-X.jpg");
    expect(readAvatarRecord({ avatar: { ...avatarRecordJson(record!), url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d3/X.jpg/960px-X.jpg" } })?.url).toContain("thumb.wikimedia.org");
    expect(commonsAvatarFrom("File:X.jpg", { ...info, extmetadata: { LicenseShortName: { value: "Public domain" } } }, NOW)?.channel).toBe("Unknown author");
    for (const ok of ["CC0", "CC0 1.0", "Public domain", "CC BY 2.0", "CC BY-SA 4.0", "CC BY-SA 3.0", "CC BY 4.0 International"]) expect(COMMONS_ALLOWED_LICENSES.test(ok), ok).toBe(true);
    for (const no of ["Fair use", "CC BY-NC 2.0", "CC BY-ND 4.0", "GFDL", "All rights reserved"]) expect(COMMONS_ALLOWED_LICENSES.test(no), no).toBe(false);
  });

  it("is credited with the author and licence, linked to the file page", () => {
    const record = commonsAvatarFrom("File:Elon_Musk.jpg", info, NOW);
    expect(avatarCredit(record)).toEqual({ platform: "Wikimedia Commons", channel: "Steve Jurvetson (CC BY 2.0)", url: "https://commons.wikimedia.org/wiki/File:Elon_Musk.jpg" });
    expect(copyViolations("Photo: Wikimedia Commons · Steve Jurvetson (CC BY 2.0)")).toEqual([]);
    expect(AVATAR_REFRESH_HOURS.commons).toBe(720);
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
