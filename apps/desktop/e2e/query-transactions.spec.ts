import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('query tab transactions', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-query-transactions-'));
  const databaseFile = path.join(fixtureDir, 'query_transactions_e2e.db');
  const countRows = () => Number(execFileSync('sqlite3', [databaseFile, 'SELECT COUNT(*) FROM transaction_e2e;'], { encoding: 'utf8' }).trim());

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE transaction_e2e (id INTEGER PRIMARY KEY, value TEXT NOT NULL);']);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('commits and rolls back statements on the dedicated tab session', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SQLite transactions');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SQLite transactions' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await win.getByRole('button', { name: 'Write' }).click();
    await win.getByTestId('tx-mode-manual').click();
    await expect(win.getByTestId('transaction-status')).toHaveText(/Manual · 대기/);

    await typeQuery(win, "INSERT INTO transaction_e2e (id, value) VALUES (1, 'committed');");
    await win.locator('.editor-toolbar .btn-primary').click();
    const riskDialog = win.locator('.risk-dialog');
    if (await riskDialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      const acknowledgement = riskDialog.locator('.risk-ack input');
      if (await acknowledgement.count()) await acknowledgement.check();
      await riskDialog.getByRole('button', { name: '실행' }).click();
    }
    if (await win.locator('.policy-banner').isVisible().catch(() => false)) {
      const banner = win.locator('.policy-banner');
      if (await banner.getByRole('button', { name: 'Enable write & run' }).isVisible().catch(() => false)) {
        await banner.getByRole('button', { name: 'Enable write & run' }).click();
      } else if (await banner.getByRole('button', { name: 'Run anyway' }).isVisible().catch(() => false)) {
        await banner.getByRole('button', { name: 'Run anyway' }).click();
      }
    }
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션', { timeout: 20_000 });
    await expect(win.locator('.alert')).toContainText('Rows affected: 1');
    await expect(win.getByTestId('tx-commit')).toBeInViewport();
    await expect(win.getByTestId('tx-rollback')).toBeInViewport();
    expect(countRows()).toBe(0);

    const screenshotDir = path.resolve(__dirname, '../test-results');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.mouse.move(700, 250);
    await win.screenshot({ path: path.join(screenshotDir, 'query-transaction-active.png') });

    await win.getByTestId('tx-commit').click();
    await expect(win.locator('.transaction-notice')).toHaveText('Committed');
    expect(countRows()).toBe(1);

    await typeQuery(win, "INSERT INTO transaction_e2e (id, value) VALUES (2, 'rolled back');");
    await win.locator('.editor-toolbar .btn-primary').click();
    if (await riskDialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      const acknowledgement = riskDialog.locator('.risk-ack input');
      if (await acknowledgement.count()) await acknowledgement.check();
      await riskDialog.getByRole('button', { name: '실행' }).click();
    }
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션', { timeout: 20_000 });
    expect(countRows()).toBe(1);
    await win.getByTestId('tx-rollback').click();
    await expect(win.locator('.transaction-notice')).toHaveText('Rolled back');
    expect(countRows()).toBe(1);
  });
});
