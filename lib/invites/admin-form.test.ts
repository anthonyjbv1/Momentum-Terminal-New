import { describe, expect, it } from "vitest";

import { MAX_TYPED_INVITES, issueSentence, parseInviteForm } from "./admin-form";

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

  it("reports an issue in one sentence, naming failures and skips", () => {
    const sentence = issueSentence({ created: 2, sent: 1, failed: [{ email: "b@x.io", error: "Resend 422" }], skipped: [{ email: "c@x.io", reason: "member" }] }, ["nope"]);
    expect(sentence).toBe("Issued 2 invites, emailed 1. Not delivered: b@x.io (Resend 422). Use Resend on those rows. Skipped: c@x.io (already a member). Not addresses: nope.");
  });
});
