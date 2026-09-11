import { PGlite } from "@electric-sql/pglite";

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

/** A fresh database with every migration applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const [file, sql] of loadMigrations()) {
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
