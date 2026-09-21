import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('multi-statement policy resume', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-query-policy-resume-'));
  const databaseFile = path.join(fixtureDir, 'query_policy_resume_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [
      databaseFile,
      'CREATE TABLE policy_resume_e2e (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
    ]);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('resumes from the approved statement without replaying successful statements', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);

    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SQLite policy resume');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SQLite policy resume' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });
    // Let the initial SQLite schema/completion request release its read handle
    // before the write session is opened for this deterministic policy flow.
    await win.waitForTimeout(500);

    await win.getByTestId('query-mode-write').click();
    await win.getByTestId('tx-mode-manual').click();
    await typeQuery(win, [
      "INSERT INTO policy_resume_e2e (id, value) VALUES (1, 'first');",
      'UPDATE policy_resume_e2e SET value = \'updated\';',
      "INSERT INTO policy_resume_e2e (id, value) VALUES (2, 'second');",
    ].join('\n'));
    await win.locator('.editor-toolbar .btn-primary').click();

    const banner = win.locator('.policy-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner.getByRole('button', { name: 'Run anyway' })).toBeVisible();
    await expect(win.locator('.result-chip')).toHaveCount(1);

    await banner.getByRole('button', { name: 'Run anyway' }).click();
    await expect(banner).toHaveCount(0);
    await expect(win.locator('.result-chip')).toHaveCount(3, { timeout: 20_000 });
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션');
    await win.getByTestId('tx-commit').click();
    await expect(win.locator('.transaction-notice')).toHaveText('Committed');

    const rows = execFileSync('sqlite3', [databaseFile, 'SELECT COUNT(*) FROM policy_resume_e2e;'], { encoding: 'utf8' }).trim();
    const values = execFileSync('sqlite3', [databaseFile, 'SELECT id || \'=\' || value FROM policy_resume_e2e ORDER BY id;'], { encoding: 'utf8' }).trim();
    expect(rows).toBe('2');
    expect(values).toBe('1=updated\n2=second');
  });
});
