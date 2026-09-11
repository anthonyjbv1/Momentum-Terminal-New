import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { Pool, type PoolClient } from "pg";

import { SUPABASE_STUBS, loadMigrations } from "./migrations";

/**
 * A real Postgres SERVER for tests: many connections, real row locks, real
 * concurrency. embedded-postgres downloads the platform binaries once and
 * runs a throwaway cluster on a free port (as an unprivileged `postgres`
 * user when the test runner is root). The same stubs and migrations as the
 * PGlite harness are applied, so the SQL under test is production's.
 *
 * Slower to boot than PGlite (a few seconds), so reserve it for what
 * genuinely needs two sessions at once: the concurrent-order tests.
 */

export interface TestServer {
  pool: Pool;
  /** A dedicated connection, acting as the given user (auth.uid()). Release it when done. */
  session(userId: string | null): Promise<PoolClient>;
  close(): Promise<void>;
}

let port = 54300 + Math.floor(Math.random() * 200);

export async function createTestServer(): Promise<TestServer> {
  port += 1;
  const databaseDir = mkdtempSync(join(tmpdir(), "momentum-pg-"));
  const server = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    createPostgresUser: true,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();

  const pool = new Pool({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres", max: 8 });
  const clients = new Set<PoolClient>();
  pool.on("connect", (client) => clients.add(client as PoolClient));
  const bootstrap = await pool.connect();
  try {
    await bootstrap.query(SUPABASE_STUBS);
    for (const [file, sql] of loadMigrations()) {
      try {
        await bootstrap.query(sql);
      } catch (error) {
        throw new Error(`migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    bootstrap.release();
  }

  return {
    pool,
    async session(userId) {
      const client = await pool.connect();
      await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
      return client;
    },
    async close() {
      // pool.end() resolves once every idle client has been TOLD to end, not
      // once its socket has closed. Stopping the server in that gap makes the
      // backend's FATAL land on a client nobody is listening to (an unhandled
      // error in the test run). So: absorb late errors, and wait for the pool
      // to report every client removed before the cluster goes down.
      for (const client of clients) client.on("error", () => undefined);
      const removed = new Promise<void>((resolve) => {
        let remaining = pool.totalCount;
        if (remaining === 0) return resolve();
        pool.on("remove", () => {
          remaining -= 1;
          if (remaining === 0) resolve();
        });
      });
      await pool.end();
      await removed;
      await server.stop();
    },
  };
}
