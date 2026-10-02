import * as SQLite from 'expo-sqlite';
import type { SqlDatabase, SqlExecutor } from './sql';

type Executor = Pick<SQLite.SQLiteDatabase, 'runAsync' | 'getFirstAsync' | 'getAllAsync'>;

function wrap(target: Executor): SqlExecutor {
  return {
    run: async (sql, params = []) => ({ changes: (await target.runAsync(sql, params)).changes }),
    get: (sql, params = []) => target.getFirstAsync(sql, params),
    all: (sql, params = []) => target.getAllAsync(sql, params),
  };
}

/**
 * The queue's database on the phone. WAL journaling lets the background task write fixes while
 * the screen reads the queue size; exclusive transactions keep sequence numbers unique even if
 * the operating system runs the background task in a second JavaScript context.
 */
export async function openExpoSqlite(name = 'dispatch-driver.db'): Promise<SqlDatabase> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return {
    ...wrap(db),
    exec: (sql) => db.execAsync(sql),
    async transaction(work) {
      let result: Awaited<ReturnType<typeof work>> | undefined;
      await db.withExclusiveTransactionAsync(async (txn) => {
        result = await work(wrap(txn));
      });
      return result as Awaited<ReturnType<typeof work>>;
    },
  };
}
