import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against a running stack: the web app on WEB_URL and the API on API_URL, with a
 * migrated and seeded database (see .github/workflows/ci.yml, job "browser"). Locally:
 * docker compose up -d, npm run db:migrate, npm run db:seed, then start the API and the web app.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:57300',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
