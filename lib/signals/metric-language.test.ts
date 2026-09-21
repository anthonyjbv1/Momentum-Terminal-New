import { describe, expect, it } from "vitest";

import {
  METRIC_VOICE,
  REGISTER_BANDS,
  comparisonPhrase,
  countWords,
  fallbackVoice,
  metricDetail,
  metricSentence,
  registerFor,
  spanWords,
  variantIndex,
  type MetricSentenceInput,
  type MetricVoice,
} from "./metric-language";

/**
 * The consumer app's half of the metric pipeline: what a reading SAYS.
 *
 * The invariants that matter are reproducibility (the same reading always
 * produces the same words), the absence of σ, and the comparison staying to
 * the person themselves. Everything else is taste, and taste is checked by
 * reading the table.
 */

const BASE: MetricSentenceInput = {
  name: "Drake",
  metric: "news_volume_24h",
  label: "news volume",
  sigma: 2.8,
  windowHours: 336,
  observed: 12,
  baseline: 4,
  day: "2026-09-19",
};

/** Every band of every voice, against a reading that can fill any placeholder. */
function everySentence(): string[] {
  const out: string[] = [];
  const sigmas = [-9, -4, -3, -2.6, -2.1, -1.2, 1.2, 2.0, 2.2, 2.49, 2.5, 3.0, 3.49, 3.5, 4.0, 12];
  for (const [metric, voice] of Object.entries(METRIC_VOICE)) {
    for (const sigma of sigmas) {
      for (const name of ["Drake", "Jensen Huang", "Patrick Mahomes"]) {
        for (const day of ["2026-09-19", "2026-09-20", "2026-09-21", "2027-01-02"]) {
          for (const [observed, baseline] of [[12, 4], [6, 4.6], [3, 19], [0, 4], [7, 0]] as const) {
            out.push(metricSentence({ ...BASE, metric, label: metric.replace(/_/g, " "), name, sigma, day, observed, baseline }));
          }
        }
      }
      void voice;
    }
  }
  return out;
}

describe("the register bands", () => {
  it("are a function of the reading alone, at the documented boundaries", () => {
    expect(REGISTER_BANDS).toEqual({ spiking: 3.5, concrete: 2.5 });
    expect(registerFor(3.5)).toBe("spiking");
    expect(registerFor(3.49)).toBe("concrete");
    expect(registerFor(2.5)).toBe("concrete");
    expect(registerFor(2.49)).toBe("elevated");
    expect(registerFor(0.1)).toBe("elevated");
    // Sign decides first: a reading below the person's own pace is terminal at
    // every magnitude, because a concrete low count reads as an accusation.
    expect(registerFor(-0.1)).toBe("quiet");
    expect(registerFor(-9)).toBe("quiet");
  });

  it("band on the sign of the READING, not on what it does to the score", () => {
    // Every metric declares polarity +1 today so the two coincide, and they
    // must not be conflated: a low reading is described as low whichever way
    // its polarity pushes the score.
    expect(registerFor(-3)).toBe("quiet");
    expect(metricSentence({ ...BASE, sigma: -3 })).toMatch(/quiet|cooled/i);
  });
});

describe("determinism", () => {
  it("the same reading, person and day always produces the same words", () => {
    const once = metricSentence(BASE);
    for (let i = 0; i < 50; i += 1) expect(metricSentence(BASE)).toBe(once);
  });

  it("the variant is a hash of person and day, so a refresh cannot change the sentence", () => {
    // Stable within a day, free to differ across days and across people.
    expect(variantIndex("Drake", "2026-09-19", "news_volume_24h", 3)).toBe(variantIndex("Drake", "2026-09-19", "news_volume_24h", 3));
    const acrossDays = new Set(["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"].map((day) => metricSentence({ ...BASE, day })));
    const acrossPeople = new Set(["Drake", "MrBeast", "Kai Cenat", "Adin Ross"].map((name) => metricSentence({ ...BASE, name })));
    expect(acrossDays.size).toBeGreaterThan(1);
    expect(acrossPeople.size).toBeGreaterThan(1);
    // One variant means one sentence, whoever asks.
    expect(variantIndex("Drake", "2026-09-19", "m", 1)).toBe(0);
  });
});

