import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";

import { metricSignal, observeMetric, outcomeReported, readMetricConfigs, type MetricObservation, type PreviousObservation, type SnapshotPoint } from "./metrics";

/**
 * PAGE AND BRIN BOTH RECEIVE ALPHABET'S NEWS SIGNAL: a replay of production's
 * own 2026-09-22 readings against the rule that ships now (Phase 29d).
 *
 * The live confirmation needs a qualifying Finnhub company-news reading, and
 * none has come since the per-person rule reached production (2026-09-25
 * 16:35 UTC). This replays one that already happened instead. Everything below
 * was read from production, read-only:
 *
 *   - GOOGL's company_news_volume_24h snapshots up to 22:45 UTC on 09-22. The
 *     two series are the same series (135 readings each to 16:45, none that
 *     differ), because the count belongs to the ticker, not to the person.
 *   - the metric's declaration on the finnhub source row, as it stands today;
 *   - the ledger: raw_metric_observations for both people from 16:00 to 22:45,
 *     and which of the emitted readings were stored as signals.
 *
 * On 09-22 the ledger has three readings `emitted` for BOTH people (16:45,
 * 19:45, 22:45) and a signal stored for Page alone each time: Brin's copy
 * carried the same dedupe key and the old per-source unique rule refused it.
 * The replay runs the shipped observeMetric and metricSignal for each person
 * and inserts the rows the way the store does, against the schema as it is
 * and as it was before 20260925162742. It writes to nothing but PGlite.
 */

const PRODUCTION_CONFIG = {
  metrics: {
    company_news_volume_24h: {
      delta: "level",
      label: "company news volume",
      scale: 0.5,
      polarity: 1,
      sd_floor: 2,
      min_samples: 24,
      publish_observed: true,
      baseline_window_hours: 336,
    },
  },
};

/** GOOGL company_news_volume_24h, [epoch ms, articles in the last 24 hours], 09-18 12:15 to 09-22 22:45 UTC. */
const SERIES: Array<[number, number]> = [
  [1789733729852, 30], [1789736430479, 30], [1789739129448, 31], [1789741829571, 36], [1789744529640, 37], [1789747229412, 37], [1789749929585, 38], [1789752629696, 39],
  [1789755330498, 39], [1789758029568, 34], [1789760733619, 33], [1789763429806, 51], [1789766129590, 50], [1789768829390, 46], [1789771529460, 45], [1789774229474, 44],
  [1789776930221, 43], [1789779629936, 41], [1789782329327, 43], [1789785030269, 42], [1789787729625, 42], [1789790430478, 41], [1789793129458, 41], [1789795829571, 41],
  [1789798529621, 43], [1789801229495, 43], [1789803929419, 41], [1789806629466, 38], [1789809329299, 37], [1789812030007, 35], [1789814729431, 37], [1789817429789, 36],
  [1789820129659, 34], [1789822829578, 33], [1789825529515, 32], [1789828229684, 39], [1789830929436, 37], [1789833634496, 33], [1789836329410, 28], [1789839029804, 25],
  [1789841729367, 23], [1789844430272, 20], [1789847129350, 16], [1789849829460, 18], [1789852529423, 17], [1789855229490, 16], [1789857929720, 15], [1789860629834, 15],
  [1789863329471, 16], [1789866029595, 15], [1789868729609, 14], [1789871429301, 14], [1789874129306, 14], [1789876829562, 12], [1789879529705, 12], [1789882229454, 11],
  [1789884929528, 12], [1789887629334, 12], [1789890329792, 11], [1789893029288, 11], [1789895729490, 9], [1789898429384, 8], [1789901129418, 9], [1789903829761, 9],
  [1789906529461, 10], [1789909230158, 10], [1789911929543, 13], [1789914629386, 16], [1789917329477, 14], [1789920029636, 13], [1789922729530, 14], [1789925429706, 14],
  [1789928130234, 16], [1789930830545, 15], [1789933529448, 14], [1789936229551, 14], [1789938929456, 14], [1789941629722, 14], [1789944329479, 16], [1789947032195, 15],
  [1789949729494, 17], [1789952429742, 17], [1789955129787, 18], [1789957829563, 19], [1789960529303, 19], [1789963229422, 19], [1789965929312, 23], [1789968629322, 23],
  [1789971329290, 23], [1789974029906, 23], [1789976729336, 23], [1789979429386, 23], [1789982129478, 21], [1789984829787, 16], [1789987529549, 15], [1789990229355, 15],
  [1789992929375, 19], [1789995630655, 20], [1789998329479, 19], [1790001029431, 36], [1790003729648, 38], [1790006429681, 38], [1790009129367, 45], [1790011829718, 45],
  [1790014529406, 54], [1790017233237, 54], [1790019929727, 55], [1790022629367, 64], [1790025329471, 62], [1790028032672, 61], [1790030729397, 69], [1790033429320, 68],
  [1790036129535, 68], [1790038829560, 72], [1790041530065, 71], [1790044229505, 71], [1790046929378, 69], [1790049629812, 69], [1790052329325, 70], [1790055029321, 69],
  [1790057729523, 68], [1790060429432, 67], [1790063129390, 67], [1790065829613, 69], [1790068529296, 68], [1790071230161, 65], [1790073929339, 62], [1790076629667, 58],
  [1790079329548, 61], [1790082029615, 54], [1790084729345, 53], [1790087431175, 85], [1790090129369, 79], [1790092829669, 78], [1790095531231, 90], [1790098229373, 88],
  [1790100929567, 87], [1790103630174, 86], [1790106329283, 84], [1790109030671, 89], [1790111729726, 86], [1790114429456, 83], [1790117129840, 87],
];

