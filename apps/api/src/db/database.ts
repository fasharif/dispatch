import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';

// bigint columns (sequence numbers, event ids) come back as numbers. Sequence numbers are
// validated to stay below Number.MAX_SAFE_INTEGER, so no precision is lost.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export type Queryable = Pick<pg.PoolClient, 'query'>;
export type Row = pg.QueryResultRow;

/** Runs a query and returns its rows. */
export async function rows<R extends Row>(
  client: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  const result = await client.query<R>(text, params as unknown[]);
  return result.rows;
}

/** Runs a query that must return exactly one row. */
export async function one<R extends Row>(
  client: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<R> {
  const [first] = await rows<R>(client, text, params);
  if (first === undefined) throw new Error('Expected one row, got none');
  return first;
}

export async function maybeOne<R extends Row>(
  client: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<R | null> {
  const [first] = await rows<R>(client, text, params);
  return first ?? null;
}

/** PostgreSQL error codes the services branch on. */
export const PgError = {
  UNIQUE_VIOLATION: '23505',
  SERIALIZATION_FAILURE: '40001',
} as const;

export function isPgError(error: unknown, code: string): error is pg.DatabaseError {
  return error instanceof pg.DatabaseError && error.code === code;
}

/** The connection pool, plus a transaction helper. */
@Injectable()
export class Database implements OnApplicationShutdown {
  private readonly logger = new Logger(Database.name);
  readonly pool: pg.Pool;

  constructor(@InjectConfig() config: AppConfig) {
    this.pool = new pg.Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      application_name: `dispatch-${config.role}-${config.instanceId}`,
    });
    this.pool.on('error', (error) => {
      this.logger.error(`Idle database connection failed: ${error.message}`);
    });
  }

  query<R extends Row>(text: string, params: readonly unknown[] = []): Promise<R[]> {
    return rows<R>(this.pool, text, params);
  }

  one<R extends Row>(text: string, params: readonly unknown[] = []): Promise<R> {
    return one<R>(this.pool, text, params);
  }

  maybeOne<R extends Row>(text: string, params: readonly unknown[] = []): Promise<R | null> {
    return maybeOne<R>(this.pool, text, params);
  }

  /** Runs `work` in a transaction: commit on success, rollback on any error. */
  async tx<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs after the HTTP server has stopped, so in-flight requests finish their queries. */
  async onApplicationShutdown(): Promise<void> {
    if (!this.pool.ended) await this.pool.end();
  }
}
