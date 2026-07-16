import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Loads .env, relaxes prod guards, and redirects the pool to a *_test DB.
    setupFiles: ['./vitest.setup.ts'],
    // The *.integration.test.ts suites share one test database and TRUNCATE
    // between tests, so files must not run in parallel or they clobber each
    // other. The suite is small, so serial files cost little.
    fileParallelism: false,
  },
  // Source imports use explicit `.js` extensions (NodeNext ESM style); tell the
  // resolver to fall back to the `.ts` source when the `.js` file doesn't exist.
  resolve: {
    extensions: ['.ts', '.js', '.json'],
  },
});
