// CLI: creates (or updates) the dispatcher account used to sign in to the console.
//
// Locally the password defaults to a published demo value. In production SEED_DISPATCHER_PASSWORD
// is required, because a public password on a real system is an open door.
import pg from 'pg';
import { hashPassword } from '../auth/passwords.js';

export const LOCAL_DEMO_PASSWORD = 'dispatch-demo-2026';

const url = process.env.DATABASE_URL;
const email = (process.env.SEED_DISPATCHER_EMAIL ?? 'dispatcher@dispatch.local')
  .trim()
  .toLowerCase();
const name = process.env.SEED_DISPATCHER_NAME ?? 'Demo Dispatcher';
const production = process.env.NODE_ENV === 'production';
const password =
  process.env.SEED_DISPATCHER_PASSWORD ?? (production ? undefined : LOCAL_DEMO_PASSWORD);

if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!password || password.length < 12) {
  console.error('SEED_DISPATCHER_PASSWORD (12+ characters) is required in production');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await pool.query(
    `INSERT INTO dispatchers (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash`,
    [email, name, await hashPassword(password)],
  );
  console.log(`Dispatcher account ready: ${email}`);
} catch (error) {
  console.error(`Seeding failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
