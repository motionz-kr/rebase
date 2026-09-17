import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('visual EXPLAIN plan', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-explain-plan-'));
  const databaseFile = path.join(fixtureDir, 'explain_plan_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE explain_plan_e2e (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO explain_plan_e2e VALUES (1, \'one\'), (2, \'two\');']);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('renders a SQLite plan and can switch to the original result grid', async ({ firstWindow: win }) => {
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SQLite EXPLAIN');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SQLite EXPLAIN' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await typeQuery(win, 'SELECT * FROM explain_plan_e2e WHERE id = 1;');
    await win.locator('.editor-toolbar button').filter({ hasText: 'EXPLAIN' }).click();

    const plan = win.getByRole('region', { name: 'Query execution plan' });
    await expect(plan).toBeVisible({ timeout: 15_000 });
    await expect(plan.locator('.explain-plan-format')).toHaveText('SQLite');
    await expect(plan.locator('.explain-plan-operation')).toContainText(/SEARCH|SCAN/);

    await plan.getByRole('button', { name: 'Raw result' }).click();
    await expect(plan.locator('.grid')).toBeVisible();
    await expect(plan.locator('.grid-head')).toContainText('detail');
    await expect(plan.locator('.grid-cell').filter({ hasText: /SEARCH|SCAN/ })).toBeVisible();

    await plan.getByRole('button', { name: 'Plan', exact: true }).click();
    await expect(plan.locator('.explain-plan-tree')).toBeVisible();
    await expect(plan.locator('.grid')).toHaveCount(0);
  });
});