describe("σ never reaches a reader", () => {
  it("appears in no sentence, in any band, for any metric", () => {
    const sentences = everySentence();
    expect(sentences.length).toBeGreaterThan(1000);
    for (const sentence of sentences) {
      expect(sentence, sentence).not.toMatch(/σ|sigma|standard deviation/i);
      // Nor the vocabulary σ was hiding behind.
      expect(sentence, sentence).not.toMatch(/baseline|trailing/i);
    }
  });

  it("is absent from the expand, which explains itself in counts instead", () => {
    const lines = metricDetail({ ...BASE, samples: 312 });
    const text = lines.map((line) => `${line.label}: ${line.value}`).join(" | ");
    expect(text).not.toMatch(/σ|sigma|standard deviation/i);
    // A reader can reconstruct why it fired: what was seen, what is usual,
    // how they compare, over what span, from how many readings.
    expect(text).toContain("12 stories");
    expect(text).toContain("4 stories");
    expect(text).toContain("3x their usual pace");
    expect(text).toContain("Drake's own fortnight");
    expect(text).toContain("312");
  });
});

describe("multiples above 2x, percentages below", () => {
  it("uses a multiple at 2x and over, rounded to the nearest half", () => {
    expect(comparisonPhrase(12, 4)?.standalone).toBe("3x their usual pace");
    expect(comparisonPhrase(8, 4)?.standalone).toBe("2x their usual pace");
    expect(comparisonPhrase(9, 4)?.standalone).toBe("2.5x their usual pace");
    expect(comparisonPhrase(40, 4)?.standalone).toBe("10x their usual pace");
    // The running form takes "at", so it survives any progressive verb.
    expect(comparisonPhrase(12, 4)?.running).toBe("at 3x their usual pace");
  });

  it("uses a percentage below 2x, because '1.3x their baseline' reads worse", () => {
    expect(comparisonPhrase(13, 10)?.standalone).toBe("up 30% on their usual pace");
    expect(comparisonPhrase(13, 10)?.running).toBe("30% above their usual pace");
    expect(comparisonPhrase(19, 10)?.standalone).toBe("up 90% on their usual pace");
  });

  it("NEVER gives a reading below pace a decimal multiple", () => {
    for (const [observed, baseline] of [[3, 10], [1, 10], [7, 21], [5, 20], [4, 19], [9, 10]] as const) {
      const phrase = comparisonPhrase(observed, baseline);
      expect(phrase, `${observed}/${baseline}`).not.toBeNull();
      expect(phrase!.standalone, `${observed}/${baseline}`).not.toMatch(/\d(\.\d+)?x/);
      expect(phrase!.running, `${observed}/${baseline}`).not.toMatch(/\d(\.\d+)?x/);
    }
    // A fraction of pace where one lands near it, a percentage otherwise.
    expect(comparisonPhrase(7, 21)?.standalone).toBe("a third of their usual pace");
    expect(comparisonPhrase(5, 20)?.standalone).toBe("a quarter of their usual pace");
    expect(comparisonPhrase(3, 10)?.standalone).toBe("down 70% on their usual pace");
  });

  it("says nothing at all rather than 'down 100%', because zero is an absence and not a shortfall", () => {
    // The first signal to land after Phase 21+ shipped was exactly this shape:
    // no stories at all against a usual pace of 5.3.
    expect(comparisonPhrase(0, 5.33)?.standalone).toBe("nothing at all against their usual pace");
    expect(comparisonPhrase(0, 5.33)?.running).toBe("nowhere near their usual pace");
    expect(comparisonPhrase(0, 5.33)?.standalone).not.toMatch(/100%/);
    // And the expand says it in the reader's words, not the arithmetic's.
    const detail = metricDetail({ ...BASE, metric: "news_volume_24h", label: "news volume", name: "Larry Ellison", sigma: -2.29, observed: 0, baseline: 5.33 });
    expect(detail.find((line) => line.label === "Against their own pace")?.value).toBe("Nothing at all against their usual pace");
    expect(detail.find((line) => line.label === "Observed")?.value).toBe("0 stories");
  });

  it("says nothing rather than something false when a pace is zero or absent", () => {
    expect(comparisonPhrase(12, 0)).toBeNull();
    expect(comparisonPhrase(12, null)).toBeNull();
    expect(comparisonPhrase(undefined, 4)).toBeNull();
    expect(comparisonPhrase(Number.NaN, 4)).toBeNull();
  });

  it("prefers 'pace' to 'average' or 'baseline' — pace is a rate, and the other two sound like a report card", () => {
    for (const sentence of everySentence()) expect(sentence).not.toMatch(/average|baseline/i);
  });
});

