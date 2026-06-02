import { defineConfig } from 'vitest/config';

// Unit tests live next to the source under src/. The e2e/ folder is Playwright
// (run via `pnpm test:e2e`) and must be excluded from vitest, which otherwise
// picks up its *.spec.ts files and fails to load @playwright/test.
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
