import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { withConn } from './db';
import { connectMySql } from './helpers';

// One-click "recent rows" from the table context menu: loads
// SELECT * ... ORDER BY <pk> DESC LIMIT 500 into the editor and runs it.
// Uses a throwaway table (read-only query, but isolated for determinism).
const TABLE = 'recent_e2e_fixture';

test.describe('MySQL recent-rows quick query', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port} — skipping recent-rows test`);
    await withConn(async (c) => {
      await c.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
      await c.query(`CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, label VARCHAR(20))`);
      await c.query(`INSERT INTO \`${TABLE}\` (id, label) VALUES (1,'a'), (2,'b'), (3,'c')`);
    });
  });

  test.afterAll(async () => {
    if (await isPortOpen(MYSQL.host, MYSQL.port)) {
      await withConn((c) => c.query(`DROP TABLE IF EXISTS \`${TABLE}\``));
    }
  });

  test('context-menu top item loads and runs the recent-rows query', async ({ firstWindow: win }) => {
    await connectMySql(win);

    const dbRow = win.locator(`.tree-row:has(.tree-label:text-is("${MYSQL.database}"))`).first();
    await expect(dbRow).toBeVisible({ timeout: 15_000 });
    const tableRow = win.locator(`.tree-row:has(.tree-label:text-is("${TABLE}"))`);
    if ((await tableRow.count()) === 0) await dbRow.click();
    await expect(tableRow).toBeVisible({ timeout: 15_000 });
    await tableRow.click({ button: 'right' });

    // The top menu item is the recent-rows quick query.
    const top = win.locator('.ctx-menu .ctx-item').first();
    await expect(top).toContainText('최근 500개 조회');
    await top.click();

    // The editor receives the ordered query and it auto-runs.
    await expect(win.locator('.conn-panel:not([style*="none"]) .monaco-editor').first()).toContainText(
      'ORDER BY `id` DESC LIMIT 500'
    );
    // Newest first → first grid row is id = 3.
    const firstRow = win.locator('.conn-panel:not([style*="none"]) .grid-body .grid-row').first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });
    await expect(firstRow).toContainText('3');
    await expect(win.locator('.conn-panel:not([style*="none"]) .grid-body .grid-row')).toHaveCount(3);
  });
});
