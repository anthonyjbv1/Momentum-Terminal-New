/**
 * THE SESSION LEDGERS, as production stored them (live_samples, read
 * 2026-10-09). Each line is "seconds after the stream's start : viewer
 * count", in the order sampled; a count of 0 is Twitch's counter before it
 * refreshed. The replays of the scoring batch (the ramp-up) run over these.
 */

export interface SessionFixture {
  slug: string;
  streamId: string;
  startedAt: string;
  endedAt: string;
  complete: boolean;
  /** The session's peak, as the closed session recorded it. */
  viewerPeak: number;
  /** When the within-session rules fired a surge on it in production, if they did. */
  liveSurgeAt: string | null;
  /** The sample ledger: "offsetSeconds:viewers" pairs. */
  seq: string;
}

/** Kai Cenat, 2026-09-26: the first watched session; 215 samples, the first forty minutes here. One surge fired in production at 15:24:38. */
export const KAI_0926: SessionFixture = {
  slug: "kai-cenat",
  streamId: "320393470558",
  startedAt: "2026-09-26T11:16:20.000Z",
  endedAt: "2026-09-26T18:25:38.498Z",
  complete: true,
  viewerPeak: 48_370,
  liveSurgeAt: "2026-09-26T15:24:38.190Z",
  seq: "18:0 138:222 258:13319 378:13319 498:23139 618:23139 738:32278 858:32278 978:30873 1098:30873 1218:30873 1338:30500 1458:31115 1578:31115 1698:33522 1818:33522 1938:28598 2058:28598 2178:29482 2298:29482",
};

/** Kai Cenat, 2026-10-01: the record stream (peak 690,631). The surge fired in production at 03:23:38, 21 minutes in. */
export const KAI_1001_RECORD: SessionFixture = {
  slug: "kai-cenat",
  streamId: "319414213079",
  startedAt: "2026-10-01T03:02:56.000Z",
  endedAt: "2026-10-01T03:57:38.334Z",
  complete: true,
  viewerPeak: 690_631,
  liveSurgeAt: "2026-10-01T03:23:38.252Z",
  seq: "42:0 162:62192 282:62192 402:398044 522:398044 642:568391 762:568391 882:613694 1002:613694 1122:688053 1242:688053 1362:688053 1482:659007 1603:659007 1722:666190 1842:666190 1962:679321 2082:679321 2203:679321 2322:679321 2442:679321 2562:690631 2682:690631 2802:682158 2922:682158 3042:682158 3162:682158 3282:675290",
};

/** Kai Cenat, 2026-10-09: an ordinary stream after the record (peak 182,938 at minute 12). No surge fired. */
export const KAI_1009: SessionFixture = {
  slug: "kai-cenat",
  streamId: "320669987804",
  startedAt: "2026-10-09T00:00:12.000Z",
  endedAt: "2026-10-09T04:18:38.196Z",
  complete: true,
  viewerPeak: 182_938,
  liveSurgeAt: null,
  seq: "26:0 266:3125 506:109607 747:182938 986:157716 1226:154477 1466:142066 1706:123919 1947:120330 2186:126630 2426:107478 2667:121207 2906:108860 3146:106727 3386:108877 3627:100281 3866:89596 4106:84546 4346:86047 4586:86047 4826:78871 5066:80500 5306:77685 5546:77685 5786:77801 6027:76888 6266:78787 6506:77568 6746:79169 6986:78145 7226:80451 7466:79246 7706:76760 7947:75856 8186:74392 8426:73277 8666:72403 8907:72403 9146:70855 9386:69812 9626:70927 9866:70129 10106:71501 10347:70126 10586:68993 10827:66244 11066:67636 11306:66244 11546:74774 11787:74774 12026:63075 12266:65690 12506:64549 12747:63172 13046:66474 13286:63447 13526:62179 13766:61457 14006:62915 14246:62915 14487:59047 14726:57417 14966:52992 15206:51597 15446:47779",
};

/** Asmongold, 2026-10-08: joined seven and a half hours in (incomplete), his first watched session. No surge fired. */
export const ASMONGOLD_1008: SessionFixture = {
  slug: "asmongold",
  streamId: "318316079192",
  startedAt: "2026-10-08T17:33:45.000Z",
  endedAt: "2026-10-09T02:49:38.563Z",
  complete: false,
  viewerPeak: 28_901,
  liveSurgeAt: null,
  seq: "26873:28171 27113:27233 27353:28901 27593:28187 27833:28187 28073:27734 28313:27363 28553:27363 28793:26834 29033:26275 29273:26275 29514:25905 29753:25905 29993:25546 30233:25171 30473:24641 30713:24035 30953:24562 31193:25040 31433:23979 31673:23994 31914:23632 32153:23632 32393:23328 32633:22961 32873:23262 33113:22995 33354:22609",
};

export const SESSION_FIXTURES = [KAI_0926, KAI_1001_RECORD, KAI_1009, ASMONGOLD_1008];

/** The ledger as (time, viewers) pairs. */
export function fixtureSamples(fixture: SessionFixture): Array<{ sampledAt: Date; viewerCount: number }> {
  const start = new Date(fixture.startedAt).getTime();
  return fixture.seq.split(" ").map((pair) => {
    const [offset, viewers] = pair.split(":");
    return { sampledAt: new Date(start + Number(offset) * 1000), viewerCount: Number(viewers) };
  });
}
