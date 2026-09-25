import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test environment. Defaults point at the docker compose services on this project's ports.
 * Each test project gets its own database and Redis database (integration and e2e may run at the
 * same time), so tests never touch development data or each other. CI overrides the base URLs
 * with TEST_DATABASE_URL and TEST_REDIS_URL.
 */
const BASE_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://dispatch:dispatch@localhost:57432/dispatch_test';
const BASE_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:57379';
const REDIS_DATABASE: Record<string, number> = { integration: 15, e2e: 14 };

export interface TestTargets {
  databaseUrl: string;
  redisUrl: string;
}

export function testTargets(project: string): TestTargets {
  const database = new URL(BASE_DATABASE_URL);
  database.pathname = `${database.pathname.replace(/^\//, '')}_${project}`;
  const redis = new URL(BASE_REDIS_URL);
  redis.pathname = `/${String(REDIS_DATABASE[project] ?? 13)}`;
  return { databaseUrl: database.toString(), redisUrl: redis.toString() };
}

export function testEnv(targets: TestTargets): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PROCESS_ROLE: 'all',
    INSTANCE_ID: 'test',
    DATABASE_URL: targets.databaseUrl,
    DATABASE_POOL_MAX: '5',
    REDIS_URL: targets.redisUrl,
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-jwt-secret',
    TRACKING_TOKEN_SECRET: 'test-tracking-secret-test-tracking-secret-0000',
    PUBLIC_WEB_URL: 'http://localhost:57300',
    CORS_ORIGINS: 'http://localhost:57300',
    UPLOAD_DIR: mkdtempSync(join(tmpdir(), 'dispatch-uploads-')),
    THROTTLE_LIMIT: '100000',
    AUTH_THROTTLE_LIMIT: '100000',
    WEBHOOK_URL: '',
    WEBHOOK_SECRET: '',
    WEBHOOK_BACKOFF_MS: '100',
    WEBHOOK_MAX_ATTEMPTS: '3',
    WEBHOOK_TIMEOUT_MS: '2000',
    OSRM_URL: '',
  };
}