/** The 16:00:29 observation on the ledger (same for both), which the 16:45 reading is judged against. */
const LEDGER_AT_1600: PreviousObservation = { observed: 78, register: "elevated", reported: true };

/** What production recorded from 16:45 to 22:45, identical for Page and Brin. */
const LEDGER: Array<[ms: number, outcome: string, observed: number, register: string | null]> = [
  [1790095531231, "emitted", 90, "concrete"],
  [1790098229373, "same_register", 88, "concrete"],
  [1790100929567, "same_register", 87, "concrete"],
  [1790103630174, "same_register", 86, "concrete"],
  [1790106329283, "emitted", 84, "elevated"],
  [1790109030671, "same_register", 89, "elevated"],
  [1790111729726, "same_register", 86, "elevated"],
  [1790114429456, "inside_band", 83, null],
  [1790117129840, "emitted", 87, "elevated"],
];

const PEOPLE = ["larry-page", "sergey-brin"] as const;

const [CONFIG] = readMetricConfigs(PRODUCTION_CONFIG).metrics;
const points: SnapshotPoint[] = SERIES.map(([ms, value]) => ({ recordedAt: new Date(ms), value }));

/** The shipped observation code over the replayed readings, chained through its own outcomes as the runner chains them. */
function replay(): MetricObservation[] {
  const observations: MetricObservation[] = [];
  let previous: PreviousObservation = LEDGER_AT_1600;
  for (const [ms] of LEDGER) {
    const index = points.findIndex((point) => point.recordedAt.getTime() === ms);
    const observation = observeMetric({ metricKey: CONFIG.metricKey, config: CONFIG, history: points.slice(0, index), current: points[index], previousObservation: previous });
    observations.push(observation);
    previous = { observed: observation.observed, register: observation.register, reported: outcomeReported(observation.outcome) };
  }
  return observations;
}

interface Person {
  id: string;
  slug: string;
  display_name: string;
  category: string | null;
}

async function people(database: TestDatabase): Promise<{ finnhub: string; people: Person[] }> {
  const [source] = await database.rows<{ id: string }>("select id from public.data_sources where name = 'finnhub'");
  const rows = await database.rows<Person>("select id, slug, display_name, category from public.people where slug = any($1) order by slug", [[...PEOPLE]]);
  return { finnhub: source.id, people: rows };
}

/** Each emitted reading as the runner turns it into a signal, for each person on the ticker, Page first as production polled them. */
function signalRows(personRows: Person[], observations: MetricObservation[]) {
  return observations
    .filter((observation) => observation.outcome === "emitted")
    .flatMap((observation) =>
      personRows.map((person) => ({
        person,
        signal: metricSignal({ person, sourceName: "finnhub", externalIdentifier: "GOOGL", observation }),
      })),
    );
}

