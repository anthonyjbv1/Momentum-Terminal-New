import type { EngineReport, Lever } from "@/lib/admin/data";

import { Badge, Empty, Panel, Scroll, Stat, Stats, age, ms, num, stamp } from "./primitives";

/**
 * c) ENGINE STATE and d) RISK LEVERS.
 *
 * The two crons are named separately and never summarised as one "cron"
 * status: they are different jobs behind different flags, and the whole point
 * of Phase 9 is that ingestion can run while the Engine stays dormant.
 *
 * Levers are read-only here by instruction. There is no form, no action and no
 * mutation path on this page.
 */

function Cron({ name, enabled, schedule, path, what }: { name: string; enabled: boolean; schedule: string; path: string; what: string }) {
  return (
    <tr>
      <td>
        <b>{name}</b>
        <div className="adm-dim">{what}</div>
      </td>
      <td>
        <Badge tone={enabled ? "ok" : "plain"}>{enabled ? "enabled" : "disabled"}</Badge>
      </td>
      <td className="adm-k">{schedule}</td>
      <td className="adm-k">{path}</td>
    </tr>
  );
}

export function EngineSection({ report, now }: { report: EngineReport; now: number }) {
  const scores = report.scores;
  const highest = scores[0] ?? null;
  const lowest = scores[scores.length - 1] ?? null;
  const mean = scores.length > 0 ? scores.reduce((total, person) => total + person.score, 0) / scores.length : null;

  return (
    <Panel id="engine" title="Engine state" hint="The two schedules, the ticks they have produced, and where the board currently sits.">
      <Stats>
        <Stat label="Engine cron" value={report.engineCronEnabled ? "ON" : "OFF"} tone={report.engineCronEnabled ? "ok" : "plain"} sub="ENGINE_CRON_ENABLED" />
        <Stat label="Ingestion cron" value={report.ingestCronEnabled ? "ON" : "OFF"} tone={report.ingestCronEnabled ? "ok" : "plain"} sub="INGEST_CRON_ENABLED" />
        <Stat label="Target drift" value={report.targetDriftEnabled ? "ON" : "OFF"} tone={report.targetDriftEnabled ? "ok" : "plain"} sub="ENGINE_TARGET_DRIFT_ENABLED" />
        <Stat label="Backlog" value={num(report.backlog)} tone={report.backlog > 0 ? "warn" : "ok"} sub="unprocessed signals, what the next tick sees" />
        <Stat label="Ticks" value={num(report.tickCount)} sub={report.lastTickNumber === null ? "none yet" : `last #${report.lastTickNumber}`} />
        <Stat label="Last tick" value={age(report.lastTickAt, now)} sub={stamp(report.lastTickAt)} />
        <Stat label="Tick latency" value={ms(report.avgTickMs)} sub={`mean of the last ${report.recentTicks.length || 0}`} />
        <Stat label="People tracked" value={num(scores.length)} sub={mean === null ? undefined : `mean score ${mean.toFixed(2)}`} />
      </Stats>

      <div className="adm-body">
        <p className="adm-sub">Schedules</p>
        <Scroll>
          <table className="adm-t">
            <thead>
              <tr>
                <th>Job</th>
                <th>Flag state</th>
                <th>Schedule</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              <Cron
                name="Engine"
                enabled={report.engineCronEnabled}
                schedule="* * * * * (every minute)"
                path="/api/engine/cron"
                what="Advances scores and may call the model. Costs money when on."
              />
              <Cron
                name="Ingestion"
                enabled={report.ingestCronEnabled}
                schedule="0 * * * * (hourly)"
                path="/api/ingest/cron"
                what="Polls sources and accumulates baselines. Makes no model call."
              />
            </tbody>
          </table>
        </Scroll>
        <p className="adm-note">
          Separately flagged on purpose: ingestion can fill baselines for days with the Engine fully dormant. Each flag is read from this deployment&rsquo;s
          environment and must be exactly the string &ldquo;true&rdquo; to be on.
        </p>

        <div className="adm-cols" style={{ marginTop: 16 }}>
          <div>
            <p className="adm-sub">Recent ticks</p>
            {report.recentTicks.length === 0 ? (
              <Empty>No tick has run. The Engine cron is off and nothing has been triggered manually.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th className="n">#</th>
                      <th>Started</th>
                      <th className="n">Took</th>
                      <th className="n">Mood</th>
                      <th className="n">People</th>
                      <th className="n">Processed</th>
                      <th className="n">Attempted</th>
                      <th className="n">Deferred</th>
                      <th className="n">Fell back</th>
                      <th className="n">Calls</th>
                      <th className="n">Backlog after</th>
                      <th>Commit</th>
                      <th className="wrap">What moved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.recentTicks.map((tick) => (
                      <tr key={tick.tickNumber}>
                        <td className="n">{tick.tickNumber}</td>
                        <td className="adm-k">{stamp(tick.startedAt)}</td>
                        <td className="n">{ms(tick.durationMs)}</td>
                        <td className="n">{tick.mood === null ? "—" : tick.mood.toFixed(2)}</td>
                        <td className="n">{num(tick.peopleUpdated)}</td>
                        <td className="n">{num(tick.signalsProcessed)}</td>
                        <td className="n">{tick.work ? num(tick.work.attempted) : "—"}</td>
                        <td className="n">{tick.work ? tick.work.deferred > 0 ? <Badge tone="warn">{tick.work.deferred}</Badge> : "0" : "—"}</td>
                        <td className="n">{tick.work ? tick.work.fallbacks > 0 ? <Badge tone="warn">{tick.work.fallbacks}</Badge> : "0" : "—"}</td>
                        <td className="n">{tick.work ? num(tick.work.llmCalls) : "—"}</td>
                        <td className="n">{tick.work ? num(tick.work.backlogAfter) : "—"}</td>
                        <td>{tick.work ? <Badge tone={tick.work.partial ? "info" : "ok"}>{tick.work.partial ? "partial" : "full"}</Badge> : "—"}</td>
                        <td className="wrap">
                          {tick.movers.length === 0
                            ? "—"
                            : tick.movers.map((mover) => `${mover.slug} ${mover.change > 0 ? "+" : ""}${mover.change.toFixed(2)}`).join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
            <p className="adm-note">
              Every tick that starts commits. <b>Attempted</b> went to the model (scored by it, or <b>fell back</b> to rules when the call failed);
              <b> deferred</b> was never attempted — the deadline, the per-tick call budget or the one-chunk-per-person rule held it back — and stays
              unprocessed for a later tick. A <b>partial</b> commit is a tick that left signals behind; the backlog after it is what the next tick sees.
            </p>
          </div>

          <div>
            <p className="adm-sub">Score distribution</p>
            {scores.length === 0 ? (
              <Empty>No active people.</Empty>
            ) : (
              <>
                <Scroll>
                  <table className="adm-t">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th className="n">Score</th>
                        <th className="n">Gravity target</th>
                        <th className="n">Seed</th>
                        <th className="n">Drift</th>
                        <th className="n">Gap</th>
                        <th className="n">Sources</th>
                        <th>Forecast</th>
                        <th>Last tick</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scores.map((person) => (
                        <tr key={person.slug}>
                          <td>
                            {person.displayName} <span className="adm-dim adm-k">{person.slug}</span>
                          </td>
                          <td className="n">{person.score.toFixed(2)}</td>
                          <td className="n">{person.revertTarget.toFixed(2)}</td>
                          <td className="n">{person.seedTarget.toFixed(2)}</td>
                          <td className="n">{person.targetOffset === 0 ? "—" : `${person.targetOffset > 0 ? "+" : ""}${person.targetOffset.toFixed(2)}`}</td>
                          <td className="n">{(person.score - person.revertTarget).toFixed(2)}</td>
                          <td className="n">{person.activeSources === 0 ? <Badge tone="warn">none</Badge> : num(person.activeSources)}</td>
                          <td>{person.forecastPaused ? <Badge tone="warn">paused</Badge> : <span className="adm-dim">open</span>}</td>
                          <td>{age(person.lastTickAt, now)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>
                          {scores.length} people · high {highest?.slug ?? "—"} / low {lowest?.slug ?? "—"}
                        </td>
                        <td className="n">{mean === null ? "—" : mean.toFixed(2)}</td>
                        <td className="n" colSpan={7}>
                          mean
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </Scroll>
                <p className="adm-note">
                  <b>Gravity target</b> is what the last tick pulled toward: the seeded <b>revert_target</b> plus the drifting target&rsquo;s offset (Phase 14; shown
                  as <b>Drift</b>, empty while ENGINE_TARGET_DRIFT_ENABLED is off). <b>Sources</b> counts the person&rsquo;s active source mappings: a person with none can
                  never receive a signal, so their score is their target and nothing else. <b>Forecast</b> is the crowd layer&rsquo;s per-person switch (Phase 19):
                  <b> paused</b> hides the section and refuses new votes; it is set by SQL (<code>update public.people set forecast_paused = true where slug = &hellip;</code>).
                </p>
              </>
            )}
          </div>

          <VolumeBlock volume={report.volume} />
        </div>
      </div>
    </Panel>
  );
}

/**
 * THE VOLUME WEIGHT, AND WHETHER ITS REFERENCE IS STALE (Phase 18++).
 *
 * The reference is a cross-person constant inside a per-person mechanism, so
 * it goes stale whenever the roster or its sources change — and it did, for
 * three phases, invisibly, until fourteen of sixteen people sat on the ceiling
 * and the weight had become a constant multiplier. Two symptoms are shown here
 * rather than left latent: the share of engaged people on a bound, and how far
 * the roster's own geometric mean has moved from the reference. Either one
 * crossing is the signal to re-derive. `Engaged` is also how the two-wave
 * transition of 2026-09-25 / 09-26 is watched rather than inferred.
 */
function VolumeBlock({ volume }: { volume: EngineReport["volume"] }) {
  const review = volume.boundedShareHigh || volume.referenceDrifted;
  return (
    <div>
      <p className="adm-sub">Signal volume</p>
      <Stats>
        <Stat
          label="Weight engaged"
          value={`${num(volume.engaged)} / ${num(volume.people)}`}
          sub="seven complete days after a person's newest mapping"
          tone={volume.engaged === 0 ? "plain" : "info"}
        />
        <Stat label="Reference" value={num(volume.reference, 2)} sub="events a day; the roster's geometric mean when last derived" />
        <Stat
          label="Roster now"
          value={volume.liveGeometricMean === null ? "—" : num(volume.liveGeometricMean, 2)}
          sub="live geometric mean of the engaged"
          tone={volume.referenceDrifted ? "warn" : "plain"}
        />
        <Stat
          label="On a bound"
          value={num(volume.atCeiling + volume.atFloor)}
          sub={`${num(volume.atCeiling)} at ${num(volume.maxWeight, 2)}, ${num(volume.atFloor)} at ${num(volume.minWeight, 2)}`}
          tone={volume.boundedShareHigh ? "warn" : "plain"}
        />
      </Stats>
      {volume.rows.length === 0 ? (
        <Empty>No active people.</Empty>
      ) : (
        <>
          <Scroll>
            <table className="adm-t">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="n">Typical / day</th>
                  <th className="n">Days</th>
                  <th className="n">Weight</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {volume.rows.map((row) => (
                  <tr key={row.slug}>
                    <td>
                      {row.displayName} <span className="adm-dim adm-k">{row.slug}</span>
                    </td>
                    <td className="n">{row.typicalPerDay === null ? "—" : num(row.typicalPerDay, 2)}</td>
                    <td className="n">{num(row.samples)}</td>
                    <td className="n">{num(row.weight, 3)}</td>
                    <td>
                      {!row.engaged ? (
                        <Badge>not engaged</Badge>
                      ) : row.bound === "ceiling" ? (
                        <Badge tone="warn">capped</Badge>
                      ) : row.bound === "floor" ? (
                        <Badge tone="warn">floored</Badge>
                      ) : (
                        <Badge tone="ok">scaling</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          <p className="adm-note">
            Every event signal&rsquo;s impact is multiplied by <b>Weight</b> = reference ÷ the person&rsquo;s own typical events a day, bounded to [
            {num(volume.minWeight, 2)}, {num(volume.maxWeight, 2)}]. It is exactly 1 and <b>not engaged</b> until seven complete days exist, so the roster crosses
            over in waves as each person&rsquo;s mapping clock matures. <b>Capped</b> or <b>floored</b> means a bound is deciding the weight rather than the
            person&rsquo;s own volume.
            {review ? (
              <>
                {" "}
                <b>Re-derive the reference.</b>{" "}
                {volume.boundedShareHigh ? "More than a third of the engaged are on a bound. " : ""}
                {volume.referenceDrifted ? `The roster's geometric mean (${volume.liveGeometricMean}) has left [${volume.reference / 2}, ${volume.reference * 2}]. ` : ""}
                Set ENGINE_VOLUME_REFERENCE, or change the default in lib/engine/config.ts.
              </>
            ) : null}
          </p>
        </>
      )}
    </div>
  );
}

export function LeversSection({ levers }: { levers: Lever[] }) {
  return (
    <Panel id="levers" title="Risk levers" hint="Current values, read-only." right={<Badge tone="info">read-only in this phase</Badge>}>
      <Scroll>
        <table className="adm-t">
          <thead>
            <tr>
              <th>Lever</th>
              <th className="n">Value</th>
              <th>Set in</th>
              <th className="wrap">What it does</th>
            </tr>
          </thead>
          <tbody>
            {levers.map((lever) => (
              <tr key={lever.name}>
                <td>{lever.name}</td>
                <td className="n">{lever.value}</td>
                <td className="adm-k adm-dim">{lever.source}</td>
                <td className="wrap">{lever.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
      <div className="adm-body" style={{ paddingTop: 0 }}>
        <p className="adm-note">No editing here by design: this page has no write path of any kind. The database rows are changed by migration.</p>
      </div>
    </Panel>
  );
}
