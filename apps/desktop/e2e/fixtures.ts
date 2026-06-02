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
    const enginePath = path.join(desktopRoot, 'bin', 'app-engine');
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-e2e-'));
    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      // ELECTRON_IS_DEV=0 loads the built renderer (no vite needed); the unpackaged
      // engine binary then needs an explicit path since resourcesPath won't have it.
      // ENGINE_DB_PATH isolates the profile store so tests never touch the real
      // ~/.antigravity/metadata.db and each run starts with zero connections.
      env: {
        ...process.env,
        ELECTRON_IS_DEV: '0',
        ENGINE_BINARY_PATH: enginePath,
        ENGINE_DB_PATH: path.join(userDataDir, 'metadata.db'),
      },
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
