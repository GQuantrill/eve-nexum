import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  // Source imports use explicit `.js` extensions (NodeNext ESM style); tell the
  // resolver to fall back to the `.ts` source when the `.js` file doesn't exist.
  resolve: {
    extensions: ['.ts', '.js', '.json'],
  },
});