/** The store's insert, with the conflict target each schema had. */
async function insert(database: TestDatabase, conflict: string, finnhub: string, rows: ReturnType<typeof signalRows>): Promise<Array<{ slug: string; dedupe_key: string }>> {
  const stored: Array<{ slug: string; dedupe_key: string }> = [];
  for (const { person, signal } of rows) {
    const inserted = await database.rows<{ dedupe_key: string }>(
      `insert into public.signals (person_id, data_source_id, headline, raw_payload, occurred_at, dedupe_key, tier, processed)
       values ($1, $2, $3, $4::jsonb, $5, $6, null, false)
       on conflict ${conflict} do nothing
       returning dedupe_key`,
      [person.id, finnhub, signal.headline, JSON.stringify(signal.rawPayload), signal.occurredAt.toISOString(), signal.dedupeKey],
    );
    stored.push(...inserted.map((row) => ({ slug: person.slug, dedupe_key: row.dedupe_key })));
  }
  return stored;
}

describe("the shipped observation rule on 09-22's GOOGL readings", () => {
  it("reproduces production's ledger, reading for reading", () => {
    const observations = replay();
    expect(observations.map((observation) => [observation.recordedAt.getTime(), observation.outcome, observation.observed, observation.register])).toEqual(LEDGER);
    // The stored statistics at 16:45 were mean 34.963, sd 20.811, sigma 2.64 over 135 samples.
    const [first] = observations;
    expect(first.reading?.samples).toBe(135);
    expect(first.reading?.mean).toBeCloseTo(34.963, 3);
    expect(first.reading?.sigma).toBeCloseTo(2.64, 2);
  });
});

describe("the schema as it is now (per source AND person)", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  it("stores each emitted reading for Page AND Brin", async () => {
    const { finnhub, people: personRows } = await people(database);
    expect(personRows.map((person) => person.slug)).toEqual([...PEOPLE]);
    const rows = signalRows(personRows, replay());
    // Three emissions, one key each, shared by the two people.
    expect(new Set(rows.map((row) => row.signal.dedupeKey)).size).toBe(3);
    const stored = await insert(database, "(data_source_id, person_id, dedupe_key)", finnhub, rows);
    expect(stored).toHaveLength(6);
    for (const slug of PEOPLE) expect(stored.filter((row) => row.slug === slug)).toHaveLength(3);

    // What each of them would read, and the Engine would score.
    const signals = await database.rows<{ slug: string; headline: string; payload: Record<string, unknown> }>(
      `select p.slug, s.headline, s.raw_payload as payload from public.signals s join public.people p on p.id = s.person_id
        where s.data_source_id = $1 order by s.occurred_at, p.slug`,
      [finnhub],
    );
    expect(signals).toHaveLength(6);
    for (const signal of signals) {
      expect(signal.payload).toMatchObject({ kind: "metric", metric: "company_news_volume_24h", source: "finnhub", direction: 1 });
    }
    // Page's three are the payloads production stored for him on 09-22 (the
    // headline wording has moved on since; every surface re-renders from these).
    expect(signals.filter((signal) => signal.slug === "larry-page").map(({ payload }) => [payload.sigma, payload.observed, payload.baseline])).toEqual([
      [2.64, 90, 34.96],
      [2.14, 84, 36.44],
      [2.1, 87, 37.83],
    ]);
    // The pair for each reading differs only in whose name is on it.
    for (let index = 0; index < signals.length; index += 2) {
      expect(signals[index + 1].payload).toEqual(signals[index].payload);
    }
  });

  it("still takes one copy per person when the same poll runs twice", async () => {
    const { finnhub, people: personRows } = await people(database);
    const again = await insert(database, "(data_source_id, person_id, dedupe_key)", finnhub, signalRows(personRows, replay()));
    expect(again).toEqual([]);
  });
});

describe("the schema before 20260925162742 (per source alone)", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ before: "20260925162742" });
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  it("reproduces 09-22: Page's copy stored, Brin's refused, every time", async () => {
    const { finnhub, people: personRows } = await people(database);
    const stored = await insert(database, "(data_source_id, dedupe_key)", finnhub, signalRows(personRows, replay()));
    expect(stored.map((row) => row.slug)).toEqual(["larry-page", "larry-page", "larry-page"]);
  });
});
