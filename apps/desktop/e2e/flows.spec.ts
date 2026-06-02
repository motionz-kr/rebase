import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { connectMySql, typeQuery } from './helpers';

// Real end-to-end flows against a local MySQL (Electron → engine → MySQL →
// renderer). Read-only: only SELECTs are run, so no data is created or modified.
// Skips automatically when no MySQL is listening on 127.0.0.1:3306.
test.describe('MySQL real flows', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port} — skipping DB flow tests`);
  });

  test('connect via the form, run a query and a multi-statement script', async ({ firstWindow: win }) => {
    await connectMySql(win);

    // --- single query ---
    await typeQuery(win, 'SELECT 1 AS one');
    await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
    await expect(win.locator('.conn-panel .grid-head-cell').filter({ hasText: 'one' })).toBeVisible({ timeout: 15_000 });
    await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toHaveText('1');

    // --- multi-statement script → two result chips ---
    await typeQuery(win, 'SELECT 1 AS a; SELECT 2 AS b');
    await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
    await expect(win.locator('.conn-panel .result-chip')).toHaveCount(2, { timeout: 15_000 });
  });
});
