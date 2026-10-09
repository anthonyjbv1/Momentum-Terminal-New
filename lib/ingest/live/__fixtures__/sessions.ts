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

/** Kai Cenat, 2026-09-26: the first watched session, all 215 samples. In production, five moments fired (four surges and a burst, the Phase 16 rules): at 20, 72, 106 and 248 minutes. */
export const KAI_0926: SessionFixture = {
  slug: "kai-cenat",
  streamId: "320393470558",
  startedAt: "2026-09-26T11:16:20.000Z",
  endedAt: "2026-09-26T18:25:38.498Z",
  complete: true,
  viewerPeak: 48_370,
  liveSurgeAt: "2026-09-26T15:24:38.190Z",
  seq: "18:0 138:222 258:13319 378:13319 498:23139 618:23139 738:32278 858:32278 978:30873 1098:30873 1218:30873 1338:30500 1458:31115 1578:31115 1698:33522 1818:33522 1938:28598 2058:28598 2178:29482 2298:29482 2418:30829 2538:30829 2659:30829 2778:31570 2898:31570 3019:33895 3138:33895 3258:31549 3378:31549 3498:31549 3618:32381 3739:32381 3858:32381 3979:32381 4098:32806 4218:32806 4338:39640 4458:39640 4578:34339 4698:34339 4818:34825 4938:34825 5058:35657 5178:35657 5298:37383 5418:37383 5538:37865 5658:37865 5778:36173 5898:36173 6019:37176 6138:37176 6258:37176 6378:43930 6499:37816 6618:37816 6739:38782 6858:38782 6978:38782 7098:38782 7218:38782 7338:38131 7458:38131 7578:37111 7698:40333 7818:40333 7939:34792 8059:34792 8178:36405 8298:37141 8418:37141 8538:37141 8659:37627 8778:38642 8898:38642 9018:43970 9138:43970 9258:38395 9379:38395 9498:40599 9618:40599 9738:40599 9858:40599 9978:40599 10098:40599 10218:40174 10339:39281 10458:39281 10578:39281 10699:38463 10819:40029 10938:40029 11059:43988 11178:43988 11298:38082 11418:38082 11538:37516 11658:37516 11778:38284 11898:38284 12018:38724 12138:38724 12259:42399 12378:42399 12498:42399 12618:39891 12738:39891 12858:39891 12978:39468 13099:39468 13218:37913 13338:37913 13458:37421 13578:41626 13698:41626 13818:42310 13938:42310 14058:39956 14178:39956 14298:40535 14418:40535 14538:40535 14658:40535 14778:41142 14898:48370 15018:48370 15138:47132 15258:45707 15378:45707 15498:46415 15618:46415 15738:46415 15859:47814 15978:47814 16098:47150 16218:47150 16338:47150 16458:47150 16579:48256 16698:48256 16818:47718 16938:47718 17058:43893 17178:43893 17298:43893 17418:44494 17538:44494 17658:43463 17778:43463 17898:43463 18019:40803 18138:40803 18258:43081 18378:43081 18498:43680 18619:43197 18738:43197 18858:43958 18978:43958 19098:43483 19218:43483 19338:43483 19458:45413 19578:44820 19698:44820 19818:44820 19939:44820 20058:44820 20178:44820 20298:44820 20418:45488 20539:45488 20658:43425 20778:43425 20898:37379 21018:37379 21138:37379 21258:41298 21378:41298 21499:36621 21618:36621 21738:35020 21858:34116 21978:34116 22098:34116 22219:33395 22338:33395 22458:32925 22578:32925 22698:33442 22818:33442 22938:32797 23058:32797 23178:32797 23298:32797 23418:33461 23538:33461 23658:33461 23778:33904 23898:33904 24018:32233 24139:35220 24258:35220 24378:35220 24498:33422 24618:33422 24739:32419 24858:32419 24978:31622 25098:31264 25218:31264 25338:31264 25458:30767 25578:30767 25698:32502",
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

/** Asmongold, 2026-10-09: the session open when the tune was written (first two hours). One quality surge fired in production at 18:43:38, 68 minutes in: 27,988 to 32,282 (+15.3%), confidence 0.971. */
export const ASMONGOLD_1009: SessionFixture = {
  slug: "asmongold",
  streamId: "317624977271",
  startedAt: "2026-10-09T17:35:19.000Z",
  endedAt: "2026-10-09T19:35:19.000Z",
  complete: true,
  viewerPeak: 37_011,
  liveSurgeAt: "2026-10-09T18:43:38.665Z",
  seq: "19:0 259:7123 499:10611 739:13874 979:16889 1220:19085 1459:20403 1699:22348 1939:24114 2179:25982 2419:26764 2659:27236 2899:28364 3139:28364 3379:31211 3619:32630 3859:33005 4100:33520 4340:33960 4579:34539 4819:34191 5059:34191 5299:34707 5540:35620 5780:36127 6019:36606 6260:36606 6499:37011 6739:37011 6979:37011 7220:37011",
};

export const SESSION_FIXTURES = [KAI_0926, KAI_1001_RECORD, KAI_1009, ASMONGOLD_1008];

/**
 * THE STORED LIVE MOMENTS (2026-10-09, read-only query over signals): every
 * firing for the streamers since each was added, as production scored them.
 * impact is score_events' impact at the tick; the within-session rules had
 * no cap in points and a per-kind cooldown only.
 */
export interface StoredMoment {
  slug: string;
  streamId: string;
  at: string;
  minutesIn: number;
  moment: "audience_surge" | "clip_burst";
  from: number;
  to: number;
  magnitude: number;
  confidence: number;
  impact: number;
  rule: "phase16" | "quality";
}

export const STORED_MOMENTS: StoredMoment[] = [
  { slug: "kai-cenat", streamId: "320393470558", at: "2026-09-26T11:36:38.172Z", minutesIn: 20, moment: "audience_surge", from: 23_139, to: 30_873, magnitude: 0.334, confidence: 0.668, impact: 1.0018, rule: "phase16" },
  { slug: "kai-cenat", streamId: "320393470558", at: "2026-09-26T11:36:38.172Z", minutesIn: 20, moment: "clip_burst", from: 14.5, to: 72, magnitude: 4.982, confidence: 0.796, impact: 1.1937, rule: "phase16" },
  { slug: "kai-cenat", streamId: "320393470558", at: "2026-09-26T12:28:38.296Z", minutesIn: 72, moment: "audience_surge", from: 32_381, to: 39_640, magnitude: 0.224, confidence: 0.448, impact: 0.6718, rule: "phase16" },
  { slug: "kai-cenat", streamId: "320393470558", at: "2026-09-26T13:02:38.375Z", minutesIn: 106, moment: "audience_surge", from: 36_173, to: 43_930, magnitude: 0.214, confidence: 0.429, impact: 0.6433, rule: "phase16" },
  { slug: "kai-cenat", streamId: "320393470558", at: "2026-09-26T15:24:38.190Z", minutesIn: 248, moment: "audience_surge", from: 39_956, to: 48_370, magnitude: 0.211, confidence: 0.421, impact: 0.6313, rule: "phase16" },
  { slug: "kai-cenat", streamId: "319414213079", at: "2026-10-01T03:23:38.252Z", minutesIn: 21, moment: "clip_burst", from: 6, to: 36, magnitude: 6, confidence: 1, impact: 1.4996, rule: "phase16" },
  { slug: "kai-cenat", streamId: "319414213079", at: "2026-10-01T03:23:38.252Z", minutesIn: 21, moment: "audience_surge", from: 398_044, to: 688_053, magnitude: 0.729, confidence: 1, impact: 1.4996, rule: "phase16" },
  { slug: "asmongold", streamId: "317624977271", at: "2026-10-09T18:43:38.665Z", minutesIn: 68, moment: "audience_surge", from: 27_988, to: 32_282, magnitude: 0.153, confidence: 0.971, impact: 1.4562, rule: "quality" },
];

/** The ledger as (time, viewers) pairs. */
export function fixtureSamples(fixture: SessionFixture): Array<{ sampledAt: Date; viewerCount: number }> {
  const start = new Date(fixture.startedAt).getTime();
  return fixture.seq.split(" ").map((pair) => {
    const [offset, viewers] = pair.split(":");
    return { sampledAt: new Date(start + Number(offset) * 1000), viewerCount: Number(viewers) };
  });
}
