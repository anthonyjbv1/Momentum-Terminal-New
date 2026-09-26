import { describe, expect, it } from "vitest";

import { PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal/versions";
import { createMemoryRateLimiter } from "@/lib/rate-limit";

import { expiryDate, inviteEmail, sendInviteEmail, INVITE_FROM, INVITE_REPLY_TO } from "./email";
import { JOIN_MESSAGES, callbackErrorDestination, joinPageState, parseJoinForm, readInviteView, submitJoin, type InviteView, type JoinDeps, type JoinSubmission } from "./join";
import { hashInviteToken, isInviteTokenShape, newInviteToken } from "./token";

/**
 * The join page's rules (Phase 32), with every dependency a stand-in so
 * each refusal is exercised on its own. The database refuses the same
 * things again (lib/invites/invites.db.test.ts); these are the words a
 * person sees and the order the checks run in.
 */

const TOKEN = newInviteToken().token;

function invite(overrides: Partial<InviteView> = {}): InviteView {
  return { email: "person@example.com", status: "pending", expiresAt: "2026-10-10T00:00:00.000Z", attested: false, desiredUsername: null, desiredDisplayName: null, ...overrides };
}

function submission(overrides: Partial<JoinSubmission> = {}): JoinSubmission {
  return { token: TOKEN, username: "newmember", displayName: "", ageAttested: true, termsAccepted: true, method: "email", ...overrides };
}

function deps(overrides: Partial<JoinDeps> = {}) {
  const calls: string[] = [];
  const base: JoinDeps = {
    enabled: true,
    googleEnabled: false,
    limiter: createMemoryRateLimiter(() => 0),
    ip: "203.0.113.9",
    usernameAvailable: async () => {
      calls.push("username");
      return "available";
    },
    attest: async (input) => {
      calls.push(`attest:${input.termsVersion}:${input.privacyVersion}`);
      return { ok: true, email: "person@example.com" };
    },
    sendLink: async (email) => {
      calls.push(`link:${email}`);
      return { ok: true };
    },
    googleUrl: async () => {
      calls.push("google");
      return { ok: true, url: "https://accounts.google.example/o/oauth2" };
    },
  };
  return { deps: { ...base, ...overrides }, calls };
}

describe("tokens", () => {
  it("are 43 base64url characters of randomness, and only their SHA-256 is ever stored", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { token, hash } = newInviteToken();
      expect(isInviteTokenShape(token)).toBe(true);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(hashInviteToken(token));
      seen.add(token);
    }
    expect(seen.size).toBe(200);
    for (const bad of ["", "short", `${TOKEN}x`, `${TOKEN.slice(0, 42)}!`, `../${TOKEN.slice(3)}`]) expect(isInviteTokenShape(bad), bad).toBe(false);
  });
});

describe("the join page's state", () => {
  it("does not exist while the switch is off, whatever the token", async () => {
    let looked = false;
    const state = await joinPageState(TOKEN, {
      enabled: false,
      lookup: async () => {
        looked = true;
        return invite();
      },
    });
    expect(state).toEqual({ kind: "closed" });
    expect(looked).toBe(false);
  });

  it("refuses a malformed token without asking the database, and names each way an invite stops working", async () => {
    let looked = 0;
    const lookup = (value: InviteView | null) => async () => {
      looked += 1;
      return value;
    };
    expect(await joinPageState("not-a-token", { enabled: true, lookup: lookup(invite()) })).toEqual({ kind: "not_found" });
    expect(looked).toBe(0);
    expect(await joinPageState(TOKEN, { enabled: true, lookup: lookup(null) })).toEqual({ kind: "not_found" });
    expect(await joinPageState(TOKEN, { enabled: true, lookup: lookup(invite({ status: "accepted" })) })).toEqual({ kind: "used" });
    expect(await joinPageState(TOKEN, { enabled: true, lookup: lookup(invite({ status: "revoked" })) })).toEqual({ kind: "revoked" });
    expect(await joinPageState(TOKEN, { enabled: true, lookup: lookup(invite({ status: "expired" })) })).toEqual({ kind: "expired" });
    expect(await joinPageState(TOKEN, { enabled: true, lookup: lookup(invite()) })).toMatchObject({ kind: "open", invite: { email: "person@example.com" } });
  });

  it("reads the database's answer strictly", () => {
    expect(readInviteView(null)).toBeNull();
    expect(readInviteView({ status: "weird" })).toBeNull();
    expect(readInviteView({ email: "a@b.co", status: "pending", expires_at: "x", attested: true, desired_username: "u", desired_display_name: null })).toEqual({
      email: "a@b.co",
      status: "pending",
      expiresAt: "x",
      attested: true,
      desiredUsername: "u",
      desiredDisplayName: null,
    });
  });
});

