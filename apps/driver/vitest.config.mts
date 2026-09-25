import { defineConfig } from 'vitest/config';

// Only the pure TypeScript logic (queue, replay, signature capture) runs under Node; the React
// Native screens need a device or simulator and are not unit-tested here.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
