import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('query shortcut rerun', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-query-rerun-'));
  const databaseFile = path.join(fixtureDir, 'query_rerun_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE shortcut_e2e (id INTEGER PRIMARY KEY);']);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('Cmd/Ctrl+Enter reruns the final query after a trailing semicolon', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E query rerun');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E query rerun' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await typeQuery(win, 'SELECT random() AS value;');
    await win.locator('.editor-toolbar .btn-primary').click();

    const result = win.locator('.grid-body .grid-row .grid-cell').first();
    await expect(result).toBeVisible({ timeout: 20_000 });
    const firstValue = await result.getAttribute('title');

    const editor = win.locator('.conn-panel .monaco-editor').first();
    await editor.click();
    await win.keyboard.press('End');
    await win.keyboard.press('ControlOrMeta+Enter');

    await expect.poll(() => result.getAttribute('title'), { timeout: 20_000 }).not.toBe(firstValue);

    const secondValue = await result.getAttribute('title');
    await typeQuery(win, 'SELECT random() AS value; -- trailing note');
    await win.keyboard.press('ControlOrMeta+Enter');
    await expect
      .poll(() => result.getAttribute('title'), { timeout: 20_000 })
      .toMatch(/^-?\d+$/);
    await expect.poll(() => result.getAttribute('title'), { timeout: 20_000 }).not.toBe(secondValue);
  });
});