describe("the join form", () => {
  it("parses the form: a box counts only when ticked, the username is lowercased, an unknown method is the email link", () => {
    const form = new FormData();
    form.set("token", ` ${TOKEN} `);
    form.set("username", " NewMember ");
    form.set("display_name", "  Ann  ");
    form.set("age", "on");
    form.set("method", "carrier-pigeon");
    expect(parseJoinForm(form)).toEqual({ token: TOKEN, username: "newmember", displayName: "Ann", ageAttested: true, termsAccepted: false, method: "email" });
  });

  it("is refused while the switch is off, before anything else runs", async () => {
    const { deps: d, calls } = deps({ enabled: false });
    expect(await submitJoin(submission(), d)).toEqual({ kind: "error", message: JOIN_MESSAGES.closed });
    expect(calls).toEqual([]);
  });

  it("refuses without the 18+ box, and without the Terms, and records nothing", async () => {
    const { deps: d, calls } = deps();
    expect(await submitJoin(submission({ ageAttested: false }), d)).toEqual({ kind: "error", message: JOIN_MESSAGES.age, field: "age" });
    expect(await submitJoin(submission({ termsAccepted: false }), d)).toEqual({ kind: "error", message: JOIN_MESSAGES.terms, field: "terms" });
    expect(calls).toEqual([]);
  });

  it("refuses a bad username, a taken one and a malformed token", async () => {
    const { deps: d } = deps({ usernameAvailable: async () => "taken" });
    expect(await submitJoin(submission({ username: "No Spaces" }), d)).toMatchObject({ field: "username", message: JOIN_MESSAGES.username });
    expect(await submitJoin(submission(), d)).toMatchObject({ field: "username", message: JOIN_MESSAGES.usernameTaken });
    expect(await submitJoin(submission({ token: "short" }), d)).toEqual({ kind: "error", message: JOIN_MESSAGES.invalid });
  });

  it("passes the database's refusals through in plain words: used, revoked, expired, and the attestation it re-checks", async () => {
    for (const [code, message] of [
      ["accepted", JOIN_MESSAGES.used],
      ["revoked", JOIN_MESSAGES.revoked],
      ["expired", JOIN_MESSAGES.expired],
      ["unknown", JOIN_MESSAGES.invalid],
      ["age_not_attested", JOIN_MESSAGES.age],
      ["username_taken", JOIN_MESSAGES.usernameTaken],
      ["something_new", JOIN_MESSAGES.unavailable],
    ] as const) {
      const { deps: d, calls } = deps({ attest: async () => ({ ok: false, code }) });
      const outcome = await submitJoin(submission(), d);
      expect(outcome, code).toMatchObject({ kind: "error", message });
      expect(calls.some((call) => call.startsWith("link:")), code).toBe(false);
    }
  });

  it("records the attestation with the current Terms and Privacy versions, then sends the email link to the invited address", async () => {
    const { deps: d, calls } = deps();
    expect(await submitJoin(submission(), d)).toEqual({ kind: "link_sent", email: "person@example.com" });
    expect(calls).toEqual(["username", `attest:${TERMS_VERSION}:${PRIVACY_VERSION}`, "link:person@example.com"]);
  });

  it("sends the browser to Google only when Google is switched on", async () => {
    const off = deps();
    expect(await submitJoin(submission({ method: "google" }), off.deps)).toEqual({ kind: "error", message: JOIN_MESSAGES.googleOff });
    expect(off.calls).toEqual([]);
    const on = deps({ googleEnabled: true });
    expect(await submitJoin(submission({ method: "google" }), on.deps)).toEqual({ kind: "redirect", url: "https://accounts.google.example/o/oauth2" });
    expect(on.calls).toEqual(["username", `attest:${TERMS_VERSION}:${PRIVACY_VERSION}`, "google"]);
  });

  it("is rate-limited per address", async () => {
    const limiter = createMemoryRateLimiter(() => 0);
    const { deps: d } = deps({ limiter });
    for (let i = 0; i < 10; i += 1) expect((await submitJoin(submission(), d)).kind).toBe("link_sent");
    expect(await submitJoin(submission(), d)).toEqual({ kind: "error", message: JOIN_MESSAGES.rateLimited });
  });
});

