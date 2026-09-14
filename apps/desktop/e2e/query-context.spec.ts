import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test.describe('SQLite schema query context', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-query-context-'));
  const databaseFile = path.join(fixtureDir, 'query_context_e2e.db');
  const databaseName = path.basename(databaseFile);

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE query_context_e2e (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO query_context_e2e VALUES (1, \'one\'), (2, \'two\');']);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('opens the editor from the database menu and keeps its selected database', async ({ firstWindow: win }) => {
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SQLite query context');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SQLite query context' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    const dbRow = win.locator(`.tree-row:has(.tree-label:text-is("${databaseName}"))`).first();
    await expect(dbRow).toBeVisible({ timeout: 10_000 });
    await dbRow.click({ button: 'right' });

    const queryInput = win.locator('.ctx-menu .ctx-item').first();
    await expect(queryInput).toContainText('쿼리 입력');
    await queryInput.click();
    await expect(win.locator('.editor-conn-db')).toHaveText(databaseName);

    await dbRow.click();
    const tableRow = win.locator('.tree-row:has(.tree-label:text-is("query_context_e2e"))');
    await expect(tableRow).toBeVisible({ timeout: 10_000 });
    await tableRow.click({ button: 'right' });
    await win.locator('.ctx-menu .ctx-item').filter({ hasText: '최근 500개 조회' }).click();
    await expect(win.locator('.editor-conn-db')).toHaveText(databaseName);
    await expect(win.locator('.conn-panel:not([style*="none"]) .grid-body .grid-row')).toHaveCount(2, { timeout: 15_000 });
  });
});
