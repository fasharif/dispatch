/** Values SQLite can bind. */
export type SqlValue = string | number | null;

/** The statements the queue needs; expo-sqlite in the app, node:sqlite in the tests. */
export interface SqlExecutor {
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  get<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

export interface SqlDatabase extends SqlExecutor {
  exec(sql: string): Promise<void>;
  /**
   * Runs `work` in an exclusive transaction. Only the executor passed to `work` may be used
   * inside it; everything commits or nothing does.
   */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
