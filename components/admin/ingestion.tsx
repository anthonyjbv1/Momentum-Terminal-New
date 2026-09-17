import type { BaselineRow, IngestionReport } from "@/lib/admin/data";

import { Badge, Empty, Meter, Panel, Scroll, Stat, Stats, type Tone, age, hours, num, percent, stamp } from "./primitives";

/**
 * b) INGESTION HEALTH, and the clock: per-metric baseline progress.
 *
 * PRIVACY. Nothing here reads either of the two raw metric tables — they are
 * named in lib/ingest/store.ts and nowhere else in the codebase, and a test
 * enforces that. Baseline progress comes from metric_baseline_progress, whose
 * columns are counts, configuration and timestamps; a metric LEVEL is not a
 * column of that view, so no level can appear on this page even by accident.
 */

const OUTCOME_TONE: Record<string, Tone> = {
  emitted: "ok",
  inside_band: "info",
  insufficient_baseline: "warn",
  first_contact: "warn",
  no_config: "bad",
};

/** What each outcome means, spelled out — the operator should not have to remember. */
const OUTCOME_NOTE: Record<string, string> = {
  emitted: "outside the band and sufficient: this metric is producing signals",
  inside_band: "baseline is ready; the latest reading was ordinary",
  insufficient_baseline: "still accumulating: fewer observations in the window than the declared minimum",
  first_contact: "first snapshot recorded; there is no prior reading to compare against",
  no_config: "polled but not declared as a metric with a baseline",
};

function outcomeBadge(outcome: string | null) {
  const key = outcome ?? "unknown";
  return <Badge tone={OUTCOME_TONE[key] ?? "plain"}>{key.replace(/_/g, " ")}</Badge>;
}

function sourceTone(row: IngestionReport["sources"][number]): Tone {
  if (!row.isActive) return "plain";
  if (row.errors24h > 0 && row.errorRate24h !== null && row.errorRate24h >= 0.5) return "bad";
  if (row.errors24h > 0) return "warn";
  if (row.polls24h === 0) return "warn";
  return "ok";
}

function baselineReady(row: BaselineRow): boolean {
  return row.lastOutcome === "emitted" || row.lastOutcome === "inside_band";
}

/** What a publisher feed's last fetch found (Phase 13), and how to read it. */
const FEED_TONE: Record<string, Tone> = {
  ok: "ok",
  not_modified: "ok",
  discovered: "info",
  empty: "warn",
  undated: "warn",
  no_feed_found: "warn",
  not_feed: "bad",
  error: "bad",
};

const FEED_NOTE: Record<string, string> = {
  ok: "a feed with dated items: it is being read",
  not_modified: "the publisher answered 304: nothing changed since the last fetch",
  discovered: "discovery found a feed behind this page; promote it by setting url and mode",
  empty: "a well-formed feed carrying no items",
  undated: "items with no publication date: nothing is ingested from it",
  no_feed_found: "discovery found nothing behind this page that parses as a feed",
  not_feed: "the address answers, but not with RSS or Atom",
  error: "HTTP failure, timeout or network error",
};

function feedBadge(status: string | null) {
  if (status === null) return <Badge tone="plain">never fetched</Badge>;
  return <Badge tone={FEED_TONE[status] ?? "plain"}>{status.replace(/_/g, " ")}</Badge>;
}

/** A feed's items carry bodies, headlines only, or nothing yet says. */
function feedShape(row: IngestionReport["feeds"][number]): string {
  if (row.itemCount === null || row.itemCount === 0) return "—";
  if (row.datedCount === 0) return "undated";
  if ((row.describedCount ?? 0) === 0) return "headline-only";
  return `${num(row.describedCount)} with body`;
}