describe("one side of a boundary owns it (Phase 24)", () => {
  /** The magnitude a phrase actually PRINTS: "up 30%..." is 1.3, "2.5x..." is 2.5. */
  const displayed = (phrase: string | undefined): number | null => {
    if (!phrase) return null;
    const percent = /^up (\d+)% on their usual pace$/.exec(phrase);
    if (percent) return 1 + Number(percent[1]) / 100;
    const multiple = /^(\d+(?:\.\d+)?)x their usual pace$/.exec(phrase);
    if (multiple) return Number(multiple[1]);
    return null;
  };

  it("reproduces the defect, and fixes it: 100% above and 2x are the same fact", () => {
    // Fifteen minutes apart on 2026-09-21, about the same metric:
    //   "...moments 100% above their usual pace"  (09:45)
    //   "...moments at 2x their usual pace"       (10:00)
    // A ratio a hair under 2 took the percentage branch and then rounded to
    // 100%. It now takes the multiple branch, because what it PRINTS is 2x.
    expect(comparisonPhrase(1.9975, 1)?.standalone).toBe("2x their usual pace");
    expect(comparisonPhrase(1.9975, 1)?.running).toBe("at 2x their usual pace");
    expect(comparisonPhrase(2, 1)?.standalone).toBe("2x their usual pace");
    // The last reading the percentage form owns, and the first the multiple does.
    expect(comparisonPhrase(1.9949, 1)?.standalone).toBe("up 99% on their usual pace");
    expect(comparisonPhrase(1.995, 1)?.standalone).toBe("2x their usual pace");
  });

  it("never prints the same magnitude two ways, swept across the whole crossing", () => {
    for (let ratio = 1.0; ratio <= 3.0005; ratio += 0.0001) {
      const phrase = comparisonPhrase(ratio, 1)!.standalone;
      // The parity phrases print no figure at all; they are covered below.
      if (!/\d/.test(phrase)) continue;
      const magnitude = displayed(phrase);
      expect(magnitude, `${ratio.toFixed(4)} -> ${phrase}`).not.toBeNull();
      if (phrase.includes("%")) {
        // A percentage may never reach 100, which is where 2x begins.
        expect(magnitude!, `${ratio.toFixed(4)} -> ${phrase}`).toBeLessThan(2);
      } else {
        expect(magnitude!, `${ratio.toFixed(4)} -> ${phrase}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("is monotone: a bigger reading never prints as a smaller one", () => {
    let previous = 0;
    for (let ratio = 1.01; ratio <= 5; ratio += 0.001) {
      const phrase = comparisonPhrase(ratio, 1)!.standalone;
      if (!/\d/.test(phrase)) continue;
      const magnitude = displayed(phrase)!;
      expect(magnitude, `${ratio.toFixed(3)} -> ${phrase}`).toBeGreaterThanOrEqual(previous);
      previous = magnitude;
    }
  });

  it("hands the hundreds over on the printed multiple too, not the raw ratio", () => {
    // 99.8x rounds to "100x", so it belongs with "over 100x" and not among
    // the exact figures — the same defect one boundary further out.
    expect(comparisonPhrase(99.7, 1)?.standalone).toBe("99.5x their usual pace");
    expect(comparisonPhrase(99.75, 1)?.standalone).toBe("over 100x their usual pace");
    expect(comparisonPhrase(100, 1)?.standalone).toBe("over 100x their usual pace");
    // Nothing ever prints a bare "100x": it is either 99.5x or over 100x.
    for (let ratio = 99; ratio <= 101; ratio += 0.01) {
      expect(comparisonPhrase(ratio, 1)?.standalone, ratio.toFixed(2)).not.toBe("100x their usual pace");
    }
  });

  it("below pace, each fraction swallows the percentage that would name it", () => {
    // "half" owns everything that would read "down 50%", "a third" everything
    // that would read "down 67%", and so on — so the two forms can never
    // describe the same shortfall. Swept rather than asserted by eye.
    const forbidden = new Set(["down 50% on their usual pace", "down 67% on their usual pace", "down 75% on their usual pace", "down 80% on their usual pace"]);
    for (let ratio = 0.01; ratio < 1; ratio += 0.0005) {
      const phrase = comparisonPhrase(ratio, 1)!.standalone;
      expect(forbidden.has(phrase), `${ratio.toFixed(4)} -> ${phrase}`).toBe(false);
    }
    expect(comparisonPhrase(0.5, 1)?.standalone).toBe("half of their usual pace");
    expect(comparisonPhrase(1 / 3, 1)?.standalone).toBe("a third of their usual pace");
    expect(comparisonPhrase(0.25, 1)?.standalone).toBe("a quarter of their usual pace");
    expect(comparisonPhrase(0.2, 1)?.standalone).toBe("a fifth of their usual pace");
  });

  it("the three phrases around parity print no figure at all, so none can contradict another", () => {
    // "barely above", "level with" and "just below" are the one place three
    // renderings meet. They are not a defect of the same kind: none states a
    // magnitude, so there is no displayed figure for two of them to share —
    // they carry only the sign, which is a fact the reader can use.
    for (const phrase of [comparisonPhrase(1.004, 1), comparisonPhrase(1, 1), comparisonPhrase(0.996, 1)]) {
      expect(phrase!.standalone).not.toMatch(/\d/);
      expect(phrase!.running).not.toMatch(/\d/);
    }
    expect(comparisonPhrase(1.004, 1)?.standalone).toBe("barely above their usual pace");
    expect(comparisonPhrase(1, 1)?.standalone).toBe("level with their usual pace");
    expect(comparisonPhrase(0.996, 1)?.standalone).toBe("just below their usual pace");
  });

  it("a count crosses into words on the ROUNDED figure, which was already the rule", () => {
    const unit = { one: "story", many: "stories" };
    expect(countWords(999.4, unit)).toBe("999 stories");
    expect(countWords(999.5, unit)).toBe("over a thousand stories");
    expect(countWords(1, unit)).toBe("1 story");
    expect(countWords(1.4, unit)).toBe("1 story");
  });
});

describe("every metric says what it observed", () => {
  it("gives each registered metric its own voice, distinct from the others", () => {
    const registered = [
      "news_volume_24h", "company_news_volume_24h", "viral_moment_rate",
      "subscriber_count", "view_count", "recent_video_views", "commentary_volume_24h", "upload_rate", "comment_volume",
      "follower_count", "stream_hours_7d", "stream_days_7d", "clips_per_stream_hour", "session_peak_viewers",
      "game_passing_yards", "game_passer_rating", "game_interceptions",
    ];
    for (const metric of registered) expect(METRIC_VOICE[metric], metric).toBeDefined();

    // No two metrics share a sentence: one template across every metric is
    // what this phase set out to remove.
    const lines = Object.values(METRIC_VOICE).flatMap((voice) => [...voice.spiking, ...voice.concrete, ...voice.elevated, ...voice.quiet]);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("gives spiking, elevated and quiet a line that needs nothing but the person", () => {
    // The concrete band is built around a number and is allowed to have none;
    // metricSentence() borrows the elevated band for it. The other three must
    // always be able to speak, or a reading would have no sentence at all.
    const bare = (templates: string[]) => templates.some((template) => !/\{(count|comparison|running)\}/.test(template));
    for (const [metric, voice] of Object.entries({ ...METRIC_VOICE, __fallback: fallbackVoice("activity") } as Record<string, MetricVoice>)) {
      expect(bare(voice.spiking), `${metric} spiking`).toBe(true);
      expect(bare(voice.elevated), `${metric} elevated`).toBe(true);
      expect(bare(voice.quiet), `${metric} quiet`).toBe(true);
    }
  });

  it("falls back to the declared label rather than to silence", () => {
    const sentence = metricSentence({ ...BASE, metric: "something_new", label: "podcast downloads", observed: null, baseline: null });
    expect(sentence).toContain("podcast downloads");
    expect(sentence).toContain("Drake");
  });

  it("never prints a count below pace — a low number stated plainly is an accusation", () => {
    for (const metric of Object.keys(METRIC_VOICE)) {
      for (const day of ["2026-09-19", "2026-09-20", "2026-09-21"]) {
        const sentence = metricSentence({ ...BASE, metric, label: metric, sigma: -3.2, observed: 3, baseline: 19, day });
        expect(sentence, `${metric} ${day}`).not.toMatch(/\d/);
      }
    }
  });
});

describe("the comparison stays to the person themselves", () => {
  it("names the person, or their possessive, in every sentence", () => {
    for (const name of ["Drake", "Jensen Huang", "Patrick Mahomes"]) {
      for (const metric of Object.keys(METRIC_VOICE)) {
        for (const sigma of [-3, 2.2, 2.8, 4.1]) {
          const sentence = metricSentence({ ...BASE, name, metric, label: metric, sigma });
          expect(sentence, `${name} ${metric} ${sigma}`).toContain(name);
        }
      }
    }
  });

  it("says 'their usual', never 'his' or 'her' — the roster stores no pronouns and a name does not imply any", () => {
    for (const sentence of everySentence()) {
      expect(sentence, sentence).not.toMatch(/\b(his|her|hers|he|she)\b/i);
    }
  });

  it("states the comparison outright in the expand", () => {
    expect(metricDetail({ ...BASE, name: "Patrick Mahomes", samples: 40 }).map((line) => line.value)).toContain("Patrick Mahomes' own fortnight");
  });
});

describe("a count never becomes a raw level in a headline", () => {
  it("says a four-digit count in words, because the privacy trigger refuses the digits", () => {
    const clips = { one: "clip", many: "clips" };
    const stories = { one: "story", many: "stories" };
    expect(countWords(1247, clips)).toBe("over a thousand clips");
    expect(countWords(999, clips)).toBe("999 clips");
    expect(countWords(12.4, stories)).toBe("12 stories");
  });

  it("agrees with the figure a reader actually sees, not the value behind it", () => {
    const stories = { one: "story", many: "stories" };
    // Exactly one takes the singular; zero and fractions take the plural, and
    // the test is the ROUNDED figure, because that is what is printed.
    expect(countWords(1, stories)).toBe("1 story");
    expect(countWords(1.4, stories)).toBe("1 story");
    expect(countWords(0, stories)).toBe("0 stories");
    expect(countWords(2, stories)).toBe("2 stories");
  });

  it("every unit that can be printed declares both numbers", () => {
    for (const [metric, voice] of Object.entries(METRIC_VOICE)) {
      if (!voice.unit) continue;
      expect(voice.unit.one, metric).toBeTruthy();
      expect(voice.unit.many, metric).toBeTruthy();
      // A singular that equals its plural would be a declaration nobody
      // finished; every unit the board runs today differs in both numbers.
      expect(voice.unit.one, metric).not.toBe(voice.unit.many);
    }
  });

  it("the expand agrees too, at the one decimal it prints", () => {
    const line = (observed: number) =>
      metricDetail({ ...BASE, metric: "news_volume_24h", label: "news volume", name: "Drake", observed, baseline: 4 }).find((l) => l.label === "Observed")?.value;
    expect(line(1)).toBe("1 story");
    expect(line(1.02)).toBe("1 story");
    expect(line(1.4)).toBe("1.4 stories");
    expect(line(0)).toBe("0 stories");
  });

  it("so no sentence can carry a run of four digits, a thousands grouping or a compact count", () => {
    const readings = [12, 999, 1000, 1247, 45_000, 516_000_000];
    for (const metric of Object.keys(METRIC_VOICE)) {
      for (const observed of readings) {
        for (const day of ["2026-09-19", "2026-09-20", "2026-09-21"]) {
          const sentence = metricSentence({ ...BASE, metric, label: metric, sigma: 2.9, observed, baseline: 4, day });
          expect(sentence, sentence).not.toMatch(/\d{4,}/);
          expect(sentence, sentence).not.toMatch(/\d{1,3}(,\d{3})+/);
          expect(sentence, sentence).not.toMatch(/\d(\.\d+)?\s?[KMB]\b/);
        }
      }
    }
  });
});

describe("spans read the way a person says them", () => {
  it("names the window rather than counting its hours", () => {
    expect(spanWords(24)).toBe("day");
    expect(spanWords(168)).toBe("week");
    expect(spanWords(336)).toBe("fortnight");
    expect(spanWords(720)).toBe("month");
    // 1680 hours is ten weeks, which reads better than "2 months" and is true.
    expect(spanWords(1680)).toBe("10 weeks");
  });
});
