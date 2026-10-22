import { SQL } from "bun";
import { env } from "../config/env.ts";

/**
 * Shared Bun.sql PostgreSQL connection pool instance.
 */
export const sql = new SQL(env.databaseUrl, {
  max: 20,
  idleTimeout: 30,
  connectionTimeout: 10,
});

/**
 * Verifies database connectivity and returns server metadata.
 */
export async function checkDatabaseConnection(): Promise<{
  database: string;
  version: string;
}> {
  const rows = await sql<{ database: string; version: string }[]>`
    SELECT current_database() AS database, version() AS version
  `;
  const row = rows[0];
  if (!row) {
    throw new Error("Database connection check returned no rows.");
  }
  return row;
}

/**
 * Gracefully closes the PostgreSQL connection pool.
 */
export async function closeDatabase(): Promise<void> {
  await sql.close({ timeout: 5 });
}
