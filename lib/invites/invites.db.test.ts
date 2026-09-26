import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/lib/__tests__/pglite";
import { PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal/versions";

import { hashInviteToken, newInviteToken } from "./token";

/**
 * PHASE 32, against a real Postgres with every migration applied verbatim.
 *
 * GoTrue is the one piece not here: an insert into auth.users stands in for
 * it, exactly as it drives the on_auth_user_created trigger in production.
 * Every test in this file turns the operator's bypass OFF for its session
 * (the harness turns it on for the trading suites, which make users freely),
 * so the invite rule is the rule under test.
 *
 * The path, end to end: the operator issues an invite → the join page reads
 * it → the visitor attests (18+, Terms, Privacy, a username) → the account is
 * created from the invite → onboarding (follows, a forecast, the mark) →
 * activity → deletion, after which the ledger still reconciles to the cent.
 */

let database: TestDatabase;
const people = new Map<string, string>();
let operator: string;

async function asOperator<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await database.actAs(operator);
  return database.rows<T>(sql, params);
}

async function issue(emails: string[], fromWaitlist = 0): Promise<{ created: Array<{ id: string; email: string; token: string }>; skipped: Array<{ email: string; reason: string }> }> {
  const tokens = Array.from({ length: emails.length + fromWaitlist }, () => newInviteToken());
  const [{ r }] = await asOperator<{ r: { created: Array<{ id: string; email: string; token_index: number }>; skipped: Array<{ email: string; reason: string }> } }>(
    "select public.admin_issue_invites($1::text[], $2, $3::text[], 14) as r",
    [emails, fromWaitlist, tokens.map((t) => t.hash)],
  );
  return { created: r.created.map((row) => ({ id: row.id, email: row.email, token: tokens[row.token_index - 1].token })), skipped: r.skipped };
}

async function lookup(token: string): Promise<Record<string, unknown> | null> {
  const [{ r }] = await database.rows<{ r: Record<string, unknown> | null }>("select public.invite_for_token($1) as r", [hashInviteToken(token)]);
  return r;
}

async function attest(token: string, username: string, age = true, terms: string | null = TERMS_VERSION): Promise<Record<string, unknown>> {
  const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.invite_attest($1, $2, $3, $4, $5, $6) as r", [hashInviteToken(token), username, "Test Person", age, terms, PRIVACY_VERSION]);
  return r;
}

/** GoTrue creating the auth user: the trigger decides. */
async function signUp(email: string): Promise<string> {
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return row.id;
}

