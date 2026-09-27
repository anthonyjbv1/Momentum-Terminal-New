import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TypedSupabaseClient } from "@/types";

import { inviteEmail, type InviteEmailInput } from "./email";
import { issueInvites, resendInvite } from "./server";

/**
 * The invitation's first line follows how the operator invited: an address
 * typed into the form reads "You've been invited", one taken from "the
 * oldest N on the waitlist" reads "You joined the waitlist". Resend takes
 * the row's source from the console. Nothing is sent: the email module is
 * replaced by one that records what it was asked to send.
 */
const sent: InviteEmailInput[] = [];
vi.mock("./email", async (original) => {
  const actual = await original<typeof import("./email")>();
  return {
    ...actual,
    sendInviteEmail: async (input: InviteEmailInput) => {
      sent.push(input);
      return { ok: true, id: `re_${sent.length}` };
    },
  };
});

function operatorClient(results: Record<string, unknown>): TypedSupabaseClient {
  return { rpc: async (name: string) => ({ data: results[name] ?? null, error: null }) } as unknown as TypedSupabaseClient;
}

const firstLine = (input: InviteEmailInput) => inviteEmail(input).text.split("\n")[0];

describe("the invitation's first line, by how the operator invited", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("typed addresses are invited; the rest of the batch came from the waitlist", async () => {
    const client = operatorClient({
      admin_issue_invites: {
        ok: true,
        created: [
          { id: "i-1", email: "typed@example.com", token_index: 1 },
          { id: "i-2", email: "listed@example.com", token_index: 2 },
        ],
        skipped: [],
      },
    });
    const report = await issueInvites(client, ["Typed@Example.com"], 1);
    expect(report).toMatchObject({ created: 2, sent: 2, failed: [] });
    expect(sent.map((input) => [input.to, input.fromWaitlist])).toEqual([
      ["typed@example.com", false],
      ["listed@example.com", true],
    ]);
    expect(firstLine(sent[0])).toBe("You've been invited to the Momentum Terminal beta.");
    expect(firstLine(sent[1])).toBe("You joined the Momentum Terminal waitlist, and a place is ready for you.");
  });

  it("a resend opens as the row's source says", async () => {
    const client = operatorClient({ admin_resend_invite: { ok: true, id: "i-1", email: "someone@example.com" } });
    expect(await resendInvite(client, "i-1", true)).toEqual({ ok: true, sent: true });
    expect(await resendInvite(client, "i-1", false)).toEqual({ ok: true, sent: true });
    expect(sent.map((input) => input.fromWaitlist)).toEqual([true, false]);
  });
});
