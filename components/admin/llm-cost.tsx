import type { LlmCostReport } from "@/lib/admin/data";

import { Badge, Empty, Panel, Scroll, Stat, Stats, WindowTabs, num, stamp, usd } from "./primitives";

/**
 * a) LLM COST AND USAGE.
 *
 * The unpriced counter is a headline stat, not a footnote: a call whose model
 * string matches no price row costs something real, and folding it into the
 * total as zero would make the total quietly wrong. So it sits beside the
 * total, names the models, and is never added in.
 */

export function LlmCostSection({ report }: { report: LlmCostReport }) {
  const unpriced = report.unpricedCalls > 0;
  const maxTrend = Math.max(0, ...report.trend.map((day) => day.costUsd));

  return (
    <Panel id="llm" title="LLM cost and usage" hint="Every model call the Engine has made, priced by exact model string." right={<WindowTabs current={report.window} />}>
      <Stats>
        <Stat label="Cost" value={usd(report.totalCostUsd)} sub={`priced, completed calls only · ${report.window}`} />
        <Stat label="Calls" value={num(report.totalCalls)} sub={`${num(report.completedCalls)} completed`} />
        <Stat
          label="Unsettled calls"
          value={num(report.startedCalls)}
          tone={report.startedCalls > 0 ? "bad" : "ok"}
          sub={report.startedCalls > 0 ? "started, never settled: the process died inside them" : "no call was cut off in flight"}
        />
        <Stat label="Failed calls" value={num(report.failedCalls)} tone={report.failedCalls > 0 ? "warn" : "ok"} sub="threw: timeout or provider error" />
        <Stat
          label="Unpriced calls"
          value={num(report.unpricedCalls)}
          tone={unpriced ? "bad" : "ok"}
          sub={unpriced ? `no price row: ${report.unpricedModels.join(", ")}` : "every model matched a price row"}
        />
        <Stat label="Input tokens" value={num(report.byModel.reduce((total, row) => total + row.inputTokens, 0))} />
        <Stat label="Output tokens" value={num(report.byModel.reduce((total, row) => total + row.outputTokens, 0))} />
        <Stat label="Cache read" value={num(report.byModel.reduce((total, row) => total + row.cacheReadTokens, 0))} sub="tokens" />
      </Stats>

      <div className="adm-body">
        <div className="adm-cols">
          <div>
            <p className="adm-sub">By model</p>
            {report.byModel.length === 0 ? (
              <Empty>No calls in this window.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="n">Calls</th>
                      <th className="n">In</th>
                      <th className="n">Out</th>
                      <th className="n">Cache r/w</th>
                      <th className="n">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byModel.map((row) => (
                      <tr key={row.key}>
                        <td className="adm-k">
                          {row.key} {row.unpriced ? <Badge tone="bad">unpriced</Badge> : null}
                        </td>
                        <td className="n">{num(row.calls)}</td>
                        <td className="n">{num(row.inputTokens)}</td>
                        <td className="n">{num(row.outputTokens)}</td>
                        <td className="n">
                          {num(row.cacheReadTokens)}/{num(row.cacheWriteTokens)}
                        </td>
                        <td className="n">{row.unpriced ? "—" : usd(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </div>

          <div>
            <p className="adm-sub">By task type</p>
            {report.byTask.length === 0 ? (
              <Empty>No calls in this window.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th className="n">Calls</th>
                      <th className="n">In</th>
                      <th className="n">Out</th>
                      <th className="n">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byTask.map((row) => (
                      <tr key={row.key}>
                        <td>{row.key}</td>
                        <td className="n">{num(row.calls)}</td>
                        <td className="n">{num(row.inputTokens)}</td>
                        <td className="n">{num(row.outputTokens)}</td>
                        <td className="n">{row.unpriced ? "partial" : usd(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </div>
        </div>

        <div className="adm-cols" style={{ marginTop: 16 }}>
          <div>
            <p className="adm-sub">Cost trend · daily</p>
            {report.trend.length === 0 ? (
              <Empty>Nothing to plot yet.</Empty>
            ) : (
              <>
                <div className="adm-trend">
                  {report.trend.map((day) => (
                    <div
                      key={day.day}
                      data-zero={day.costUsd === 0 ? "true" : undefined}
                      style={{ height: maxTrend > 0 ? `${Math.max(2, (day.costUsd / maxTrend) * 100)}%` : "2%" }}
                      title={`${day.day}: ${usd(day.costUsd)} over ${day.calls} calls`}
                    />
                  ))}
                </div>
                <div className="adm-trend-x">
                  {report.trend.map((day) => (
                    <span key={day.day}>{day.day.slice(5)}</span>
                  ))}
                </div>
                <Scroll>
                  <table className="adm-t" style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th>Day</th>
                        <th className="n">Calls</th>
                        <th className="n">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...report.trend].reverse().map((day) => (
                        <tr key={day.day}>
                          <td className="adm-k">{day.day}</td>
                          <td className="n">{num(day.calls)}</td>
                          <td className="n">{usd(day.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroll>
              </>
            )}
          </div>

          <div>
            <p className="adm-sub">Cost per tick · most recent {report.perTick.length || 0}</p>
            {report.perTick.length === 0 ? (
              <Empty>No tick has made a model call. The Engine cron is off.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th className="n">Tick</th>
                      <th className="n">Calls</th>
                      <th className="n">Failed</th>
                      <th className="n">Unsettled</th>
                      <th className="n">Sent</th>
                      <th className="n">Anom</th>
                      <th className="n">Narr</th>
                      <th className="n">Mem</th>
                      <th className="n">Unpriced</th>
                      <th className="n">Cost</th>
                      <th>Last call</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.perTick.map((tick) => (
                      <tr key={tick.tickNumber ?? "unattributed"}>
                        <td className="n">{tick.tickNumber ?? "—"}</td>
                        <td className="n">{num(tick.calls)}</td>
                        <td className="n">{tick.failed > 0 ? <Badge tone="warn">{tick.failed}</Badge> : "0"}</td>
                        <td className="n">{tick.started > 0 ? <Badge tone="bad">{tick.started}</Badge> : "0"}</td>
                        <td className="n">{num(tick.sentiment)}</td>
                        <td className="n">{num(tick.anomaly)}</td>
                        <td className="n">{num(tick.narrative)}</td>
                        <td className="n">{num(tick.memory)}</td>
                        <td className="n">{tick.unpricedCalls > 0 ? <Badge tone="bad">{tick.unpricedCalls}</Badge> : "0"}</td>
                        <td className="n">{usd(tick.costUsd)}</td>
                        <td className="adm-k adm-dim">{stamp(tick.lastCallAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </div>
        </div>

        <p className="adm-note">
          Prices join on the exact model string (llm_model_prices.model). An unpriced call is counted and named but never costed at zero — the totals above are
          the priced calls only. A call is written to the ledger <b>before</b> it is made and settled when it returns; a call still <b>unsettled</b> was billed
          by the provider and cut off in flight — the state this console could not see during the first cron run. A <b>failed</b> call threw (a timeout, a
          provider error) and carries its reason; it costs its input and shows no output tokens.
        </p>
      </div>
    </Panel>
  );
}
