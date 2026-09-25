import type { AlertRow, MarketPersonRow, MarketReport } from "@/lib/admin/data";
import { marketAction } from "@/app/admin/actions";

import { Badge, Empty, Panel, Scroll, Stat, Stats, age, num, stamp, type Tone } from "./primitives";

/**
 * g) THE MARKET (Phase 29): the review queue and the market's state, with
 * the actions the admin RPCs expose. Plain HTML forms posting to one Server
 * Action; no client JavaScript. Every action lands a row in admin_audit_log,
 * which is append-only, and the newest of those rows are at the bottom of
 * this panel so the operator sees the trail they are leaving.
 *
 * Evidence is shown as the detectors wrote it: counts, windows and salted
 * hash prefixes. No address, no user agent, no email appears here.
 */

const severityTone: Record<string, Tone> = { low: "plain", medium: "info", high: "warn", critical: "bad" };
const statusTone: Record<string, Tone> = { open: "warn", reviewing: "info", resolved: "ok", dismissed: "plain" };

function money(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function evidenceText(evidence: Record<string, unknown>): string {
  return Object.entries(evidence)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" · ");
}

export function MarketSection({ report, now, notice }: { report: MarketReport; now: number; notice: string | null }) {
  const halted = report.people.filter((person) => person.haltedUntil !== null).length;
  const notTradeable = report.people.filter((person) => person.tradingMode !== "tradeable").length;
  const withPremium = report.people.filter((person) => person.premiumCents !== 0).length;

  return (
    <Panel id="market" title="The market" hint="The review queue, the market's state per person, the tier settings and the detectors' thresholds. Every action here is audit-logged." right={<Badge tone="info">actions audit-logged</Badge>}>
      {notice ? (
        <div className="adm-notice" role="status" data-tone={notice.startsWith("Done") ? "ok" : "warn"}>
          {notice}
        </div>
      ) : null}
      <Stats>
        <Stat label="Open alerts" value={num(report.open.length)} tone={report.open.length > 0 ? "warn" : "ok"} sub="open or reviewing" />
        <Stat label="Halted" value={num(halted)} tone={halted > 0 ? "warn" : "plain"} sub="people with a live halt" />
        <Stat label="Not tradeable" value={num(notTradeable)} tone={notTradeable > 0 ? "info" : "plain"} sub="display-only or paused" />
        <Stat label="Carrying a premium" value={`${num(withPremium)} / ${num(report.people.length)}`} sub="market price off the score right now" />
        <Stat label="Frozen accounts" value={num(report.frozen.length)} tone={report.frozen.length > 0 ? "warn" : "plain"} />
        <Stat label="Excluded parties" value={num(report.excluded.length)} />
      </Stats>

      <div className="adm-body">
        <p className="adm-sub">Review queue</p>
        {report.open.length === 0 ? <Empty>No open alert. The detectors run on every fill; a finding at or over its threshold lands here.</Empty> : report.open.map((alert) => <AlertCard key={alert.id} alert={alert} people={report.people} now={now} />)}

        {report.closed.length > 0 ? (
          <>
            <p className="adm-sub" style={{ marginTop: 16 }}>
              Recently closed
            </p>
            <Scroll>
              <table className="adm-t">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Severity</th>
                    <th>Person</th>
                    <th className="n">Accounts</th>
                    <th>Status</th>
                    <th className="wrap">Resolution</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {report.closed.map((alert) => (
                    <tr key={alert.id}>
                      <td className="adm-k">{stamp(alert.resolvedAt ?? alert.updatedAt)}</td>
                      <td className="adm-k">{alert.type}</td>
                      <td>
                        <Badge tone={severityTone[alert.severity] ?? "plain"}>{alert.severity}</Badge>
                      </td>
                      <td>{alert.personSlug ?? "—"}</td>
                      <td className="n">{num(alert.users.length)}</td>
                      <td>
                        <Badge tone={statusTone[alert.status] ?? "plain"}>{alert.status}</Badge>
                      </td>
                      <td className="wrap">{alert.resolutionNote ?? "—"}</td>
                      <td>
                        <form action={marketAction} className="adm-form">
                          <input type="hidden" name="action" value="alert_status" />
                          <input type="hidden" name="alert_id" value={alert.id} />
                          <input type="hidden" name="status" value="open" />
                          <input type="hidden" name="note" value="Reopened from the console." />
                          <button type="submit" className="adm-btn">
                            Reopen
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          </>
        ) : null}

        <p className="adm-sub" style={{ marginTop: 16 }}>
          Market state, per person
        </p>
        <Scroll>
          <table className="adm-t">
            <thead>
              <tr>
                <th>Person</th>
                <th>Tier</th>
                <th>Mode</th>
                <th className="n">Score</th>
                <th className="n">Premium</th>
                <th className="n">Market</th>
                <th className="n">Inventory</th>
                <th>Halt</th>
                <th>Overrides</th>
                <th className="wrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {report.people.map((person) => (
                <PersonRow key={person.id} person={person} now={now} />
              ))}
            </tbody>
          </table>
        </Scroll>
        <p className="adm-note">
          <b>Premium</b> is trunc(inventory × 100 / depth) in cents a share; <b>Market</b> is the score plus it. A halt refuses every order until it lapses or is lifted; <b>display_only</b>{" "}
          shows the score and lets holders close; <b>paused</b> refuses everything. Depth, half-life and caps are the tier&rsquo;s unless an override is set on the row (by migration).
        </p>

        <div className="adm-cols" style={{ marginTop: 16 }}>
          <div>
            <p className="adm-sub">Frozen accounts</p>
            {report.frozen.length === 0 ? (
              <Empty>None.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Since</th>
                      <th className="wrap">Reason</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.frozen.map((account) => (
                      <tr key={account.id}>
                        <td>{account.username}</td>
                        <td>{age(account.frozenAt, now)}</td>
                        <td className="wrap">{account.reason ?? "—"}</td>
                        <td>
                          <form action={marketAction} className="adm-form">
                            <input type="hidden" name="action" value="unfreeze" />
                            <input type="hidden" name="user_id" value={account.id} />
                            <input name="note" placeholder="note" aria-label="Unfreeze note" />
                            <button type="submit" className="adm-btn">
                              Unfreeze
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
            <form action={marketAction} className="adm-form" style={{ marginTop: 8 }}>
              <input type="hidden" name="action" value="freeze" />
              <input name="user_id" placeholder="account id (uuid)" aria-label="Account id to freeze" required style={{ width: 300 }} />
              <input name="note" placeholder="reason (required)" aria-label="Freeze reason" required />
              <button type="submit" className="adm-btn" data-tone="bad">
                Freeze account
              </button>
            </form>
          </div>

          <div>
            <p className="adm-sub">Excluded parties</p>
            {report.excluded.length === 0 ? (
              <Empty>None. An excluded party cannot trade one market (a person) or any (blank).</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Market</th>
                      <th>Since</th>
                      <th className="wrap">Reason</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.excluded.map((row) => (
                      <tr key={row.id}>
                        <td>{row.username ?? row.userId}</td>
                        <td>{row.personSlug ?? <Badge tone="warn">every market</Badge>}</td>
                        <td>{age(row.createdAt, now)}</td>
                        <td className="wrap">{row.reason}</td>
                        <td>
                          <form action={marketAction} className="adm-form">
                            <input type="hidden" name="action" value="unexclude" />
                            <input type="hidden" name="excluded_party_id" value={row.id} />
                            <input name="note" placeholder="note" aria-label="Removal note" />
                            <button type="submit" className="adm-btn">
                              Remove
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
            <form action={marketAction} className="adm-form" style={{ marginTop: 8 }}>
              <input type="hidden" name="action" value="exclude" />
              <input name="user_id" placeholder="account id (uuid)" aria-label="Account id to exclude" required style={{ width: 300 }} />
              <select name="person_id" aria-label="Market to exclude from" defaultValue="">
                <option value="">every market</option>
                {report.people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.slug}
                  </option>
                ))}
              </select>
              <input name="note" placeholder="reason (required)" aria-label="Exclusion reason" required />
              <button type="submit" className="adm-btn" data-tone="bad">
                Exclude
              </button>
            </form>
          </div>
        </div>

        <div className="adm-cols" style={{ marginTop: 16 }}>
          <div>
            <p className="adm-sub">Tier settings</p>
            <Scroll>
              <table className="adm-t">
                <thead>
                  <tr>
                    <th>Setting</th>
                    {report.tiers.map((tier) => (
                      <th key={tier.tier} className="n">
                        {tier.tier}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["Depth (units / point)", (t) => (t.depthUnits === null ? "OFF (flat)" : num(t.depthUnits))],
                      ["Premium half-life", (t) => `${num(t.halfLifeTicks)} ticks (${(t.halfLifeTicks / 120).toFixed(1)} h)`],
                      ["Premium cap", (t) => `${(t.premiumCapCents / 100).toFixed(2)} pts`],
                      ["Min hold", (t) => `${num(t.minHoldSeconds)} s`],
                      ["Max order (share of depth)", (t) => String(t.maxOrderShareOfDepth)],
                      ["Aggregate exposure cap", (t) => `${num(t.aggregateExposureCapUnits)} units`],
                      ["Premium breaker", (t) => `${(t.breakerPremiumCents / 100).toFixed(2)} pts / ${num(t.breakerWindowSeconds)} s → halt ${num(t.breakerHaltSeconds)} s`],
                      ["Price breaker", (t) => (t.breakerPriceCents === null ? "off" : `${(t.breakerPriceCents / 100).toFixed(2)} pts / ${num(t.breakerWindowSeconds)} s`)],
                      ["Shorting allowed", (t) => (t.shortingAllowed ? "yes" : "no")],
                      ["Alert on halt", (t) => (t.alertOnHalt ? "yes" : "no")],
                      ["Updated", (t) => stamp(t.updatedAt)],
                    ] as Array<[string, (tier: MarketReport["tiers"][number]) => string]>
                  ).map(([label, render]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      {report.tiers.map((tier) => (
                        <td key={tier.tier} className="n">
                          {render(tier)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
            <p className="adm-note">
              Read-only here; changed by migration on <code>market_tier_settings</code>. A NULL depth is the tier&rsquo;s off switch: a flat market with no premium and no impact,
              Phase 27 pricing exactly, with no deploy. The exposure cap counts HOLDINGS while decay erases INVENTORY, so a popular person can sit at the cap with the
              premium at zero; it is a share-count cap to be replaced before a real user base arrives (design notes).
            </p>
          </div>

          <div>
            <p className="adm-sub">Detector thresholds</p>
            <Scroll>
              <table className="adm-t">
                <thead>
                  <tr>
                    <th>Detector</th>
                    <th className="n">Threshold</th>
                    <th className="wrap">What it reads</th>
                  </tr>
                </thead>
                <tbody>
                  {report.thresholds.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td className="n">{row.value}</td>
                      <td className="wrap">{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>

            <p className="adm-sub" style={{ marginTop: 16 }}>
              House book
            </p>
            {report.house.length === 0 ? (
              <Empty>No row yet. A close writes score_move + premium_change + spread_and_impact (= −P&amp;L, exactly); a decay step writes decay_mark.</Empty>
            ) : (
              <Scroll>
                <table className="adm-t">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th className="n">24 h</th>
                      <th className="n">All time</th>
                      <th className="n">Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.house.map((row) => (
                      <tr key={row.category}>
                        <td className="adm-k">{row.category}</td>
                        <td className="n">{money(row.dayCents)}</td>
                        <td className="n">{money(row.allTimeCents)}</td>
                        <td className="n">{num(row.rows)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td className="n">{money(report.house.reduce((total, row) => total + row.dayCents, 0))}</td>
                      <td className="n">{money(report.house.reduce((total, row) => total + row.allTimeCents, 0))}</td>
                      <td className="n">{num(report.house.reduce((total, row) => total + row.rows, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </Scroll>
            )}
          </div>
        </div>

        <p className="adm-sub" style={{ marginTop: 16 }}>
          Surveillance stream
        </p>
        {report.events.length === 0 ? (
          <Empty>No reading yet. Every detector reading is recorded, whether or not it reached its threshold.</Empty>
        ) : (
          <Scroll>
            <table className="adm-t">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Detector</th>
                  <th>Severity</th>
                  <th>Person</th>
                  <th className="n">Accounts</th>
                  <th>Alert</th>
                  <th className="wrap">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {report.events.map((event) => (
                  <tr key={event.id}>
                    <td className="adm-k">{stamp(event.recordedAt)}</td>
                    <td className="adm-k">{event.detector}</td>
                    <td>
                      <Badge tone={severityTone[event.severity] ?? "plain"}>{event.severity}</Badge>
                    </td>
                    <td>{event.personSlug ?? "—"}</td>
                    <td className="n">{num(event.accounts)}</td>
                    <td className="adm-k adm-dim">{event.alertId ? event.alertId.slice(0, 8) : "—"}</td>
                    <td className="wrap adm-k">{evidenceText(event.evidence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}

        <p className="adm-sub" style={{ marginTop: 16 }}>
          Audit log
        </p>
        {report.audit.length === 0 ? (
          <Empty>No operator action yet. This table is append-only: rows are never updated or deleted, whatever the role.</Empty>
        ) : (
          <Scroll>
            <table className="adm-t">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Operator</th>
                  <th>Action</th>
                  <th>Account</th>
                  <th>Person</th>
                  <th>Alert</th>
                  <th className="wrap">Note</th>
                  <th className="wrap">Details</th>
                </tr>
              </thead>
              <tbody>
                {report.audit.map((row) => (
                  <tr key={row.id}>
                    <td className="adm-k">{stamp(row.performedAt)}</td>
                    <td>{row.actor}</td>
                    <td className="adm-k">{row.action}</td>
                    <td>{row.targetUser ?? "—"}</td>
                    <td>{row.targetPersonSlug ?? "—"}</td>
                    <td className="adm-k adm-dim">{row.alertId ? row.alertId.slice(0, 8) : "—"}</td>
                    <td className="wrap">{row.note ?? "—"}</td>
                    <td className="wrap adm-k">{evidenceText(row.details) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </div>
    </Panel>
  );
}

function AlertCard({ alert, people, now }: { alert: AlertRow; people: MarketPersonRow[]; now: number }) {
  const person = alert.personId ? (people.find((row) => row.id === alert.personId) ?? null) : null;
  return (
    <div className="adm-alert" data-severity={alert.severity}>
      <div className="adm-alert-head">
        <Badge tone={severityTone[alert.severity] ?? "plain"}>{alert.severity}</Badge>
        <b className="adm-k">{alert.type}</b>
        <Badge tone={statusTone[alert.status] ?? "plain"}>{alert.status}</Badge>
        <span className="adm-dim">
          {alert.personSlug ? `on ${alert.personSlug}` : "no person"} · raised {age(alert.createdAt, now)} · updated {age(alert.updatedAt, now)}
        </span>
        <span className="adm-k adm-dim" style={{ marginLeft: "auto" }}>
          {alert.id}
        </span>
      </div>
      <div className="adm-alert-body">
        <div>
          <p className="adm-sub">Accounts</p>
          {alert.users.length === 0 ? (
            <span className="adm-dim">none named</span>
          ) : (
            <ul className="adm-list">
              {alert.users.map((user) => (
                <li key={user.id}>
                  <span>{user.username ?? user.id}</span> {user.frozen ? <Badge tone="warn">frozen</Badge> : null}
                  {!user.frozen ? (
                    <form action={marketAction} className="adm-form">
                      <input type="hidden" name="action" value="freeze" />
                      <input type="hidden" name="user_id" value={user.id} />
                      <input type="hidden" name="alert_id" value={alert.id} />
                      <input name="note" placeholder="reason" aria-label={`Reason to freeze ${user.username ?? user.id}`} required />
                      <button type="submit" className="adm-btn" data-tone="bad">
                        Freeze
                      </button>
                    </form>
                  ) : null}
                  {person ? (
                    <form action={marketAction} className="adm-form">
                      <input type="hidden" name="action" value="exclude" />
                      <input type="hidden" name="user_id" value={user.id} />
                      <input type="hidden" name="person_id" value={person.id} />
                      <input type="hidden" name="alert_id" value={alert.id} />
                      <input name="note" placeholder="reason" aria-label={`Reason to exclude ${user.username ?? user.id} from ${person.slug}`} required />
                      <button type="submit" className="adm-btn">
                        Exclude from {person.slug}
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="adm-sub">Evidence</p>
          <p className="adm-k adm-dim" style={{ margin: 0, whiteSpace: "normal" }}>
            {evidenceText(alert.evidence) || "—"}
          </p>
          {person ? (
            <>
              <p className="adm-sub" style={{ marginTop: 10 }}>
                {person.slug}
              </p>
              <p className="adm-dim" style={{ margin: 0 }}>
                score {person.score.toFixed(2)} · premium {(person.premiumCents / 100).toFixed(2)} · mode {person.tradingMode}
                {person.haltedUntil ? ` · halted ${age(person.haltedUntil, now).replace(" ago", "")} more` : ""}
              </p>
              <div className="adm-form" style={{ marginTop: 6 }}>
                {person.haltedUntil ? (
                  <form action={marketAction} className="adm-form">
                    <input type="hidden" name="action" value="lift_halt" />
                    <input type="hidden" name="person_id" value={person.id} />
                    <input type="hidden" name="alert_id" value={alert.id} />
                    <input name="note" placeholder="note" aria-label="Lift note" />
                    <button type="submit" className="adm-btn">
                      Lift halt
                    </button>
                  </form>
                ) : (
                  <form action={marketAction} className="adm-form">
                    <input type="hidden" name="action" value="halt" />
                    <input type="hidden" name="person_id" value={person.id} />
                    <input type="hidden" name="alert_id" value={alert.id} />
                    <input name="minutes" type="number" min={1} defaultValue={30} aria-label="Halt minutes" style={{ width: 64 }} />
                    <input name="note" placeholder="reason" aria-label="Halt reason" required />
                    <button type="submit" className="adm-btn" data-tone="bad">
                      Halt
                    </button>
                  </form>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="adm-alert-foot">
        {alert.status === "open" ? (
          <form action={marketAction} className="adm-form">
            <input type="hidden" name="action" value="alert_status" />
            <input type="hidden" name="alert_id" value={alert.id} />
            <input type="hidden" name="status" value="reviewing" />
            <input type="hidden" name="note" value="" />
            <button type="submit" className="adm-btn">
              Mark reviewing
            </button>
          </form>
        ) : null}
        <form action={marketAction} className="adm-form">
          <input type="hidden" name="action" value="alert_status" />
          <input type="hidden" name="alert_id" value={alert.id} />
          <input name="note" placeholder="resolution note (required)" aria-label="Resolution note" required style={{ width: 320 }} />
          <button type="submit" name="status" value="resolved" className="adm-btn" data-tone="ok">
            Resolve
          </button>
          <button type="submit" name="status" value="dismissed" className="adm-btn">
            Dismiss
          </button>
        </form>
      </div>
    </div>
  );
}

function PersonRow({ person, now }: { person: MarketPersonRow; now: number }) {
  const overrides = [
    person.overrides.depthUnits !== null ? `depth ${num(person.overrides.depthUnits)}` : null,
    person.overrides.halfLifeTicks !== null ? `half-life ${num(person.overrides.halfLifeTicks)}` : null,
    person.overrides.premiumCapCents !== null ? `cap ${(person.overrides.premiumCapCents / 100).toFixed(2)}` : null,
    person.overrides.shorting !== null ? `shorting ${person.overrides.shorting ? "on" : "off"}` : null,
  ].filter((item): item is string => item !== null);
  return (
    <tr>
      <td>
        {person.displayName} <span className="adm-dim adm-k">{person.slug}</span>
      </td>
      <td className="adm-k">{person.tier}</td>
      <td>{person.tradingMode === "tradeable" ? <span className="adm-dim">tradeable</span> : <Badge tone="info">{person.tradingMode}</Badge>}</td>
      <td className="n">{person.score.toFixed(2)}</td>
      <td className="n">{person.premiumCents === 0 ? "—" : (person.premiumCents / 100).toFixed(2)}</td>
      <td className="n">{person.marketPrice.toFixed(2)}</td>
      <td className="n">{person.inventoryUnits === 0 ? "—" : num(person.inventoryUnits)}</td>
      <td>
        {person.haltedUntil ? (
          <span>
            <Badge tone="warn">halted</Badge> <span className="adm-dim">until {stamp(person.haltedUntil)}</span>
            {person.haltReason ? <span className="adm-dim"> · {person.haltReason}</span> : null}
          </span>
        ) : (
          <span className="adm-dim">—</span>
        )}
      </td>
      <td className="adm-k adm-dim">{overrides.length > 0 ? overrides.join(" · ") : "—"}</td>
      <td className="wrap">
        <div className="adm-form">
          <form action={marketAction} className="adm-form">
            <input type="hidden" name="action" value="set_mode" />
            <input type="hidden" name="person_id" value={person.id} />
            <select name="mode" defaultValue={person.tradingMode} aria-label={`Trading mode for ${person.slug}`}>
              <option value="tradeable">tradeable</option>
              <option value="display_only">display_only</option>
              <option value="paused">paused</option>
            </select>
            <input name="note" placeholder="reason" aria-label={`Reason for the mode change on ${person.slug}`} required />
            <button type="submit" className="adm-btn">
              Set mode
            </button>
          </form>
          {person.haltedUntil ? (
            <form action={marketAction} className="adm-form">
              <input type="hidden" name="action" value="lift_halt" />
              <input type="hidden" name="person_id" value={person.id} />
              <input name="note" placeholder="note" aria-label={`Lift note for ${person.slug}`} />
              <button type="submit" className="adm-btn">
                Lift halt
              </button>
            </form>
          ) : (
            <form action={marketAction} className="adm-form">
              <input type="hidden" name="action" value="halt" />
              <input type="hidden" name="person_id" value={person.id} />
              <input name="minutes" type="number" min={1} defaultValue={30} aria-label={`Halt minutes for ${person.slug}`} style={{ width: 64 }} />
              <input name="note" placeholder="reason" aria-label={`Halt reason for ${person.slug}`} required />
              <button type="submit" className="adm-btn" data-tone="bad">
                Halt
              </button>
            </form>
          )}
        </div>
        <span className="adm-dim adm-k">{person.haltedUntil ? `lapses ${age(person.haltedUntil, now).replace(" ago", "")} from now` : ""}</span>
      </td>
    </tr>
  );
}
