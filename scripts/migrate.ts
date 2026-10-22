import { join } from "node:path";
import { closeDatabase, sql } from "../src/db/index.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

/**
 * Applies all pending SQL migrations in `src/db/migrations/` in lexical order.
 */
export async function runMigrations(): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const appliedRows = await sql<{ filename: string }[]>`
    SELECT filename FROM schema_migrations ORDER BY filename ASC
  `;
  const appliedSet = new Set(appliedRows.map((r) => r.filename));

  const glob = new Bun.Glob("*.sql");
  const files: string[] = [];
  for await (const file of glob.scan(MIGRATIONS_DIR)) {
    files.push(file);
  }
  files.sort();

  const newlyApplied: string[] = [];

  for (const filename of files) {
    if (appliedSet.has(filename)) {
      continue;
    }

    const filePath = join(MIGRATIONS_DIR, filename);
    const content = await Bun.file(filePath).text();

    console.log(`[Migrate] Applying migration: ${filename}...`);
    await sql.begin(async (tx) => {
      await tx.unsafe(content).simple();
      await tx`
        INSERT INTO schema_migrations (filename)
        VALUES (${filename})
      `;
    });

    newlyApplied.push(filename);
    console.log(`[Migrate] Applied ${filename}`);
  }

  if (newlyApplied.length === 0) {
    console.log("[Migrate] Database schema is up to date.");
  } else {
    console.log(`[Migrate] Successfully applied ${newlyApplied.length} migration(s).`);
  }

  return newlyApplied;
}

if (import.meta.main) {
  try {
    await runMigrations();
  } catch (err) {
    console.error("[Migrate] Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
