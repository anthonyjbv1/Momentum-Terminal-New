import type { BehaviourReport } from "@/lib/admin/data";

import { Empty, Panel, Scroll, Stat, Stats, WindowTabs, num, percent } from "./primitives";

/**
 * e) USER BEHAVIOUR.
 *
 * Empty during the closed test, and that is the honest reading — the queries
 * are built so the first real session shows up without further work. The one
 * number worth watching is the abandon rate: of the trade sheets that ended
 * either way, how many were backed out of.
 */

function seconds(value: number): string {
  if (value < 90) return `${Math.round(value)}s`;
  if (value < 5400) return `${(value / 60).toFixed(1)}m`;
  return `${(value / 3600).toFixed(1)}h`;
}

export function BehaviourSection({ report }: { report: BehaviourReport }) {
  const funnel = report.trade;
  const empty = report.totalEvents === 0;

  return (
    <Panel id="behaviour" title="User behaviour" hint="What people did, from the Phase 5 event log." right={<WindowTabs current={report.window} />}>
      <Stats>
        <Stat label="Events" value={num(report.totalEvents)} sub={report.window} />
        <Stat label="Active users" value={num(report.activeUsers)} />
        <Stat label="Sessions" value={num(report.sessions)} />
        <Stat label="Trade sheets opened" value={num(funnel.sheetsOpened)} />
        <Stat label="Confirmed" value={num(funnel.confirmed)} tone={funnel.confirmed > 0 ? "ok" : "plain"} />
        <Stat
          label="Abandon rate"
          value={percent(funnel.abandonRate)}
          tone={funnel.abandonRate === null ? "plain" : funnel.abandonRate > 0.5 ? "bad" : funnel.abandonRate > 0.25 ? "warn" : "ok"}
          sub="abandoned ÷ (abandoned + confirmed)"
        />
      </Stats>

      <div className="adm-body">
        {empty ? (
          <Empty>No behavioural event in this window. The queries are live; they will populate on the first session.</Empty>
        ) : null}

        <div className="adm-cols">
          <div>
            <p className="adm-sub">Trade funnel</p>
            <Scroll>
              <table className="adm-t">
                <tbody>
                  <tr>
                    <td>Sheets opened</td>
                    <td className="n">{num(funnel.sheetsOpened)}</td>
                  </tr>
                  <tr>
                    <td>Confirmed (position taken)</td>
                    <td className="n">{num(funnel.confirmed)}</td>
                  </tr>
                  <tr>
                    <td>Abandoned (backed out of the sheet)</td>
                    <td className="n">{num(funnel.abandoned)}</td>
                  </tr>
                  <tr>
                    <td>Rejected (quote moved past tolerance)</td>
                    <td className="n">{num(funnel.rejected)}</td>
                  </tr>
                  <tr>
                    <td>Positions closed</td>
                    <td className="n">{num(funnel.closes)}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td>Abandon-to-trade ratio</td>
                    <td className="n">{percent(funnel.abandonRate)}</td>
                  </tr>
                </tfoot>
              </table>
            </Scroll>
          </div>

          <div>
            <p className="adm-sub">Feed engagement</p>
            <Scroll>
              <table className="adm-t">
                <tbody>
                  <tr>
                    <td>Entry impressions</td>
                    <td className="n">{num(report.feed.impressions)}</td>
                  </tr>
                  <tr>
                    <td>Distinct entries seen</td>
                    <td className="n">{num(report.feed.entriesSeen)}</td>
                  </tr>
                  <tr>
                    <td>Dwell on the Feed</td>
                    <td className="n">{seconds(report.feed.dwellSeconds)}</td>
                  </tr>
                  <tr>
                    <td>Deepest scroll</td>
                    <td className="n">{report.feed.deepestScrollPercent === null ? "—" : `${Math.round(report.feed.deepestScrollPercent)}%`}</td>
                  </tr>
                  <tr>
                    <td>Filter changes</td>
                    <td className="n">{num(report.feed.filterChanges)}</td>
                  </tr>
                  <tr>
                    <td>Tap-throughs from the Feed</td>
                    <td className="n">{num(report.feed.tapThroughs)}</td>
                  </tr>
                  <tr>
                    <td>Signal expands</td>
                    <td className="n">{num(report.feed.expands)}</td>
                  </tr>
                </tbody>
              </table>
            </Scroll>
          </div>
        </div>

        <div className="adm-cols" style={{ marginTop: 16 }}>
          <div>
            <p className="adm-sub">Most-viewed people</p>
            {report.topPeople.length === 0 ? (
              <Empty>No person view recorded.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th className="n">Views</th>
                      <th className="n">Dwell</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.topPeople.map((person) => (
                      <tr key={person.slug}>
                        <td>
                          {person.displayName} <span className="adm-dim adm-k">{person.slug}</span>
                        </td>
                        <td className="n">{num(person.views)}</td>
                        <td className="n">{seconds(person.dwellSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </div>

          <div>
            <p className="adm-sub">Events by type</p>
            {report.byType.length === 0 ? (
              <Empty>Nothing logged in this window.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th className="n">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byType.map((row) => (
                      <tr key={row.type}>
                        <td className="adm-k">{row.type}</td>
                        <td className="n">{num(row.count)}</td>
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