async function refusedSignUp(email: string): Promise<string> {
  try {
    await signUp(email);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected ${email} to be refused`);
}

async function reconcile(userId: string): Promise<{ cash: number; openCost: number; realized: number; credit: number }> {
  const [row] = await database.rows<{ cash: string; open_cost: string; realized: string; credit: string }>(
    `select u.wallet_balance_cents::text as cash,
            coalesce((select sum(l.open_cost_cents) from public.positions l where l.user_id = u.id and l.is_open), 0)::text as open_cost,
            coalesce((select sum(c.pnl_cents) from public.position_closes c where c.user_id = u.id), 0)::text as realized,
            coalesce((select sum(case when t.type = 'DEPOSIT' then t.amount_cents when t.type = 'WITHDRAWAL' then -t.amount_cents else 0 end)
                        from public.transactions t where t.user_id = u.id), 0)::text as credit
       from public.users u where u.id = $1`,
    [userId],
  );
  return { cash: Number(row.cash), openCost: Number(row.open_cost), realized: Number(row.realized), credit: Number(row.credit) };
}

beforeAll(async () => {
  database = await createTestDatabase();
  for (const row of await database.rows<{ id: string; slug: string }>("select id, slug from public.people")) people.set(row.slug, row.id);
  // The operator exists before the rule does, as in production.
  const [row] = await database.rows<{ id: string }>("insert into auth.users (email) values ('operator@example.com') returning id");
  operator = row.id;
  await database.rows("update public.users set is_admin = true where id = $1", [operator]);
  // From here on, every new auth user must come through an invite.
  await database.exec("select set_config('momentum.signup_without_invite', 'off', false)");
  await database.rows("update public.platform_settings set close_cooldown_seconds = 0, updated_at = now() where id");
  await database.exec("update public.market_tier_settings set pricing_mode = 'flat', min_hold_seconds = 0");
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe("the door is shut without an invite", () => {
  it("refuses an auth user whose address has no invite, and leaves nothing behind", async () => {
    const message = await refusedSignUp("stranger@example.com");
    expect(message).toMatch(/signup_requires_invite/);
    const [{ n }] = await database.rows<{ n: number }>("select count(*)::int as n from public.users where email = 'stranger@example.com'");
    expect(n).toBe(0);
  });

  it("refuses an invited address that has not attested on the join page (Google straight from the login page, say)", async () => {
    await issue(["unattested@example.com"]);
    expect(await refusedSignUp("unattested@example.com")).toMatch(/signup_requires_attestation/);
  });
});

describe("issuing invites", () => {
  it("is the operator's alone", async () => {
    // A plain member, made through the operator's bypass for this one insert.
    await database.exec("select set_config('momentum.signup_without_invite', 'on', false)");
    const [{ id: member }] = await database.rows<{ id: string }>("insert into auth.users (email) values ('plain-member@example.com') returning id");
    await database.exec("select set_config('momentum.signup_without_invite', 'off', false)");
    await database.actAs(member);
    await expect(database.rows("select public.admin_issue_invites(array['x@example.com'], 0, array[$1], 14)", [newInviteToken().hash])).rejects.toThrow(/Not an admin/);
    await database.actAs(null);
    await expect(database.rows("select public.admin_issue_invites(array['x@example.com'], 0, array[$1], 14)", [newInviteToken().hash])).rejects.toThrow(/Not authenticated/);
  });

  it("takes typed addresses and the waitlist's oldest, skips members, the invalid and the already invited, and stores only hashes", async () => {
    // A member's referral link put this visitor on the list.
    const [{ code }] = await database.rows<{ code: string }>("select referral_code as code from public.users where id = $1", [operator]);
    expect(code).toMatch(/^[a-hj-km-np-z2-9]{8}$/);
    await database.rows("select public.join_waitlist('first@example.com', 'landing_hero', '{\"source\":\"x\",\"campaign\":\"launch\"}'::jsonb, 'https://news.example.com/story?id=1', $1)", [code]);
    await database.rows("select public.join_waitlist('second@example.com', 'landing_footer', null, null, 'not-a-code')");
    const result = await issue(["Typed@Example.com", "typed@example.com", "operator@example.com", "no-at-sign", "unattested@example.com"], 2);
    expect(result.created.map((row) => row.email).sort()).toEqual(["first@example.com", "second@example.com", "typed@example.com"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { email: "operator@example.com", reason: "member" },
        { email: "no-at-sign", reason: "invalid" },
        { email: "unattested@example.com", reason: "already_invited" },
      ]),
    );
    const stored = await database.rows<{ token_hash: string; email: string; referrer_user_id: string | null; source: Record<string, unknown> }>(
      "select token_hash, email::text as email, referrer_user_id, source from public.invites where email in ('first@example.com', 'second@example.com', 'typed@example.com') order by email",
    );
    for (const row of stored) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      const created = result.created.find((c) => c.email === row.email)!;
      expect(row.token_hash).toBe(hashInviteToken(created.token));
      expect(row.token_hash).not.toContain(created.token);
    }
    // The referral carried from the link to the waitlist row to the invite; a malformed code was dropped.
    expect(stored[0]).toMatchObject({ email: "first@example.com", referrer_user_id: operator, source: { form: "landing_hero", utm_campaign: "launch", referrer_host: "news.example.com", ref_code: code } });
    expect(stored[1].referrer_user_id).toBeNull();
    expect(stored[2].source).toEqual({ form: "operator" });
    // The audit row names invite ids, never an address.
    const [{ details }] = await database.rows<{ details: string }>("select details::text from public.admin_audit_log where action = 'issue_invite' order by id desc limit 1");
    expect(details).not.toMatch(/@/);
    expect(JSON.parse(details).invite_ids).toHaveLength(3);
  });

  it("never gives a client any access to the invites or the consents it does not own", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const [{ ok }] = await database.rows<{ ok: boolean }>("select has_table_privilege($1, 'public.invites', $2) as ok", [role, privilege]);
        expect(ok, `${role} ${privilege} invites`).toBe(false);
      }
      for (const fn of ["public.invite_for_token(text)", "public.invite_attest(text, text, text, boolean, text, text)", "public.admin_user_list(integer)", "public.admin_invite_list(integer)"]) {
        const [{ ok }] = await database.rows<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, fn]);
        expect(ok, `${role} execute ${fn}`).toBe(false);
      }
    }
  });
});

describe("invite → signup → onboarding → profile → deletion", () => {
  let token: string;
  let userId: string;

  it("the join page reads the invite by its token's hash, and nothing else finds it", async () => {
    const { created } = await issue(["journey@example.com"]);
    token = created[0].token;
    expect(await lookup(token)).toMatchObject({ email: "journey@example.com", status: "pending", attested: false });
    expect(await lookup(newInviteToken().token)).toBeNull();
  });

  it("refuses the attestation without the 18+ box, or without the Terms, and records nothing", async () => {
    expect(await attest(token, "journey", false)).toEqual({ ok: false, code: "age_not_attested" });
    expect(await attest(token, "journey", true, null)).toEqual({ ok: false, code: "terms_not_accepted" });
    expect(await attest(token, "operator_taken_name_is_fine", true)).toMatchObject({ ok: true });
    // Re-attesting before the account exists is allowed (a second link, a changed username).
    const [{ username }] = await database.rows<{ username: string }>("select username from public.users where id = $1", [operator]);
    expect(await attest(token, username)).toEqual({ ok: false, code: "username_taken" });
    expect(await attest(token, "journey")).toEqual({ ok: true, email: "journey@example.com" });
  });

  it("creates the account from the invite: username, referral code, consents with versions, the invite accepted", async () => {
    userId = await signUp("journey@example.com");
    const [user] = await database.rows<Record<string, unknown>>("select username, display_name, referral_code, referred_by, signup_source, wallet_balance_cents::text as balance, onboarded_at from public.users where id = $1", [userId]);
    expect(user).toMatchObject({ username: "journey", display_name: "Test Person", referred_by: null, signup_source: { form: "operator" }, onboarded_at: null });
    expect(user.referral_code).toMatch(/^[a-hj-km-np-z2-9]{8}$/);
    expect(Number(user.balance)).toBe(1_000_000);
    const consents = await database.rows<{ kind: string; version: string }>("select kind, version from public.user_consents where user_id = $1 order by kind", [userId]);
    expect(consents).toEqual([
      { kind: "age_18_plus", version: "attestation-v1" },
      { kind: "privacy", version: PRIVACY_VERSION },
      { kind: "terms", version: TERMS_VERSION },
    ]);
    expect(await lookup(token)).toMatchObject({ status: "accepted" });
    const [{ accepted_user_id }] = await database.rows<{ accepted_user_id: string }>("select accepted_user_id from public.invites where token_hash = $1", [hashInviteToken(token)]);
    expect(accepted_user_id).toBe(userId);
  });

  it("refuses the used invite a second time, at the join page and at account creation", async () => {
    expect(await attest(token, "journey2")).toEqual({ ok: false, code: "accepted" });
    expect(await refusedSignUp("journey@example.com")).toMatch(/signup_requires_invite/);
  });

  it("onboarding: follows under RLS, a forecast, the mark", async () => {
    await database.actAs(userId);
    await database.rows("insert into public.follows (user_id, person_id) values ($1, $2), ($1, $3)", [userId, people.get("drake"), people.get("mrbeast")]);
    // Nobody follows on somebody else's behalf.
    await database.exec("begin; set local role authenticated");
    await database.actAs(userId);
    await expect(database.rows("insert into public.follows (user_id, person_id) values ($1, $2)", [operator, people.get("drake")])).rejects.toThrow(/row-level security/);
    await database.exec("rollback");
    const [{ r }] = await database.rows<{ r: { ok: boolean } }>("select public.cast_forecast_vote($1, 'rising', 'cultural') as r", [people.get("drake")]);
    expect(r.ok).toBe(true);
    const [{ at }] = await database.rows<{ at: string | null }>("select public.mark_onboarded() as at");
    expect(at).not.toBeNull();
    // Idempotent: the first mark stands.
    const [{ again }] = await database.rows<{ again: string }>("select public.mark_onboarded() as again");
    expect(new Date(again).getTime()).toBe(new Date(at!).getTime());
  });

  it("trades, so the deletion has a ledger to keep whole", async () => {
    await database.actAs(userId);
    await database.rows("update public.people set current_score = 56.14, spread = 0.5 where slug = 'drake'");
    const buy = await database.rows<{ r: { ok: boolean } }>("select public.place_order($1::uuid, 'BUY', 5000::bigint, null::bigint, 'test', null::bigint, 'milli', 'abababababababababababababababababababababababababababababababab') as r", [people.get("drake")]);
    expect(buy[0].r.ok).toBe(true);
    await database.rows("insert into public.behavioral_events (user_id, event_type, metadata) values ($1, 'view_portfolio', '{}'::jsonb)", [userId]);
  });

  it("refuses deletion while a position is open", async () => {
    await database.actAs(userId);
    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.delete_my_account() as r");
    expect(r).toMatchObject({ ok: false, code: "open_positions" });
  });

  it("deletes: personal data gone, the auth account gone, the money rows kept and reconciling to the cent", async () => {
    await database.actAs(userId);
    await database.rows("update public.people set current_score = 57.00 where slug = 'drake'");
    const sell = await database.rows<{ r: { ok: boolean } }>("select public.place_order($1::uuid, 'SELL', 5000::bigint, null::bigint, 'test', null::bigint, 'milli', 'abababababababababababababababababababababababababababababababab') as r", [people.get("drake")]);
    expect(sell[0].r.ok).toBe(true);

    const before = await reconcile(userId);
    expect(before.cash + before.openCost - before.realized).toBe(before.credit);
    const counts = async () =>
      (
        await database.rows<{ orders: number; lots: number; closes: number; txns: number; house: string; votes: number }>(
          `select (select count(*)::int from public.trade_orders where user_id = $1) as orders,
                  (select count(*)::int from public.positions where user_id = $1) as lots,
                  (select count(*)::int from public.position_closes where user_id = $1) as closes,
                  (select count(*)::int from public.transactions where user_id = $1) as txns,
                  (select coalesce(sum(amount_cents), 0)::text from public.house_ledger where user_id = $1) as house,
                  (select count(*)::int from public.forecast_votes where user_id = $1) as votes`,
          [userId],
        )
      )[0];
    const kept = await counts();
    expect(kept.orders).toBe(2);

    await database.actAs(userId);
    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.delete_my_account() as r");
    expect(r).toMatchObject({ ok: true });

    // The auth account (and in production its identities, sessions and tokens by cascade).
    const [{ auth }] = await database.rows<{ auth: number }>("select count(*)::int as auth from auth.users where id = $1", [userId]);
    expect(auth).toBe(0);
    // The stub names nobody.
    const [stub] = await database.rows<Record<string, unknown>>("select email, username, display_name, referral_code, avatar_path, signup_source, deleted_at from public.users where id = $1", [userId]);
    expect(stub.email).toMatch(/^deleted-[0-9a-f]{32}@deleted\.invalid$/);
    expect(stub.username).toMatch(/^deleted_[0-9a-f]{12}$/);
    expect(stub).toMatchObject({ display_name: "Deleted account", referral_code: null, avatar_path: null, signup_source: null });
    expect(stub.deleted_at).not.toBeNull();
    // Fingerprints, the browsing log, follows, the invite's address.
    const [gone] = await database.rows<{ fps: number; events: number; follows: number; invite_email: string | null }>(
      `select (select count(*)::int from public.trade_orders where user_id = $1 and fingerprint_hash is not null) as fps,
              (select count(*)::int from public.behavioral_events where user_id = $1) as events,
              (select count(*)::int from public.follows where user_id = $1) as follows,
              (select email::text from public.invites where accepted_user_id = $1) as invite_email`,
      [userId],
    );
    expect(gone).toEqual({ fps: 0, events: 0, follows: 0, invite_email: null });
    // Every money row and every forecast is still there, and the books still close.
    expect(await counts()).toEqual(kept);
    const after = await reconcile(userId);
    expect(after).toEqual(before);
    expect(after.cash + after.openCost - after.realized).toBe(after.credit);
    // Nothing anywhere else still carries the old address.
    const [{ hits }] = await database.rows<{ hits: number }>(
      "select ((select count(*) from public.users where email = 'journey@example.com') + (select count(*) from public.invites where email = 'journey@example.com') + (select count(*) from public.waitlist where email = 'journey@example.com'))::int as hits",
    );
    expect(hits).toBe(0);
  });

  it("refuses to delete an operator account", async () => {
    await database.actAs(operator);
    const [{ r }] = await database.rows<{ r: Record<string, unknown> }>("select public.delete_my_account() as r");
    expect(r).toMatchObject({ ok: false, code: "operator" });
  });
});

describe("revoked, resent and expired invites", () => {
  it("a revoked invite is refused at the join page and at account creation", async () => {
    const { created } = await issue(["revoked@example.com"]);
    const [{ r }] = await asOperator<{ r: Record<string, unknown> }>("select public.admin_revoke_invite($1, 'sent to the wrong address') as r", [created[0].id]);
    expect(r).toMatchObject({ ok: true });
    expect(await lookup(created[0].token)).toMatchObject({ status: "revoked" });
    expect(await attest(created[0].token, "revoked_user")).toEqual({ ok: false, code: "revoked" });
    expect(await refusedSignUp("revoked@example.com")).toMatch(/signup_requires_invite/);
    const [{ n }] = await database.rows<{ n: number }>("select count(*)::int as n from public.admin_audit_log where action = 'revoke_invite'");
    expect(n).toBe(1);
  });

  it("a resend kills the old link and re-arms an expired invite", async () => {
    const { created } = await issue(["resend@example.com"]);
    await database.rows("update public.invites set created_at = now() - interval '20 days', expires_at = now() - interval '6 days' where id = $1", [created[0].id]);
    expect(await lookup(created[0].token)).toMatchObject({ status: "expired" });
    expect(await attest(created[0].token, "resend_user")).toEqual({ ok: false, code: "expired" });
    const fresh = newInviteToken();
    const [{ r }] = await asOperator<{ r: Record<string, unknown> }>("select public.admin_resend_invite($1, $2, 14) as r", [created[0].id, fresh.hash]);
    expect(r).toMatchObject({ ok: true, email: "resend@example.com" });
    expect(await lookup(created[0].token)).toBeNull();
    expect(await lookup(fresh.token)).toMatchObject({ status: "pending" });
    expect(await attest(fresh.token, "resend_user")).toMatchObject({ ok: true });
    const id = await signUp("resend@example.com");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an accepted invite cannot be resent or revoked", async () => {
    const [{ id }] = await database.rows<{ id: string }>("select id from public.invites where accepted_at is not null limit 1");
    const [{ r: resend }] = await asOperator<{ r: Record<string, unknown> }>("select public.admin_resend_invite($1, $2, 14) as r", [id, newInviteToken().hash]);
    const [{ r: revoke }] = await asOperator<{ r: Record<string, unknown> }>("select public.admin_revoke_invite($1, null) as r", [id]);
    expect(resend).toEqual({ ok: false, code: "accepted" });
    expect(revoke).toEqual({ ok: false, code: "accepted" });
  });
});

describe("referral attribution reaches the account", () => {
  it("a waitlist visitor who came by a member's link is referred_by that member", async () => {
    const [{ id: invite }] = await database.rows<{ id: string }>("select id from public.invites where email = 'first@example.com'");
    const token = newInviteToken();
    await asOperator("select public.admin_resend_invite($1, $2, 14)", [invite, token.hash]);
    expect(await attest(token.token, "first_one")).toMatchObject({ ok: true });
    const id = await signUp("first@example.com");
    const [row] = await database.rows<{ referred_by: string; source: Record<string, unknown> }>("select referred_by, signup_source as source from public.users where id = $1", [id]);
    expect(row.referred_by).toBe(operator);
    expect(row.source).toMatchObject({ form: "landing_hero", utm_campaign: "launch" });
  });
});

describe("the admin lists", () => {
  it("show every invite with its status and every account with its invite source", async () => {
    const invites = await database.rows<{ email: string | null; status: string }>("select email, status from public.admin_invite_list(100)");
    expect(new Set(invites.map((row) => row.status))).toEqual(new Set(["pending", "accepted", "revoked"]));
    const users = await database.rows<{ username: string; invited_by_username: string | null; referred_by_username: string | null; deleted_at: string | null }>(
      "select username, invited_by_username, referred_by_username, deleted_at from public.admin_user_list(100)",
    );
    const [{ username: operatorName }] = await database.rows<{ username: string }>("select username from public.users where id = $1", [operator]);
    expect(users.find((row) => row.username === "first_one")).toMatchObject({ invited_by_username: operatorName, referred_by_username: operatorName });
    expect(users.filter((row) => row.deleted_at !== null)).toHaveLength(1);
  });
});
