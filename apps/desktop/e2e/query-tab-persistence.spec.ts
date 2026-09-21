import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('query tab persistence and session manager', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-query-tabs-'));
  const databaseFile = path.join(fixtureDir, 'query_tabs_e2e.db');
  const databaseName = path.basename(databaseFile);

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE query_tabs_e2e (id INTEGER PRIMARY KEY, value TEXT);']);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('restores profile-scoped tabs and exposes each tab as an independent client', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);

    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SQLite query tabs');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SQLite query tabs' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });
    await expect(win.locator('.editor-conn-db')).toContainText(databaseName);

    await typeQuery(win, 'SELECT 1 AS first;');
    await win.locator('.etab-add').click();
    await typeQuery(win, 'SELECT 2 AS second;');
    await expect(win.locator('.etab')).toHaveCount(2);
    await expect(win.locator('.etab').nth(0)).toContainText(databaseName);
    await expect(win.locator('.etab').nth(1)).toContainText(databaseName);

    await win.getByTestId('session-manager-open').click();
    const manager = win.getByRole('dialog', { name: '세션 관리' });
    await expect(manager).toBeVisible();
    await expect(manager).toContainText('E2E SQLite query tabs');
    await expect(manager.getByTestId('session-manager-client')).toHaveCount(2);
    await expect(manager.getByTestId('session-manager-client').nth(0)).toContainText(databaseName);
    await expect(manager.getByTestId('session-manager-client').nth(1)).toContainText('실행별 전용 연결');
    await manager.getByRole('button', { name: '세션 관리 닫기' }).click();

    // Disconnecting unmounts the editor; the durable tab snapshot must survive
    // that lifecycle and be restored when the same profile reconnects.
    await connection.locator('button[title="Disconnect"]').click();
    await expect(connection.locator('button[title="Disconnect"]')).toHaveCount(0, { timeout: 20_000 });
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });
    await expect(win.locator('.etab')).toHaveCount(2);

    await win.locator('.etab').nth(0).click();
    await expect(win.locator('.conn-panel .monaco-editor .view-line').first()).toContainText('SELECT 1 AS first');
    await win.locator('.etab').nth(1).click();
    await expect(win.locator('.conn-panel .monaco-editor .view-line').first()).toContainText('SELECT 2 AS second');
    await expect(win.locator('.editor-conn-db')).toContainText(databaseName);
  });
});
