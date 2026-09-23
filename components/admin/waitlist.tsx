import type { WaitlistReport } from "@/lib/admin/data";

import { Empty, Panel, Scroll, Stat, Stats, age, num, stamp } from "./primitives";

/**
 * f) THE WAITLIST (Phase 28).
 *
 * How many have asked for a seat, how fast they are arriving, and the latest
 * twenty-five with where they came from. The only place an address is ever
 * shown, and it is the operator's console behind the admin flag.
 */
export function WaitlistSection({ report, now }: { report: WaitlistReport; now: number }) {
  return (
    <Panel id="waitlist" title="Waitlist" hint="Sign-ups from the landing page. One row per address; the position a visitor was shown is this table's row count at the time.">
      <Stats>
        <Stat label="On the list" value={num(report.total)} />
        <Stat label="Last 24 hours" value={num(report.last24h)} tone={report.last24h > 0 ? "ok" : "plain"} />
        <Stat label="Last 7 days" value={num(report.last7d)} />
        <Stat label="Latest" value={report.latest[0] ? age(report.latest[0].createdAt, now) : "—"} sub={report.latest[0] ? stamp(report.latest[0].createdAt) : undefined} />
      </Stats>

      <div className="adm-body">
        {report.latest.length === 0 ? (
          <Empty>Nobody yet. The form is live; the first sign-up appears here.</Empty>
        ) : (
          <Scroll>
            <table className="adm-t">
              <thead>
                <tr>
                  <th className="n">#</th>
                  <th>Email</th>
                  <th>Joined</th>
                  <th>Form</th>
                  <th>Campaign</th>
                  <th>Referrer</th>
                </tr>
              </thead>
              <tbody>
                {report.latest.map((row) => (
                  <tr key={row.id}>
                    <td className="n">{num(row.position)}</td>
                    <td className="adm-k">{row.email}</td>
                    <td>
                      {age(row.createdAt, now)} <span className="adm-dim adm-k">{stamp(row.createdAt)}</span>
                    </td>
                    <td className="adm-k">{row.source ?? "—"}</td>
                    <td className="adm-k">{row.campaign ?? "—"}</td>
                    <td className="adm-k">{row.referrerHost ?? "—"}</td>
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
