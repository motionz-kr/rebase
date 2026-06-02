import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { withConn } from './db';
import { connectMySql, typeQuery } from './helpers';

// A single-table `SELECT *` result is shown in an editable table view so rows can
// be added/edited right from the query result. A non-`SELECT *` query stays in the
// read-only result grid.
const TABLE = 'editres_fixture';

test.describe('MySQL editable query result', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port} — skipping editable-result test`);
    await withConn(async (c) => {
      await c.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
      await c.query(`CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, label VARCHAR(20))`);
      await c.query(`INSERT INTO \`${TABLE}\` (id, label) VALUES (1, 'one')`);
    });
  });

  test.afterAll(async () => {
    if (await isPortOpen(MYSQL.host, MYSQL.port)) {
      await withConn((c) => c.query(`DROP TABLE IF EXISTS \`${TABLE}\``));
    }
  });

  test('SELECT * opens an editable grid; a new row persists to MySQL', async ({ firstWindow: win }) => {
    await connectMySql(win);
    const panel = win.locator('.conn-panel:not([style*="none"])');

    // Editable: SELECT * → table view with add/edit controls.
    await typeQuery(win, `SELECT * FROM ${TABLE}`);
    await panel.locator('.editor-toolbar button', { hasText: 'Run' }).first().click();
    await expect(panel.locator('.tdv-head')).toBeVisible({ timeout: 15_000 });
    const addBtn = panel.locator('button', { hasText: '행 추가' });
    await expect(addBtn).toBeVisible();

    // Add a row and save through the preview modal.
    await addBtn.click();
    await panel.locator('.new-row input').nth(0).fill('2');
    await panel.locator('.new-row input').nth(1).fill('two');
    await panel.locator('button', { hasText: '저장' }).first().click();
    await win.locator('.modal-foot button', { hasText: '실행' }).click();
    await expect(win.locator('.modal-overlay')).toHaveCount(0, { timeout: 15_000 });

    const rows = await withConn(async (c) => {
      const [r] = await c.query(`SELECT label FROM \`${TABLE}\` WHERE id = 2`);
      return r as Array<{ label: string }>;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe('two');

    // Non-editable: a projected column query stays in the read-only result grid.
    await typeQuery(win, 'SELECT 1 AS x');
    await panel.locator('.editor-toolbar button', { hasText: 'Run' }).first().click();
    await expect(panel.locator('.grid-head-cell').filter({ hasText: 'x' })).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('.tdv-head')).toHaveCount(0);
  });
});
