import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles the tests because NestJS needs decorator metadata, which esbuild does not emit.
// unit: no containers. integration and e2e: PostgreSQL/PostGIS and Redis (docker compose up -d,
// or the CI service containers). Projects run one after another, and files within a project one
// at a time, because they share the database server.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.ts'], sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          sequence: { groupOrder: 1 },
          globalSetup: ['test/support/global-setup.ts'],
          setupFiles: ['test/support/env.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          sequence: { groupOrder: 2 },
          globalSetup: ['test/support/global-setup.ts'],
          setupFiles: ['test/support/env.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
