import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { withConn } from './db';
import { connectMySql, typeQuery } from './helpers';

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

  test('Templates tab → domain settings → run dup-by-column template', async ({ app, firstWindow: win }, testInfo) => {
    test.setTimeout(120_000);
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(1360, 860);
      w.center();
    });

    await connectMySql(win, 'Templates MySQL');

    await typeQuery(win, `SELECT * FROM ${TABLE} WHERE phone = '010-1111-2222'`);
    await win.locator('.editor-toolbar button', { hasText: 'Save' }).click();
    const saveQueryDialog = win.locator('.modal', { hasText: 'Save query' });
    await expect(saveQueryDialog).toBeVisible({ timeout: 10_000 });
    const titleInput = saveQueryDialog.locator('input[type="text"]');
    await expect(titleInput).not.toHaveValue('', { timeout: 10_000 });
    const generatedTitle = await titleInput.inputValue();
    await saveQueryDialog.locator('button[type="submit"]').click();
    await expect(saveQueryDialog).toHaveCount(0);

    // The old lower sidebar panel and separate Saved/History/Templates buttons are gone;
    // one Query Library button opens the large modal and its internal sections.
    await expect(win.locator('.conn-library-action')).toHaveCount(0);
    await win.locator('.query-library-action', { hasText: 'Query Library' }).click();
    await expect(win.locator('.library-modal')).toBeVisible({ timeout: 10_000 });
    await expect(win.locator('.library-modal .list-panel')).toContainText(generatedTitle);

    await win.locator('.library-tab', { hasText: 'History' }).click();
    await expect(win.locator('.library-modal .list-panel')).toContainText(/History|No query history/);

    await win.locator('.library-tab', { hasText: 'Templates' }).click();
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
    await win.screenshot({ path: testInfo.outputPath('task-templates.png') });

    // Follow-up bar present.
    await expect(runner.locator('.template-followups button', { hasText: 'CSV' })).toBeVisible();
  });
});
