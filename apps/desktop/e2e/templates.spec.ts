import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { withConn } from './db';
import { connectMySql } from './helpers';
import * as path from 'path';

// Live E2E for the task-templates feature (#105): connect → Templates tab →
// set domain bindings → run the "duplicate by column" built-in template →
// verify a result grid renders. Throwaway `erg_tpl_demo` table only.

const TABLE = 'erg_tpl_demo';

test.describe('Task templates', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port}`);
    await withConn(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await c.query(`CREATE TABLE ${TABLE} (
        id INT PRIMARY KEY, name VARCHAR(40), phone VARCHAR(20), hospitalId INT, deletedAt DATETIME NULL)`);
      await c.query(`INSERT INTO ${TABLE} VALUES
        (1,'Olivia','010-1111-2222',153,NULL),
        (2,'Liam','010-1111-2222',153,NULL),
        (3,'Emma','010-3333-4444',153,NULL),
        (4,'Noah','010-1111-2222',204,NULL),
        (5,'Ava','010-5555-6666',204,NULL)`);
    });
  });

  test.afterAll(async () => {
    if (!(await isPortOpen(MYSQL.host, MYSQL.port))) return;
    await withConn((c) => c.query(`DROP TABLE IF EXISTS ${TABLE}`));
  });

  test('Templates tab → domain settings → run dup-by-column template', async ({ app, firstWindow: win }) => {
    test.setTimeout(120_000);
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(1360, 860);
      w.center();
    });

    await connectMySql(win, 'Templates MySQL');

    // Open the Templates sidebar tab.
    await win.locator('.seg-tab', { hasText: 'Templates' }).click();
    await expect(win.locator('.templates-panel')).toBeVisible({ timeout: 10_000 });

    // Built-in templates listed by category.
    await expect(win.locator('.template-item', { hasText: '컬럼 기준 중복 행 찾기' })).toBeVisible();

    // Domain settings: auto-suggested bindings should pre-fill tenant→hospitalId.
    await win.locator('.templates-toolbar button', { hasText: '도메인 설정' }).click();
    const domainDialog = win.locator('.risk-dialog', { hasText: '도메인 설정' });
    await expect(domainDialog).toBeVisible({ timeout: 10_000 });
    // The first role select (Tenant) should have auto-selected a column.
    const tenantSelect = domainDialog.locator('.form-field', { hasText: 'Tenant' }).locator('select');
    await expect(tenantSelect).toHaveValue('hospitalId');
    await domainDialog.locator('button', { hasText: '저장' }).click();
    await expect(domainDialog).toBeHidden();

    // Select the duplicate-by-column template → runner opens in the main pane.
    await win.locator('.template-item', { hasText: '컬럼 기준 중복 행 찾기' }).click();
    const runner = win.locator('.template-runner');
    await expect(runner).toBeVisible({ timeout: 10_000 });

    // Fill the identifier params (table + dup column) and run.
    await runner.locator('.form-field', { hasText: '테이블' }).locator('select').selectOption(TABLE);
    await runner.locator('.form-field', { hasText: '중복 검사 컬럼' }).locator('select').selectOption('phone');
    await runner.locator('.template-actions button', { hasText: '실행' }).click();

    // Result grid renders with the duplicate phone group(s).
    await expect(runner.locator('.grid-head-cell').filter({ hasText: 'duplicateCount' })).toBeVisible({ timeout: 20_000 });
    await expect(runner.locator('.grid-body .grid-row').first()).toBeVisible();

    await win.waitForTimeout(400);
    await win.screenshot({ path: path.resolve(__dirname, '..', '..', '..', 'docs', 'task-templates.png') });

    // Follow-up bar present.
    await expect(runner.locator('.template-followups button', { hasText: 'CSV' })).toBeVisible();
  });
});
