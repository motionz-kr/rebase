import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { withConn } from './db';
import { connectMySql } from './helpers';

// Index management against a throwaway table in devdb (created/dropped here).
// Opens the index manager from the table context menu, creates a unique index,
// verifies it in MySQL, then drops it through the UI.
const TABLE = 'idx_e2e_fixture';

test.describe('MySQL index management', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port} — skipping index test`);
    await withConn(async (c) => {
      await c.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
      await c.query(`CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, a INT, b INT)`);
    });
  });

  test.afterAll(async () => {
    if (await isPortOpen(MYSQL.host, MYSQL.port)) {
      await withConn((c) => c.query(`DROP TABLE IF EXISTS \`${TABLE}\``));
    }
  });

  test('create and drop an index through the manager dialog', async ({ firstWindow: win }) => {
    win.on('dialog', (d) => d.accept()); // accept the drop confirm()
    await connectMySql(win);

    // Expand devdb and open the index manager from the table context menu.
    const dbRow = win.locator(`.tree-row:has(.tree-label:text-is("${MYSQL.database}"))`).first();
    await expect(dbRow).toBeVisible({ timeout: 15_000 });
    const tableRow = win.locator(`.tree-row:has(.tree-label:text-is("${TABLE}"))`);
    if ((await tableRow.count()) === 0) await dbRow.click();
    await expect(tableRow).toBeVisible({ timeout: 15_000 });
    await tableRow.click({ button: 'right' });
    await win.locator('.ctx-item').filter({ hasText: '인덱스 관리' }).click();

    // Dialog lists PRIMARY initially.
    await expect(win.locator('.idx-row .idx-name').filter({ hasText: 'PRIMARY' })).toBeVisible({ timeout: 15_000 });

    // Add a unique index on column 'a'.
    await win.locator('.idx-add-row .input').fill('idx_e2e_a');
    await win.locator('.idx-col-chip').filter({ hasText: 'a' }).locator('input').check();
    await win.locator('.idx-unique input').check();
    await win.locator('.modal-foot .btn-primary').click();

    // It appears in the list and exists in MySQL (unique, on column a).
    await expect(win.locator('.idx-row .idx-name').filter({ hasText: 'idx_e2e_a' })).toBeVisible({ timeout: 15_000 });
    const created = await withConn(async (c) => {
      const [rows] = await c.query(`SHOW INDEX FROM \`${TABLE}\` WHERE Key_name = 'idx_e2e_a'`);
      return rows as Array<{ Non_unique: number; Column_name: string }>;
    });
    expect(created.length).toBe(1);
    expect(created[0].Non_unique).toBe(0);
    expect(created[0].Column_name).toBe('a');

    // Drop it via the trash button → gone from list and from MySQL.
    await win.locator('.idx-row', { hasText: 'idx_e2e_a' }).locator('button').click();
    await expect(win.locator('.idx-row .idx-name').filter({ hasText: 'idx_e2e_a' })).toHaveCount(0, { timeout: 15_000 });
    const afterDrop = await withConn(async (c) => {
      const [rows] = await c.query(`SHOW INDEX FROM \`${TABLE}\` WHERE Key_name = 'idx_e2e_a'`);
      return (rows as unknown[]).length;
    });
    expect(afterDrop).toBe(0);
  });
});
