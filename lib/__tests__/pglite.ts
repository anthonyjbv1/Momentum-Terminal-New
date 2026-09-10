import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

/**
 * A real Postgres for tests, in-process.
 *
 * PGlite runs Postgres compiled to WebAssembly, so the SQL under test is the
 * SQL that runs in production: the migrations in supabase/migrations are
 * applied verbatim, in order, on a fresh database. The only additions are
 * the Supabase-managed pieces those migrations assume and Supabase itself
 * provides — the auth schema (`auth.users`, `auth.uid()`) and the platform
 * roles — stubbed just far enough for the migrations to apply.
 *
 * Use it for logic that lives in SQL: RPC functions, triggers, keyset
 * pagination, integrity rules. Pure TypeScript keeps its own unit tests.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create role supabase_auth_admin nologin;

  create schema auth;
  create table auth.users (
    id                 uuid        primary key default gen_random_uuid(),
    email              text,
    raw_user_meta_data jsonb       not null default '{}'::jsonb,
    created_at         timestamptz not null default now()
  );
  create function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`;

export interface TestDatabase {
  db: PGlite;
  /** Run a statement and get its rows, typed by the caller. */
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run one or more statements for their effect. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** The migration files in the order Supabase applies them (by version prefix). */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** A fresh database with every migration applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    db,
    async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await db.query<T>(sql, params);
      return result.rows;
    },
    async exec(sql) {
      await db.exec(sql);
    },
    close: () => db.close(),
  };
}