describe("the auth callback's errors", () => {
  it("reads an account the database refused as not invited, anything else as a bad link, and nothing as nothing", () => {
    expect(callbackErrorDestination(new URLSearchParams("error=server_error&error_description=Database+error+saving+new+user"))).toBe("/login?error=not_invited");
    expect(callbackErrorDestination(new URLSearchParams("error=access_denied&error_description=The+user+denied"))).toBe("/login?error=auth_callback");
    expect(callbackErrorDestination(new URLSearchParams("code=abc"))).toBeNull();
  });
});

describe("the invitation email", () => {
  const at = new Date("2026-10-10T12:00:00Z");
  const email = inviteEmail({ to: "person@example.com", link: `https://momentumterminal.app/join/${TOKEN}`, expiresAt: at });

  it("comes from info@momentumterminal.app, replies there, and carries the link exactly once in each part", () => {
    expect(INVITE_FROM).toBe("Momentum Terminal <info@momentumterminal.app>");
    expect(INVITE_REPLY_TO).toBe("info@momentumterminal.app");
    expect(email).toMatchObject({ from: INVITE_FROM, reply_to: INVITE_REPLY_TO, to: ["person@example.com"], subject: "Your invitation to Momentum Terminal" });
    expect(email.text.split(TOKEN)).toHaveLength(2);
    expect(email.html.split(TOKEN)).toHaveLength(2);
  });

  it("says paper trading and no real money, gives the expiry as a date, and has no urgency in it", () => {
    for (const part of [email.text, email.html]) {
      expect(part).toMatch(/paper trading/);
      expect(part).toMatch(/no real money/);
      expect(part).toContain(expiryDate(at));
      expect(part).not.toMatch(/\b(hurry|act now|last chance|limited (time|spots|places)|only \d+ (left|spots)|don.t miss|expires? (soon|in \d))\b/i);
    }
    expect(expiryDate(at)).toBe("Saturday 10 October 2026");
  });

  it("escapes the link in the HTML part", () => {
    const hostile = inviteEmail({ to: "p@example.com", link: 'https://x.example/"><script>alert(1)</script>', expiresAt: at });
    expect(hostile.html).not.toContain("<script>");
    expect(hostile.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("sends through Resend with the key, and reports a failure instead of throwing", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const ok = await sendInviteEmail({ to: "p@example.com", link: "https://x.example/join/t", expiresAt: at }, {
      apiKey: "re_test",
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(ok).toEqual({ ok: true, id: "email_1" });
    expect(requests[0].url).toBe("https://api.resend.com/emails");
    expect(new Headers(requests[0].init.headers).get("authorization")).toBe("Bearer re_test");
    expect(await sendInviteEmail({ to: "p@example.com", link: "l", expiresAt: at }, { apiKey: null })).toEqual({ ok: false, error: "RESEND_API_KEY is not set" });
    const refused = await sendInviteEmail({ to: "p@example.com", link: "l", expiresAt: at }, {
      apiKey: "re_test",
      fetch: (async () => new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 })) as unknown as typeof fetch,
    });
    expect(refused).toEqual({ ok: false, error: "Resend 403: domain not verified" });
    const thrown = await sendInviteEmail({ to: "p@example.com", link: "l", expiresAt: at }, {
      apiKey: "re_test",
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(thrown).toEqual({ ok: false, error: "network down" });
  });
});
