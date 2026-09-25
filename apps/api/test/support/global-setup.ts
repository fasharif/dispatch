import { Redis } from 'ioredis';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../src/db/migrator.js';
import { testTargets } from './test-env.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/**
 * Rebuilds the test schema from the migrations once per run, so every run starts from the same
 * schema the application ships with, and empties the test Redis database.
 */
export default async function setup(project: TestProject): Promise<void> {
  const { databaseUrl: TEST_DATABASE_URL, redisUrl: TEST_REDIS_URL } = testTargets(project.name);
  const target = new URL(TEST_DATABASE_URL);
  const database = target.pathname.replace(/^\//, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(database))
    throw new Error(`Unsafe test database name: ${database}`);

  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach PostgreSQL at ${admin.host}. Start it with "docker compose up -d" ` +
        `(or set TEST_DATABASE_URL): ${(error as Error).message}`,
      { cause: error },
    );
  }
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${database}`);
  await client.end();

  // Start from an empty schema. Dropping the schema rather than the database avoids the forced
  // checkpoint of DROP DATABASE, which takes seconds on a busy Docker Desktop disk.
  const reset = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await reset.connect();
  await reset.query('DROP SCHEMA IF EXISTS public CASCADE');
  await reset.query('CREATE SCHEMA public');
  await reset.end();

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await migrate(pool);
  await pool.end();

  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.flushdb();
  } catch (error) {
    throw new Error(
      `Cannot reach Redis at ${TEST_REDIS_URL}. Start it with "docker compose up -d" ` +
        `(or set TEST_REDIS_URL): ${(error as Error).message}`,
      { cause: error },
    );
  } finally {
    redis.disconnect();
  }
  project.provide('databaseUrl', TEST_DATABASE_URL);
  project.provide('redisUrl', TEST_REDIS_URL);
}
