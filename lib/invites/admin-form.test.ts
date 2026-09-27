import { describe, expect, it } from "vitest";

import { MAX_TYPED_INVITES, issueSentence, issueSucceeded, parseInviteForm } from "./admin-form";

describe("the operator's invite form", () => {
  it("reads a pasted list in any shape, lower-cased and de-duplicated", () => {
    const parsed = parseInviteForm("Ada@Example.com, bob@example.org;\n<carol@example.net>  ada@example.com", "");
    expect(parsed.emails).toEqual(["ada@example.com", "bob@example.org", "carol@example.net"]);
    expect(parsed.fromWaitlist).toBe(0);
    expect(parsed.error).toBeNull();
  });

  it("keeps what is not an address aside, and says so when nothing is", () => {
    expect(parseInviteForm("ada@example.com nope", "").invalid).toEqual(["nope"]);
    expect(parseInviteForm("nope", "").error).toMatch(/None of those/);
    expect(parseInviteForm("", "").error).toMatch(/Paste addresses/);
  });

  it("takes a waitlist count within limits", () => {
    expect(parseInviteForm("", "5")).toMatchObject({ fromWaitlist: 5, error: null });
    expect(parseInviteForm("", "-1").error).toMatch(/whole number/);
    expect(parseInviteForm("", "2.5").error).toMatch(/whole number/);
    expect(parseInviteForm("", "51").error).toMatch(/at most 50/);
    const many = Array.from({ length: MAX_TYPED_INVITES + 1 }, (_, i) => `p${i}@example.com`).join(" ");
    expect(parseInviteForm(many, "").error).toMatch(/at most 50 addresses/);
  });

  it("reports an issue in one sentence: accounts first as a warning, then what Resend accepted and what it did not", () => {
    const report = { created: 2, sent: 1, failed: [{ email: "b@x.io", error: "Resend 422: invalid to" }], skipped: [{ email: "c@x.io", reason: "member" }, { email: "d@x.io", reason: "already_invited" }] };
    expect(issueSentence(report, ["nope"])).toBe(
      "Already has an account, so no invite was sent: c@x.io. They can sign in at /login. Sent 1 of 2 invites. Not sent, Resend did not accept: b@x.io (Resend 422: invalid to). Saved as not sent; fix the cause, then use Resend on the row. Skipped: d@x.io (already has an open invite; use Resend on its row). Not addresses: nope.",
    );
    expect(issueSucceeded(report, ["nope"])).toBe(false);
  });

  it("calls it sent only when Resend accepted every invite", () => {
    const all = { created: 2, sent: 2, failed: [], skipped: [] };
    expect(issueSentence(all, [])).toBe("Sent 2 invites; Resend accepted each.");
    expect(issueSucceeded(all, [])).toBe(true);
    const none = { created: 1, sent: 0, failed: [{ email: "a@x.io", error: "RESEND_API_KEY is not set" }], skipped: [] };
    expect(issueSentence(none, [])).toMatch(/^Sent 0 of 1 invites\. Not sent, Resend did not accept: a@x\.io \(RESEND_API_KEY is not set\)/);
    expect(issueSucceeded(none, [])).toBe(false);
  });

  it("an address with an account alone is a warning and nothing is sent", () => {
    const member = { created: 0, sent: 0, failed: [], skipped: [{ email: "me@x.io", reason: "member" }] };
    expect(issueSentence(member, [])).toBe("Already has an account, so no invite was sent: me@x.io. They can sign in at /login.");
    expect(issueSucceeded(member, [])).toBe(false);
  });
});
