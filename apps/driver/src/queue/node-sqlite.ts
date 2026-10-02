import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlExecutor, SqlValue } from './sql';

/**
 * SqlDatabase over Node's built-in SQLite (node:sqlite), used by the unit tests so the queue's
 * SQL runs against a real SQLite engine, as it does on the phone through expo-sqlite.
 */
export function openNodeSqlite(path = ':memory:'): SqlDatabase & { close(): void } {
  const db = new DatabaseSync(path);
  const executor: SqlExecutor = {
    run: (sql, params: SqlValue[] = []) => {
      const result = db.prepare(sql).run(...params);
      return Promise.resolve({ changes: Number(result.changes) });
    },
    get: <T>(sql: string, params: SqlValue[] = []) =>
      Promise.resolve((db.prepare(sql).get(...params) as T | undefined) ?? null),
    all: <T>(sql: string, params: SqlValue[] = []) =>
      Promise.resolve(db.prepare(sql).all(...params) as T[]),
  };
  let inTransaction = false;
  return {
    ...executor,
    exec: (sql) => {
      db.exec(sql);
      return Promise.resolve();
    },
    async transaction(work) {
      if (inTransaction) throw new Error('Nested transactions are not supported');
      inTransaction = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(executor);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close: () => {
      db.close();
    },
  };
}
