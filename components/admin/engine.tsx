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
                        <th className="n">Gap</th>
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
                          <td className="n">{(person.score - person.revertTarget).toFixed(2)}</td>
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
                        <td className="n" colSpan={3}>
                          mean
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </Scroll>
              </>
            )}
          </div>
        </div>
      </div>
    </Panel>
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
