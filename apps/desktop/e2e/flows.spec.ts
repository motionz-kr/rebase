import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';

// Real end-to-end flows against a local MySQL (Electron → engine → MySQL →
// renderer). Read-only: only SELECTs are run, so no data is created or modified.
// Skips automatically when no MySQL is listening on 127.0.0.1:3306.
test.describe('MySQL real flows', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port} — skipping DB flow tests`);
  });

  test('connect via the form, run a query and a multi-statement script', async ({ firstWindow: win }) => {
    // Open the new-connection form and fill it (driver defaults to MySQL).
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('label:text-is("Profile name") + input').fill('E2E MySQL');
    await form.locator('label:text-is("Host") + input').fill(MYSQL.host);
    await form.locator('label:text-is("Port") + input').fill(String(MYSQL.port));
    await form.locator('label:text-is("Database") + input').fill(MYSQL.database);
    await form.locator('label:text-is("Username") + input').fill(MYSQL.username);
    await form.locator('label:has-text("Password") + input').fill(MYSQL.password);
    await form.locator('button[type="submit"]').click();

    // The saved profile appears in the list; click it to connect.
    const row = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E MySQL' });
    await expect(row).toBeVisible();
    await row.click();

    // The connection panel with the query editor opens.
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

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

// Replace the Monaco editor contents with `sql`, dismissing any autocomplete popup.
async function typeQuery(win: import('@playwright/test').Page, sql: string) {
  const editor = win.locator('.conn-panel .monaco-editor').first();
  await editor.click();
  await win.keyboard.press('ControlOrMeta+a');
  await win.keyboard.type(sql);
  await win.keyboard.press('Escape'); // close autocomplete if shown
}