export function IngestionSection({ report, now }: { report: IngestionReport; now: number }) {
  const active = report.sources.filter((source) => source.isActive);
  const errors = report.sources.reduce((total, source) => total + source.errors24h, 0);
  const byOutcome = new Map<string, number>();
  for (const row of report.baselines) byOutcome.set(row.lastOutcome ?? "unknown", (byOutcome.get(row.lastOutcome ?? "unknown") ?? 0) + 1);

  return (
    <Panel
      id="ingestion"
      title="Ingestion health"
      hint="Per source, per run, and the baseline clock each metric is waiting on."
      right={`${active.length} of ${report.sources.length} sources active`}
    >
      <Stats>
        <Stat label="Polls · 24h" value={num(report.sources.reduce((total, source) => total + source.polls24h, 0))} />
        <Stat label="Errors · 24h" value={num(errors)} tone={errors > 0 ? "bad" : "ok"} />
        <Stat label="Signals · 24h" value={num(report.sources.reduce((total, source) => total + source.signals24h, 0))} />
        <Stat label="Blocked · 24h" value={num(report.sources.reduce((total, source) => total + source.blocked24h, 0))} sub="publisher not allowed" />
        <Stat label="Collapsed · 24h" value={num(report.sources.reduce((total, source) => total + source.collapsed24h, 0))} sub="duplicate stories" />
        <Stat
          label="Excluded · 24h"
          value={num(report.sources.reduce((total, source) => total + source.excluded24h, 0))}
          sub="a different entity, same name"
        />
        <Stat
          label="Metrics emitting"
          value={`${byOutcome.get("emitted") ?? 0} / ${report.baselines.length}`}
          tone={(byOutcome.get("emitted") ?? 0) > 0 ? "ok" : "warn"}
          sub={`${byOutcome.get("insufficient_baseline") ?? 0} still accumulating`}
        />
      </Stats>

      <div className="adm-body">
        <p className="adm-sub">Sources</p>
        <Scroll>
          <table className="adm-t">
            <thead>
              <tr>
                <th>Source</th>
                <th>State</th>
                <th className="n">People</th>
                <th>Last success</th>
                <th>Last poll</th>
                <th className="n">Polls 24h</th>
                <th className="n">Errors</th>
                <th className="n">Error rate</th>
                <th className="n">Latency</th>
                <th className="n">Signals</th>
                <th className="wrap">Last error / skip</th>
              </tr>
            </thead>
            <tbody>
              {report.sources.map((source) => (
                <tr key={source.name}>
                  <td>
                    <span className="adm-k">{source.name}</span> <span className="adm-dim">t{source.tier}</span>
                  </td>
                  <td>
                    <Badge tone={sourceTone(source)}>{source.isActive ? "active" : "inactive"}</Badge>
                  </td>
                  <td className="n">{num(source.peopleMapped)}</td>
                  <td>
                    {age(source.lastSuccessAt, now)}
                    <div className="adm-k adm-dim">{stamp(source.lastSuccessAt)}</div>
                  </td>
                  <td>{age(source.lastPollAt, now)}</td>
                  <td className="n">{num(source.polls24h)}</td>
                  <td className="n">{num(source.errors24h)}</td>
                  <td className="n">{percent(source.errorRate24h)}</td>
                  <td className="n">{source.avgLatencyMs24h === null ? "—" : `${num(source.avgLatencyMs24h)}ms`}</td>
                  <td className="n">{num(source.signals24h)}</td>
                  <td className="wrap adm-dim">{source.lastError ?? source.lastSkipReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>

        <p className="adm-sub" style={{ marginTop: 16 }}>
          Publisher feeds · the catalogue, and what each feed&apos;s last fetch found
        </p>
        {report.feeds.length === 0 ? (
          <Empty>No publisher feed is registered.</Empty>
        ) : (
          <Scroll>
            <table className="adm-t">
              <thead>
                <tr>
                  <th>Publisher</th>
                  <th>Section</th>
                  <th>Topics</th>
                  <th>State</th>
                  <th className="n">Items</th>
                  <th className="n">Dated</th>
                  <th>Shape</th>
                  <th className="n">Matched</th>
                  <th>Newest item</th>
                  <th>Fetched</th>
                  <th className="wrap">Found / error</th>
                </tr>
              </thead>
              <tbody>
                {report.feeds.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className="adm-k">{row.domain}</span>
                      {row.isActive ? null : <> <Badge tone="plain">inactive</Badge></>}
                      {row.mode === "discover" ? <> <Badge tone="info">discovery</Badge></> : null}
                      <div className="adm-k adm-dim">{row.url}</div>
                    </td>
                    <td>{row.section}</td>
                    <td className="adm-dim">{row.topics.join(", ") || "all"}</td>
                    <td title={FEED_NOTE[row.lastStatus ?? ""] ?? undefined}>
                      {feedBadge(row.lastStatus)}
                      {row.consecutiveFailures > 0 ? <div className="adm-dim">{num(row.consecutiveFailures)} in a row</div> : null}
                    </td>
                    <td className="n">{row.itemCount === null ? "—" : num(row.itemCount)}</td>
                    <td className="n">{row.datedCount === null ? "—" : num(row.datedCount)}</td>
                    <td className="adm-dim">{feedShape(row)}</td>
                    <td className="n">{row.matchedCount === null ? "—" : num(row.matchedCount)}</td>
                    <td>
                      {age(row.newestPublishedAt, now)}
                      <div className="adm-k adm-dim">{stamp(row.newestPublishedAt)}</div>
                    </td>
                    <td>{age(row.lastFetchedAt, now)}</td>
                    <td className="wrap adm-dim">{row.discoveredUrl ?? row.lastError ?? row.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
        <p className="adm-note">
          Health is measured, never assumed: every row is fetched from production on its turn, and an item with no publication date is never ingested from
          this source. Matched counts how many of the feed&apos;s items named a subject on the last run. A discovery row records the feed it found and ingests
          nothing until it is promoted.
        </p>

        <p className="adm-sub" style={{ marginTop: 16 }}>
          Baseline progress · per person, per metric
        </p>
        {report.baselines.length === 0 ? (
          <Empty>No metric has been observed yet.</Empty>
        ) : (
          <Scroll>
            <table className="adm-t">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Source</th>
                  <th>Metric</th>
                  <th>State</th>
                  <th>Samples vs minimum</th>
                  <th>Span vs window</th>
                  <th className="n">Snapshots</th>
                  <th>Last observed</th>
                </tr>
              </thead>
              <tbody>
                {report.baselines.map((row) => {
                  const ready = baselineReady(row);
                  return (
                    <tr key={`${row.personSlug}:${row.source}:${row.metricKey}`}>
                      <td>{row.personSlug}</td>
                      <td className="adm-k">{row.source}</td>
                      <td className="adm-k">{row.metricKey}</td>
                      <td title={OUTCOME_NOTE[row.lastOutcome ?? ""] ?? undefined}>{outcomeBadge(row.lastOutcome)}</td>
                      <td>
                        {row.minSamples === null ? (
                          <span className="adm-dim">no baseline configured</span>
                        ) : (
                          <Meter ratio={row.sampleProgress} label={`${num(row.samples)} / ${num(row.minSamples)}`} done={ready} />
                        )}
                      </td>
                      <td>
                        {row.windowHours === null ? (
                          <span className="adm-dim">—</span>
                        ) : (
                          <Meter ratio={row.spanProgress} label={`${hours(row.spanHours)} / ${hours(row.windowHours)}`} done={ready} />
                        )}
                      </td>
                      <td className="n">{num(row.snapshots)}</td>
                      <td>
                        {age(row.lastObservedAt, now)}
                        <div className="adm-k adm-dim">{stamp(row.lastObservedAt)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Scroll>
        )}
        <p className="adm-note">
          Emission is gated by SAMPLES alone: a metric is eligible once it has at least its minimum number of observations. The window does not have to be
          filled — it decides which history counts toward that minimum, and every window here is far wider than the samples needed, so the samples column is
          the one to watch. Counts and configuration only; no metric level is read or shown here.
        </p>

        <div className="adm-cols" style={{ marginTop: 16 }}>
          <div>
            <p className="adm-sub">Recent runs</p>
            {report.runs.length === 0 ? (
              <Empty>No ingestion run recorded.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>Trigger</th>
                      <th className="n">Sources</th>
                      <th className="n">Signals</th>
                      <th className="n">Snaps</th>
                      <th className="n">Obs</th>
                      <th className="n">Blocked</th>
                      <th className="n">Collapsed</th>
                      <th className="n">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.runs.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <span className="adm-k">{stamp(run.startedAt)}</span>
                          <div className="adm-dim">{run.finishedAt ? age(run.startedAt, now) : <Badge tone="info">in flight</Badge>}</div>
                        </td>
                        <td>
                          {run.trigger}
                          {run.forced ? <> <Badge tone="warn">forced</Badge></> : null}
                        </td>
                        <td className="n">{num(run.sourcesRun)}</td>
                        <td className="n">{num(run.signalsCreated)}</td>
                        <td className="n">{num(run.snapshotsRecorded)}</td>
                        <td className="n">{num(run.observations)}</td>
                        <td className="n">{num(run.blockedDropped)}</td>
                        <td className="n">{num(run.duplicatesCollapsed)}</td>
                        <td className="n">{run.errors > 0 ? <Badge tone="bad">{run.errors}</Badge> : "0"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </div>

          <div>
            <p className="adm-sub">Recent poll errors</p>
            {report.recentErrors.length === 0 ? (
              <Empty>No poll has errored.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Source</th>
                      <th>Person</th>
                      <th className="wrap">Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.recentErrors.map((error, index) => (
                      <tr key={`${error.at}:${index}`}>
                        <td className="adm-k">{stamp(error.at)}</td>
                        <td className="adm-k">{error.source}</td>
                        <td>{error.person ?? "—"}</td>
                        <td className="wrap">{error.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
