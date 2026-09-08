import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The web test runner. Companion to server/vitest.config.ts -- same runner and
// the same `yarn test` entry point, so both halves of the repo behave alike.
//
// jsdom rather than node: most of what is worth testing here touches browser
// state (localStorage for the cross-tab poll de-dupe, timers, window events),
// and those are exactly the places bugs have hidden.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Each test gets clean module state: these stores are module-level
    // singletons holding caches and in-flight promises, so leaking one test's
    // state into the next would hide precisely the bugs they cover.
    restoreMocks: true,
    clearMocks: true,
  },
});
