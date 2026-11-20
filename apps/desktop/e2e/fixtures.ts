import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

// The engine stores every profile password in the REAL login Keychain (service
// AntigravityDBDesktop, account = profile secret_ref), independent of the temp
// metadata.db. Without cleanup each E2E run leaves dozens of entries behind, so
// after the app exits we delete exactly the refs listed in this test's own DB.
const KEYCHAIN_SERVICE = 'AntigravityDBDesktop';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The engine child can outlive Electron for a moment (SIGKILL on exit); don't read
// the DB while it may still be writing. Capped at 5s.
async function waitForEngineExit(userDataDir: string) {
  for (let i = 0; i < 50; i++) {
    try { execFileSync('pgrep', ['-f', userDataDir], { stdio: 'ignore' }); } catch { return; } // pgrep exits 1 when nothing matches
    await sleep(100);
  }
}

function readSecretRefs(metadataDb: string): string[] {
  const sql = 'SELECT secret_ref FROM connection_profiles;';
  // The engine runs metadata.db in WAL mode. After a clean engine shutdown the
  // -wal/-shm files are gone, and a pure `-readonly` connection then fails with
  // "unable to open database file" (it cannot recreate them). Fall back to a normal
  // open, which is safe here: the engine is dead and the DB is this test's own temp copy.
  for (const args of [['-readonly', metadataDb, sql], [metadataDb, sql]]) {
    try {
      return execFileSync('sqlite3', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\n').map((r) => r.trim()).filter(Boolean);
    } catch (e) {
      if (/no such table/i.test(String((e as { stderr?: unknown }).stderr))) return []; // nothing was created
      if (args.length === 2) console.warn(`E2E Keychain cleanup could not read ${metadataDb}: ${(e as Error).message}`);
    }
  }
  return [];
}

async function removeKeychainSecrets(userDataDir: string) {
  const metadataDb = path.join(userDataDir, 'metadata.db');
  if (process.platform !== 'darwin' || !fs.existsSync(metadataDb)) return;
  await waitForEngineExit(userDataDir);
  for (const ref of new Set(readSecretRefs(metadataDb))) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', ref], { stdio: 'ignore' });
    } catch (e) {
      if ((e as { status?: number }).status !== 44) console.warn(`E2E Keychain cleanup failed for ${ref}: ${(e as Error).message}`); // 44 = item not found
    }
  }
}

// Launches the built Electron app with an isolated, throwaway user-data dir so the
// real connection store is never read or mutated. ELECTRON_IS_DEV=0 forces the
// main process to load the built renderer (no vite dev server needed).
type Fixtures = { app: ElectronApplication; firstWindow: Page; launchEnv: Record<string, string> };

export const test = base.extend<Fixtures>({
  launchEnv: [{}, { option: true }],
  app: async ({ launchEnv }, use) => {
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
        ...launchEnv,
        ELECTRON_IS_DEV: '0',
        ENGINE_BINARY_PATH: enginePath,
        ENGINE_DB_PATH: path.join(userDataDir, 'metadata.db'),
      },
    });
    await use(app);
    // Graceful close can hang (engine child shutdown); cap it and force-kill.
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 12000))]);
    try {
      const child = app.process();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 2000);
          child.once('exit', () => { clearTimeout(timeout); resolve(); });
          child.kill('SIGKILL');
        });
      }
    } catch {
      /* already gone */
    }
    await removeKeychainSecrets(userDataDir);
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  },
  firstWindow: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

export const expect = test.expect;
