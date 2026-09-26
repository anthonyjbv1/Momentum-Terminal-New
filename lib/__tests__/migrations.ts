import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What every database test harness shares: the migrations in the order
 * Supabase applies them, and the Supabase-managed pieces those migrations
 * assume and Supabase itself provides — the auth schema (`auth.users`,
 * `auth.uid()`) and the platform roles — stubbed just far enough for the
 * migrations to apply.
 *
 * `auth.uid()` reads the same setting Supabase's does, so a test acts as a
 * user with `select set_config('request.jwt.claim.sub', '<uuid>', false)`.
 */

export const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

export const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create role supabase_auth_admin nologin;

  create schema auth;
  -- Supabase keeps extensions in their own schema (Phase 28's citext).
  create schema extensions;
  create table auth.users (
    id                 uuid        primary key default gen_random_uuid(),
    email              text,
    raw_user_meta_data jsonb       not null default '{}'::jsonb,
    -- Set by GoTrue, never by the caller: the provider that made the user.
    raw_app_meta_data  jsonb       not null default '{"provider": "email"}'::jsonb,
    created_at         timestamptz not null default now(),
    email_confirmed_at timestamptz,
    last_sign_in_at    timestamptz
  );
  create function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  -- Phase 32: a new auth user needs an open, attested invite. Tests that make
  -- users to trade with take the operator's bypass for the whole database;
  -- the tests of the rule itself turn it off in their own session.
  select set_config('momentum.signup_without_invite', 'on', false);
  do $$ begin execute format('alter database %I set momentum.signup_without_invite = %L', current_database(), 'on'); end $$;
`;

/** The migration files in the order Supabase applies them (by version prefix). */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** [file name, SQL] for every migration, in order. */
export function loadMigrations(): Array<[string, string]> {
  return migrationFiles().map((file) => [file, readFileSync(join(MIGRATIONS_DIR, file), "utf8")]);
}
