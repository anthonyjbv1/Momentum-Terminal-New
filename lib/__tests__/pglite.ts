import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";

import { SUPABASE_STUBS, loadMigrations, migrationFiles } from "./migrations";

/**
 * A real Postgres for tests, in-process.
 *
 * PGlite runs Postgres compiled to WebAssembly, so the SQL under test is the
 * SQL that runs in production: the migrations in supabase/migrations are
 * applied verbatim, in order, on a fresh database, over the stubs in
 * ./migrations.ts.
 *
 * One session only. Use it for logic that lives in SQL: RPC functions,
 * triggers, keyset pagination, integrity rules. For anything that needs two
 * connections at once (row locks under concurrent orders) use ./postgres.ts.
 */

export { migrationFiles };

export interface TestDatabase {
  db: PGlite;
  /** Run a statement and get its rows, typed by the caller. */
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run one or more statements for their effect. */
  exec(sql: string): Promise<void>;
  /** Act as this user (auth.uid()) for the following statements; null signs out. */
  actAs(userId: string | null): Promise<void>;
  close(): Promise<void>;
}

export interface TestDatabaseOptions {
  /**
   * Apply only the migrations whose version sorts before this one — the
   * schema as it stood before that migration ran (the rollback tests compare
   * against it).
   */
  before?: string;
}

/** A fresh database with every migration applied (or every one before `options.before`). */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  // citext is the one extension a migration creates (Phase 28's waitlist);
  // PGlite has to be handed it up front for CREATE EXTENSION to find it.
  const db = new PGlite({ extensions: { citext } });
  await db.exec(SUPABASE_STUBS);
  const { before } = options;
  for (const [file, sql] of loadMigrations().filter(([name]) => before === undefined || name < before)) {
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
    async actAs(userId) {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
    },
    close: () => db.close(),
  };
}
