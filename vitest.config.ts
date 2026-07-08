import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/**/*.test.mts'],
    testTimeout: 15000,
    hookTimeout: 10000,
    // On Windows, some processes need extra time
    pool: 'forks',
  },
});
