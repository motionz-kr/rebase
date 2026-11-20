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
const CMD_TIMEOUT_MS = 5_000;
const TOTAL_CLEANUP_MS = 20_000;

// Every cleanup subprocess is bounded by its own timeout and by the shared deadline.
function run(deadline: number, cmd: string, args: string[]): string {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`cleanup time budget (${TOTAL_CLEANUP_MS}ms) exhausted before ${cmd}`);
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.min(CMD_TIMEOUT_MS, remaining), killSignal: 'SIGKILL' });
}

// The engine child can outlive Electron for a moment (SIGKILL on exit). Returns true
// only when pgrep positively reports no process still referencing the temp dir
// (exit status 1); any other outcome (still running, pgrep error/timeout) is "unknown".
async function engineHasExited(userDataDir: string, deadline: number): Promise<boolean> {
  for (let i = 0; i < 50 && Date.now() < deadline; i++) {
    try {
      run(deadline, 'pgrep', ['-f', userDataDir]); // status 0: something still matches
    } catch (e) {
      if ((e as { status?: number }).status === 1) return true;
      return false; // pgrep itself failed or timed out: cannot confirm
    }
    await sleep(100);
  }
  return false;
}

// Returns null when the refs could not be read (so the caller keeps the temp dir).
function readSecretRefs(deadline: number, metadataDb: string): string[] | null {
  const sql = 'SELECT secret_ref FROM connection_profiles;';
  // -init /dev/null: never load the user's ~/.sqliterc (it could change output or .open another DB).
  const base = ['-init', '/dev/null', '-batch', '-noheader', '-list'];
  // The engine runs metadata.db in WAL mode. After a clean engine shutdown the
  // -wal/-shm files are gone, and a pure `-readonly` connection then fails with
  // "unable to open database file" (it cannot recreate them). Fall back to a normal
  // open, which is safe here: the engine is dead and the DB is this test's own temp copy.
  for (const args of [[...base, '-readonly', metadataDb, sql], [...base, metadataDb, sql]]) {
    try {
      return run(deadline, 'sqlite3', args).split('\n').map((r) => r.trim()).filter(Boolean);
    } catch (e) {
      if (/no such table/i.test(String((e as { stderr?: unknown }).stderr))) return []; // nothing was created
      if (args.length === base.length + 2) console.warn(`E2E Keychain cleanup could not read ${metadataDb}: ${(e as Error).message}`);
    }
  }
  return null;
}

// Returns true when it is safe to delete userDataDir. When the engine exit or the refs
// cannot be confirmed/processed, returns false: the temp metadata.db is then the only
// record of which Keychain accounts belong to this test, so the caller must keep it.
async function removeKeychainSecrets(userDataDir: string): Promise<boolean> {
  const metadataDb = path.join(userDataDir, 'metadata.db');
  if (process.platform !== 'darwin' || !fs.existsSync(metadataDb)) return true;
  const deadline = Date.now() + TOTAL_CLEANUP_MS;
  if (!(await engineHasExited(userDataDir, deadline))) {
    // Never read or delete while an engine might still be writing this DB.
    console.warn(`E2E Keychain cleanup skipped: could not confirm the engine has exited; keeping ${userDataDir} for manual cleanup`);
    return false;
  }
  const refs = readSecretRefs(deadline, metadataDb);
  if (refs === null) {
    console.warn(`E2E Keychain cleanup: keeping ${userDataDir} for manual cleanup`);
    return false;
  }
  let ok = true;
  for (const ref of new Set(refs)) {
    try {
      run(deadline, 'security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', ref]);
    } catch (e) {
      if ((e as { status?: number }).status === 44) continue; // item not found
      ok = false;
      console.warn(`E2E Keychain cleanup failed for ${ref}: ${(e as Error).message}`);
    }
  }
  if (!ok) console.warn(`E2E Keychain cleanup incomplete: keeping ${userDataDir} for manual cleanup`);
  return ok;
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
    if (await removeKeychainSecrets(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  firstWindow: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

export const expect = test.expect;
