import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { withConn } from './db';
import { connectMySql } from './helpers';

// Write flow against a dedicated throwaway table in devdb (created and dropped by
// this spec). It never touches the user's own tables. Edits a cell in the grid,
// saves through the preview modal, and verifies the change landed in MySQL.
const TABLE = 'e2e_edit_fixture';

test.describe('MySQL edit flow', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port} — skipping edit flow test`);
    await withConn(async (c) => {
      await c.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
      await c.query(`CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, name VARCHAR(50))`);
      await c.query(`INSERT INTO \`${TABLE}\` (id, name) VALUES (1, 'alpha'), (2, 'beta')`);
    });
  });

  test.afterAll(async () => {
    if (await isPortOpen(MYSQL.host, MYSQL.port)) {
      await withConn((c) => c.query(`DROP TABLE IF EXISTS \`${TABLE}\``));
    }
  });

  test('edit a cell in the grid and save persists to MySQL', async ({ firstWindow: win }) => {
    await connectMySql(win);

    // Open the throwaway table's data view. The default DB may already be
    // expanded — only click to expand when the table row isn't showing yet
    // (an unconditional click would collapse it and hide the table).
    const dbRow = win.locator(`.tree-row:has(.tree-label:text-is("${MYSQL.database}"))`).first();
    await expect(dbRow).toBeVisible({ timeout: 15_000 });
    const tableRow = win.locator(`.tree-row:has(.tree-label:text-is("${TABLE}"))`);
    if ((await tableRow.count()) === 0) await dbRow.click();
    await expect(tableRow).toBeVisible({ timeout: 15_000 });
    await tableRow.dblclick();

    // Edit the 'alpha' cell → 'EDITED'.
    const cell = win.locator('.conn-panel .grid-body .grid-cell').filter({ hasText: 'alpha' }).first();
    await expect(cell).toBeVisible({ timeout: 15_000 });
    await cell.dblclick();
    const input = win.locator('.conn-panel .grid-cell.editing input');
    await expect(input).toBeVisible();
    await input.fill('EDITED');
    await win.keyboard.press('Enter');

    // Save → confirm in the preview modal.
    const saveBtn = win.locator('.conn-panel button').filter({ hasText: '저장' }).first();
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    const execBtn = win.locator('.modal-foot button').filter({ hasText: '실행' });
    await expect(execBtn).toBeVisible();
    await execBtn.click();
    await expect(win.locator('.modal-overlay')).toHaveCount(0, { timeout: 15_000 });

    // Verify the change is in MySQL (authoritative, via a direct connection).
    const name = await withConn(async (c) => {
      const [rows] = await c.query(`SELECT name FROM \`${TABLE}\` WHERE id = 1`);
      return (rows as Array<{ name: string }>)[0]?.name;
    });
    expect(name).toBe('EDITED');
  });
});
