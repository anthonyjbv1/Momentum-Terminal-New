import type { InviteRow, SignupReport } from "@/lib/admin/data";
import { MAX_TYPED_INVITES, MAX_WAITLIST_INVITES } from "@/lib/invites/admin-form";
import { issueInvitesAction, resendInviteAction, revokeInviteAction } from "@/app/admin/invite-actions";

import { Badge, Empty, Panel, Scroll, Stat, Stats, age, num, stamp, type Tone } from "./primitives";

/**
 * h) SIGN-UP (Phase 32).
 *
 * The switch first: whether the invite-only door is open in this
 * environment, whether Google is offered, whether the email key is present
 * (by name, never its value). Then the invite form, every invite with its
 * status and the three things an operator can do to one (resend, revoke),
 * and every member with where they came from. Sending is refused while the
 * switch is off; the form says so rather than disappearing.
 */

const STATUS_TONE: Record<InviteRow["status"], Tone> = { pending: "info", accepted: "ok", revoked: "plain", expired: "warn" };

export function SignupSection({ report, now, notice }: { report: SignupReport; now: number; notice: string | null }) {
  const { switches } = report;
  const canSend = switches.betaSignup && switches.resendKeySet;
  return (
    <Panel id="signup" title="Sign-up" hint="The invite-only door. Invites are single-use links for one address; accepting one records the 18+ attestation and the Terms and Privacy versions.">
      <p className="adm-notice" role="status" data-tone={switches.betaSignup ? "ok" : "warn"}>
        BETA_SIGNUP_ENABLED is {switches.betaSignup ? '"true": the join page, onboarding and the member profile are live here.' : 'off (not exactly "true"): no public path in, and the app is as before Phase 32.'}{" "}
        GOOGLE_AUTH_ENABLED is {switches.googleAuth ? "on" : "off"}. RESEND_API_KEY is {switches.resendKeySet ? "set" : "not set"}. Links point at {switches.siteOrigin}.
      </p>
      {notice ? (
        <p className="adm-notice" role="status" data-tone={notice.startsWith("Issued") || notice.startsWith("Resent") || notice.startsWith("Revoked") ? "ok" : "warn"}>
          {notice}
        </p>
      ) : null}

      <Stats>
        <Stat label="Pending" value={num(report.inviteCounts.pending)} tone={report.inviteCounts.pending > 0 ? "info" : "plain"} />
        <Stat label="Accepted" value={num(report.inviteCounts.accepted)} tone={report.inviteCounts.accepted > 0 ? "ok" : "plain"} />
        <Stat label="Expired" value={num(report.inviteCounts.expired)} tone={report.inviteCounts.expired > 0 ? "warn" : "plain"} />
        <Stat label="Revoked" value={num(report.inviteCounts.revoked)} />
        <Stat label="Members" value={report.members ? num(report.members.filter((m) => !m.deleted).length) : "—"} sub={report.members ? `${num(report.members.filter((m) => m.deleted).length)} deleted` : undefined} />
      </Stats>

      <div className="adm-body">
        <form action={issueInvitesAction} className="adm-form" data-stack>
          <fieldset disabled={!canSend}>
            <textarea name="emails" placeholder={`Addresses to invite, up to ${MAX_TYPED_INVITES}: one per line, or separated by commas`} aria-label="Addresses to invite" />
            <span>
              and the oldest{" "}
              <input name="from_waitlist" type="number" min={0} max={MAX_WAITLIST_INVITES} defaultValue={0} aria-label="How many from the waitlist" style={{ width: 56 }} /> on the waitlist
              without an open invite{" "}
              <button type="submit" className="adm-btn" data-tone="ok">
                Send invites
              </button>
            </span>
          </fieldset>
          {!canSend ? (
            <small className="adm-note">
              {!switches.betaSignup ? 'Sending is off until BETA_SIGNUP_ENABLED is "true" here: a link would lead to a page that does not exist.' : "Sending needs RESEND_API_KEY in this environment."}
            </small>
          ) : null}
        </form>
      </div>

      <div className="adm-body">
        <p className="adm-sub">Invites</p>
        {report.unavailable ? (
          <Empty>Could not read invites and members: {report.unavailable}. (Before the Phase 32 migration is applied, the lists do not exist yet.)</Empty>
        ) : !report.invites || report.invites.length === 0 ? (
          <Empty>No invites yet.</Empty>
        ) : (
          <Scroll>
            <table className="adm-t">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Issued</th>
                  <th>By</th>
                  <th>From</th>
                  <th>Sent</th>
                  <th>Expires</th>
                  <th>Accepted</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {report.invites.map((row) => (
                  <tr key={row.id}>
                    <td className="adm-k">{row.email ?? <span className="adm-dim">scrubbed (account deleted)</span>}</td>
                    <td>
                      <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                    </td>
                    <td>
                      {age(row.createdAt, now)} <span className="adm-dim adm-k">{stamp(row.createdAt)}</span>
                    </td>
                    <td className="adm-k">{row.invitedBy ?? "—"}</td>
                    <td className="adm-k">
                      {row.fromWaitlist ? "waitlist" : "typed"}
                      {row.referrer ? <span className="adm-dim"> · referred by {row.referrer}</span> : null}
                    </td>
                    <td className="adm-k">
                      {row.sentAt ? `${num(row.sendCount)}× · ${age(row.sentAt, now)}` : "not sent"}
                      {row.lastSendError ? <div style={{ color: "var(--adm-bad)" }}>{row.lastSendError}</div> : null}
                    </td>
                    <td className="adm-k">{stamp(row.expiresAt)}</td>
                    <td className="adm-k">{row.acceptedAt ? `${row.acceptedUsername ?? "deleted"} · ${stamp(row.acceptedAt)}` : "—"}</td>
                    <td>
                      {row.status === "pending" || row.status === "expired" ? (
                        <span style={{ display: "inline-flex", gap: 4 }}>
                          <form action={resendInviteAction} className="adm-form">
                            <input type="hidden" name="invite_id" value={row.id} />
                            <button type="submit" className="adm-btn" disabled={!canSend}>
                              Resend
                            </button>
                          </form>
                          <form action={revokeInviteAction} className="adm-form">
                            <input type="hidden" name="invite_id" value={row.id} />
                            <input name="note" placeholder="note" aria-label="Revoke note" style={{ width: 90 }} />
                            <button type="submit" className="adm-btn" data-tone="bad">
                              Revoke
                            </button>
                          </form>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </div>

      {report.members ? (
        <div className="adm-body">
          <p className="adm-sub">Members</p>
          <Scroll>
            <table className="adm-t">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Joined</th>
                  <th>Invited by</th>
                  <th>Invited</th>
                  <th>Referred by</th>
                  <th>Source</th>
                  <th>Onboarded</th>
                  <th>Last sign-in</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {report.members.map((row) => (
                  <tr key={row.id}>
                    <td className="adm-k">
                      {row.deleted ? <span className="adm-dim">deleted account</span> : row.username}
                      {row.isAdmin ? <span className="adm-dim"> · operator</span> : null}
                    </td>
                    <td>
                      {age(row.joinedAt, now)} <span className="adm-dim adm-k">{stamp(row.joinedAt)}</span>
                    </td>
                    <td className="adm-k">{row.invitedBy ?? "—"}</td>
                    <td className="adm-k">{row.invitedAt ? stamp(row.invitedAt) : "—"}</td>
                    <td className="adm-k">{row.referredBy ?? "—"}</td>
                    <td className="adm-k">{row.source}</td>
                    <td className="adm-k">{row.onboarded ? "yes" : "no"}</td>
                    <td className="adm-k">{row.lastSignInAt ? age(row.lastSignInAt, now) : "—"}</td>
                    <td>{row.deleted ? <Badge>deleted</Badge> : row.frozen ? <Badge tone="bad">frozen</Badge> : <Badge tone="ok">active</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        </div>
      ) : null}
    </Panel>
  );
}
