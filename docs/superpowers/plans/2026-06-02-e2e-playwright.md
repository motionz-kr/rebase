# Automated UI Tests (Playwright) Implementation Plan

**Goal:** A repeatable Playwright **Electron** E2E harness with a deterministic, DB-free smoke test of the connection UI, runnable via `pnpm --filter desktop test:e2e`.

**Architecture:** Playwright's `_electron` launches the app's own Electron binary against the built (`dist/main`) main process — no browser download. We force prod-renderer mode (`ELECTRON_IS_DEV=0` → `loadFile(renderer/dist)`) so the test needs no vite dev server, and pass `--user-data-dir=<tmp>` so it gets an isolated, empty profile store that never touches the user's real connections or data. The engine self-assigns a dynamic port and a randomized handshake path, so this instance coexists with a running dev instance.

**Tech Stack:** `@playwright/test` (Electron API), TypeScript.

> Branch `feat/e2e-playwright`. node/pnpm via nvm. Reuses existing engine binary (`apps/desktop/bin/app-engine`) and built renderer (`apps/renderer/dist`).

---

## Task E2E-1: Install Playwright + config + script

**Files:**
- Modify: `apps/desktop/package.json` (devDep `@playwright/test`, script `test:e2e`)
- Create: `apps/desktop/playwright.config.ts`

1. `pnpm --filter desktop add -D @playwright/test`.
2. `package.json` scripts: `"test:e2e": "playwright test"`.
3. `playwright.config.ts`:

```typescript
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
```

## Task E2E-2: Electron launch fixture

**Files:** Create `apps/desktop/e2e/fixtures.ts`

```typescript
import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Launches the built Electron app with an isolated, throwaway user-data dir so the
// real connection store is never read or mutated. ELECTRON_IS_DEV=0 forces the
// main process to load the built renderer (no vite dev server needed).
type Fixtures = { app: ElectronApplication; firstWindow: Page };

export const test = base.extend<Fixtures>({
  app: async ({}, use) => {
    const desktopRoot = path.resolve(__dirname, '..');
    const mainEntry = path.join(desktopRoot, 'dist', 'main', 'index.js');
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-e2e-'));
    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ELECTRON_IS_DEV: '0' },
    });
    await use(app);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },
  firstWindow: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

export const expect = test.expect;
```

## Task E2E-3: Smoke test

**Files:** Create `apps/desktop/e2e/smoke.spec.ts`

```typescript
import { test, expect } from './fixtures';

test('app boots and shows the connections sidebar', async ({ firstWindow }) => {
  await expect(firstWindow.locator('.sidebar-head h2')).toHaveText('Connections');
  // Isolated user-data dir → no saved profiles → empty state.
  await expect(firstWindow.locator('text=No connections')).toBeVisible();
});

test('the New button reveals and hides the connection form', async ({ firstWindow }) => {
  const newBtn = firstWindow.locator('.sidebar-head button');
  await expect(newBtn).toContainText('New');
  await newBtn.click();
  // Form appears with the database-type selector and its three drivers.
  const driverSelect = firstWindow.locator('.conn-form select').first();
  await expect(driverSelect).toBeVisible();
  await expect(driverSelect.locator('option')).toHaveCount(3); // MySQL / PostgreSQL / Redis
  await expect(newBtn).toContainText('Cancel');
  await newBtn.click();
  await expect(newBtn).toContainText('New');
});
```

## Task E2E-4: Build prerequisites + run

1. Ensure prerequisites are current: `pnpm build:engine`, `pnpm --filter renderer build`, `pnpm --filter desktop build` (tsc → `dist/main`).
2. Run: `pnpm --filter desktop test:e2e`.
3. Expected: both tests pass.

## Task E2E-5: Commit + merge

```bash
git add -A && git commit -m "test(e2e): Playwright Electron smoke harness for the connection UI"
git checkout main && git merge --no-ff feat/e2e-playwright -m "Merge feat/e2e-playwright: Playwright Electron UI test harness"
```
