import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('query risk confirmation', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-query-risk-'));
  const databaseFile = path.join(fixtureDir, 'query_risk_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [
      databaseFile,
      "CREATE TABLE risk_e2e (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO risk_e2e VALUES (1, 'before');",
    ]);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('runs a scoped UPDATE from read-only mode after one explicit risk confirmation', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);

    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SQLite risk confirmation');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SQLite risk confirmation' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await typeQuery(win, "UPDATE risk_e2e SET value = 'after' WHERE id = 1;");
    await win.locator('.editor-toolbar .btn-primary').click();

    const riskDialog = win.locator('.risk-dialog');
    await expect(riskDialog).toBeVisible({ timeout: 15_000 });
    await riskDialog.getByRole('button', { name: '실행' }).click();

    await expect(riskDialog).toHaveCount(0);
    await expect(win.locator('.policy-banner')).toHaveCount(0);
    await expect(win.locator('.alert')).toContainText('Statement executed.', { timeout: 20_000 });

    const value = execFileSync('sqlite3', [databaseFile, 'SELECT value FROM risk_e2e WHERE id = 1;'], { encoding: 'utf8' }).trim();
    expect(value).toBe('after');
    await expect(win.getByRole('button', { name: 'Read-only' })).toHaveClass(/active/);
  });
});
