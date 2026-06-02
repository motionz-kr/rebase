import { defineConfig } from '@playwright/test';

// Electron E2E: single worker (one app instance at a time), generous timeout for
// engine spawn + DB-less UI boot. No webServer — the app is launched per-test.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
});
