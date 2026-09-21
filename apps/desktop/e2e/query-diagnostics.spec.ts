import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('query editor diagnostics', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-query-diagnostics-'));
  const databaseFile = path.join(fixtureDir, 'query_diagnostics_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE diagnostics_e2e (id INTEGER PRIMARY KEY, label TEXT);']);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('shows schema diagnostics inline and navigates to the reported line', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SQLite diagnostics');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SQLite diagnostics' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });
    const databaseRow = win.locator(`.tree-row:has(.tree-label:text-is("${path.basename(databaseFile)}"))`).first();
    await expect(databaseRow).toBeVisible({ timeout: 15_000 });
    await databaseRow.click();
    await expect(win.locator('.tree-row:has(.tree-label:text-is("diagnostics_e2e"))')).toBeVisible({ timeout: 15_000 });

    // The default SQLite catalog query is valid metadata SQL and must not be
    // shown as an unknown application table.
    await expect(win.getByTestId('sql-diagnostics')).toHaveCount(0);

    // Built-in values, table functions, generated targets, CTEs, and upsert
    // clauses must not be presented as missing application tables.
    const falsePositiveQueries = [
      'SELECT * FROM CURRENT_TIMESTAMP;',
      "SELECT $$ FROM missing_diagnostics_table; $$ AS body FROM diagnostics_e2e;",
      "SELECT * FROM json_each('{}') AS item;",
      "INSERT INTO diagnostics_e2e (id, label) VALUES (1, 'one') ON CONFLICT(id) DO UPDATE SET label = excluded.label;",
      'SELECT id INTO generated_diagnostics FROM diagnostics_e2e;',
      'WITH first_rows AS (SELECT id FROM diagnostics_e2e), second_rows AS (SELECT id FROM first_rows) SELECT id FROM second_rows;',
    ];
    for (const sql of falsePositiveQueries) {
      await typeQuery(win, sql);
      await expect(win.getByTestId('sql-diagnostics')).toHaveCount(0);
    }

    await typeQuery(win, 'SELECT d.missing FROM diagnostics_e2e AS d;');
    const diagnostics = win.getByTestId('sql-diagnostics');
    await expect(diagnostics).toBeVisible({ timeout: 15_000 });
    await expect(diagnostics).toContainText('컬럼을 찾을 수 없습니다: d.missing');
    await expect(win.locator('.monaco-editor .squiggly-error')).toBeVisible();
    await diagnostics.getByRole('button').filter({ hasText: 'd.missing' }).click();

    await typeQuery(win, 'SELECT * FROM missing_diagnostics_table;');
    await expect(diagnostics).toContainText('테이블을 찾을 수 없습니다: missing_diagnostics_table');
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.mouse.move(700, 250);
    await win.screenshot({ path: path.resolve(__dirname, '../test-results/query-diagnostics.png') });
  });
});
