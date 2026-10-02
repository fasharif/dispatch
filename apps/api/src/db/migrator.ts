import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** apps/api/migrations, resolved from both src/db (tests) and dist/db (compiled). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Any constant works; it only has to be the same for every process that migrates this database.
const ADVISORY_LOCK_KEY = 7_401_553_021;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => FILE_PATTERN.test(name)).sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name), 'utf8');
    files.push({
      version: name.slice(0, 4),
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  const versions = files.map((file) => file.version);
  if (new Set(versions).size !== versions.length) {
    throw new Error(`Two migrations share a version number in ${dir}`);
  }
  return files;
}

/**
 * Applies pending migrations in order, each in its own transaction. An advisory lock makes
 * concurrent runs (two API instances starting together) wait for each other. An applied
 * migration whose file has changed stops the run: migrations are append-only.
 */
export async function migrate(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
  log: (message: string) => void = () => undefined,
): Promise<string[]> {
  const files = await readMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map(
      (
        await client.query<{ version: string; checksum: string }>(
          'SELECT version, checksum FROM schema_migrations',
        )
      ).rows.map((row) => [row.version, row.checksum]),
    );

    for (const file of files) {
      const previous = done.get(file.version);
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new Error(
            `Migration ${file.name} was changed after it was applied. Add a new migration instead.`,
          );
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [file.version, file.name, file.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      applied.push(file.name);
      log(`Applied ${file.name}`);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
