import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { copyViolations } from "@/lib/copy-rules";
import { PRIVACY } from "@/lib/landing/copy";

import { DELETE_PAGE, PROFILE, allProfileStrings } from "./copy";

/**
 * The profile's words (Phase 32): the house rules, and a deletion screen
 * that says what the database does and what the Privacy notice promises.
 */

const root = join(__dirname, "..", "..");
const migration = readFileSync(join(root, "supabase", "migrations", "20260926180000_phase32_signup_onboarding.sql"), "utf8");
const deleteFn = migration.slice(migration.indexOf("create or replace function public.delete_my_account"), migration.indexOf("$$;", migration.indexOf("create or replace function public.delete_my_account")));

describe("profile copy", () => {
  it("breaks none of the house rules", () => {
    expect(allProfileStrings().flatMap((value) => copyViolations(value).map((rule) => `[${rule}] ${value}`))).toEqual([]);
  });

  it("says the referral link records and rewards nothing", () => {
    expect(PROFILE.referral.body).toMatch(/there is no reward/);
  });

  it("holds a place for the forecast record", () => {
    expect(PROFILE.record.title).toBe("Forecast record");
  });
});

describe("the deletion screen tells the truth", () => {
  const deleted = DELETE_PAGE.deleted.items.join(" ");
  const privacy = PRIVACY.sections.find((section) => section.title === "Deletion")!.body.join(" ");

  it("lists what delete_my_account() actually removes", () => {
    const pairs: Array<[RegExp, RegExp]> = [
      [/email address, username, display name and photo/, /set email\s+= 'deleted-'[\s\S]*username\s+= 'deleted_'[\s\S]*display_name\s+= 'Deleted account'[\s\S]*avatar_path\s+= null/],
      [/people you follow/, /delete from public\.follows/],
      [/what you opened and tapped/, /delete from public\.behavioral_events/],
      [/network hash stored with your trades/, /set fingerprint_hash = null/],
      [/waitlist entry and invitation details/, /delete from public\.waitlist[\s\S]*update public\.invites/],
      [/can no longer sign in/, /delete from auth\.users/],
    ];
    for (const [claim, sql] of pairs) {
      expect(deleted, String(claim)).toMatch(claim);
      expect(deleteFn, String(sql)).toMatch(sql);
    }
  });

  it("says trades, the ledger and forecasts are kept without a name, as the Privacy notice does, and the function deletes none of them", () => {
    expect(DELETE_PAGE.kept.body).toMatch(/paper trades, the paper ledger and your forecasts/);
    expect(privacy).toMatch(/paper trades, the paper ledger and your forecasts/);
    for (const table of ["trade_orders", "positions", "position_closes", "transactions", "forecast_votes"]) {
      expect(deleteFn).not.toMatch(new RegExp(`delete from public\\.${table}\\b`));
    }
  });

  it("names the backups' seven days, as the Privacy notice does", () => {
    expect(DELETE_PAGE.backups).toMatch(/seven days/);
    expect(PRIVACY.sections.find((section) => section.title === "How long")!.body.join(" ")).toMatch(/seven days/);
  });
});
