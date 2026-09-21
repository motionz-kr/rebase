import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('connection session lifecycle', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-connection-lifecycle-'));
  const databaseFile = path.join(fixtureDir, 'connection_lifecycle_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE lifecycle_e2e (id INTEGER PRIMARY KEY, value TEXT NOT NULL);']);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('asks how to resolve a manual transaction before disconnect and allows reconnect', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SQLite lifecycle');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SQLite lifecycle' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await win.getByRole('button', { name: 'Write' }).click();
    await win.getByTestId('tx-mode-manual').click();
    await typeQuery(win, "INSERT INTO lifecycle_e2e (id, value) VALUES (1, 'pending');");
    await win.locator('.editor-toolbar .btn-primary').click();
    const riskDialog = win.locator('.risk-dialog');
    await expect(riskDialog).toBeVisible({ timeout: 15_000 });
    await riskDialog.getByRole('button', { name: '실행' }).click();
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션', { timeout: 20_000 });
    expect(execFileSync('sqlite3', [databaseFile, 'SELECT COUNT(*) FROM lifecycle_e2e;'], { encoding: 'utf8' }).trim()).toBe('0');

    await connection.locator('button[title="Disconnect"]').click();
    const disconnectDialog = win.getByRole('dialog');
    await expect(disconnectDialog).toContainText('미커밋 변경 사항이 있습니다');
    await disconnectDialog.getByTestId('disconnect-rollback').click();

    await expect(connection.locator('button[title="Disconnect"]')).toHaveCount(0);
    expect(execFileSync('sqlite3', [databaseFile, 'SELECT COUNT(*) FROM lifecycle_e2e;'], { encoding: 'utf8' }).trim()).toBe('0');

    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await win.getByRole('button', { name: 'Write' }).click();
    await win.getByTestId('tx-mode-manual').click();
    await typeQuery(win, "INSERT INTO lifecycle_e2e (id, value) VALUES (2, 'committed');");
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.risk-dialog')).toBeVisible({ timeout: 15_000 });
    await win.locator('.risk-dialog').getByRole('button', { name: '실행' }).click();
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션', { timeout: 20_000 });
    await win.getByTestId('tx-commit').click();
    await expect(win.locator('.transaction-notice')).toHaveText('Committed');
    expect(execFileSync('sqlite3', [databaseFile, 'SELECT COUNT(*) FROM lifecycle_e2e;'], { encoding: 'utf8' }).trim()).toBe('1');

    await connection.locator('button[title="Disconnect"]').click();
    await expect(connection.locator('button[title="Disconnect"]')).toHaveCount(0, { timeout: 20_000 });
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await typeQuery(win, 'WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 100000000) SELECT value FROM numbers;');
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.editor-toolbar .btn-danger')).toBeVisible({ timeout: 15_000 });
    await connection.locator('button[title="Disconnect"]').click();
    await expect(connection.locator('button[title="Disconnect"]')).toHaveCount(0, { timeout: 20_000 });
  });
});
