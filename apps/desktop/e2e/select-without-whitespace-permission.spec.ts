import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('SELECT without whitespace before *', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-select-asterisk-'));
  const databaseFile = path.join(fixtureDir, 'select_asterisk_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [
      databaseFile,
      'CREATE TABLE AlimtalkTemplate (id INTEGER PRIMARY KEY); INSERT INTO AlimtalkTemplate (id) VALUES (7888);',
    ]);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('runs as read-only without asking to enable write mode', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);
    await win.getByRole('button', { name: '새 연결' }).click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SELECT asterisk');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SELECT asterisk' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });
    await expect(win.getByTestId('query-mode-readonly')).toHaveClass(/active/);

    await typeQuery(win, 'select* from AlimtalkTemplate where id = 7888');
    await win.locator('.editor-toolbar .btn-primary').click();

    const resultRow = win.locator('.grid-row').filter({ hasText: '7888' });
    await expect(resultRow).toBeVisible({ timeout: 20_000 });
    await expect(win.locator('.policy-banner')).toHaveCount(0);
  });
});
