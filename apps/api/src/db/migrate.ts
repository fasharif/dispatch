// CLI: applies pending migrations to DATABASE_URL. Used by `npm run db:migrate` and the
// one-shot `migrate` service in docker-compose.yml, before any API instance starts.
import pg from 'pg';
import { migrate } from './migrator.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const applied = await migrate(pool, undefined, (message) => {
    console.log(message);
  });
  console.log(
    applied.length === 0
      ? 'Database is up to date'
      : `Applied ${String(applied.length)} migration(s)`,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
