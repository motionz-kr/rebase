import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { typeQuery } from './helpers';

test.describe('query tab context menu', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-tab-menu-'));
  const databaseFile = path.join(fixtureDir, 'tab_menu_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE e2e_tab_menu (id INTEGER PRIMARY KEY, value TEXT);']);
  });
  test.afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  const connect = async (win: Page) => {
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E tab menu');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();
    const connection = win.locator('.conn-row').filter({ hasText: 'E2E tab menu' });
    await connection.click();
    await expect(win.locator('.editor-toolbar')).toBeVisible({ timeout: 20_000 });
    return connection;
  };
  const close = async (win: Page, index: number, label: string) => {
    await win.locator('.etab').nth(index).click({ button: 'right' });
    await win.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(win.getByRole('menu')).toHaveCount(0);
  };
  const names = (win: Page) => win.locator('.etab-name');

  test('closes each scope relative to the clicked tab and persists the remaining editor', async ({ firstWindow: win }) => {
    const connection = await connect(win);
    for (let index = 1; index <= 5; index++) {
      if (index > 1) await win.locator('.etab-add').click();
      await typeQuery(win, `SELECT ${index} AS value;`);
    }
    // Right-clicking an inactive tab must not switch the active query.
    await win.locator('.etab').nth(2).click({ button: 'right' });
    await expect(win.locator('.etab.active .etab-name')).toHaveText('Query 5');
    await win.getByRole('menuitem', { name: '왼쪽 탭 닫기' }).click();
    await expect(names(win)).toHaveText(['Query 3', 'Query 4', 'Query 5']);
    await expect(win.locator('.etab.active .etab-name')).toHaveText('Query 5');

    await close(win, 1, '오른쪽 탭 닫기');
    await expect(names(win)).toHaveText(['Query 3', 'Query 4']);
    await expect(win.locator('.etab.active .etab-name')).toHaveText('Query 4');
    await expect(win.locator('.monaco-editor .view-line').first()).toContainText('SELECT 4 AS value');

    await close(win, 1, '현재 탭 닫기');
    await expect(names(win)).toHaveText(['Query 3']);
    await win.locator('.etab-add').click();
    await win.locator('.etab-add').click();
    await close(win, 0, '다른 탭 닫기');
    await expect(names(win)).toHaveText(['Query 3']);
    await expect(win.locator('.monaco-editor .view-line').first()).toContainText('SELECT 3 AS value');

    await connection.locator('button[title="Disconnect"]').click();
    await expect(connection.locator('button[title="Disconnect"]')).toHaveCount(0);
    await connection.click();
    await expect(win.locator('.editor-toolbar')).toBeVisible({ timeout: 20_000 });
    await expect(names(win)).toHaveText(['Query 3']);
    await expect(win.locator('.monaco-editor .view-line').first()).toContainText('SELECT 3 AS value');

    await win.locator('.etab-add').click();
    await close(win, 0, '모든 탭 닫기');
    await expect(names(win)).toHaveText(['Query 1']);
    await expect(win.locator('.editor-toolbar .btn-primary')).toBeDisabled();
    await expect(win.getByTestId('tx-mode-auto')).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByTestId('query-mode-readonly')).toHaveClass(/active/);
    await typeQuery(win, 'SELECT 42 AS value;');
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.grid-body .grid-cell').first()).toHaveAttribute('title', '42');
    // The sole tab can also be closed from the menu.
    await close(win, 0, '현재 탭 닫기');
    await expect(names(win)).toHaveText(['Query 1']);
    await expect(win.locator('.editor-toolbar .btn-primary')).toBeDisabled();
    await expect(win.locator('.grid-body .grid-cell')).toHaveCount(0);
  });

  test('disables empty scopes, dismisses the menu, and keeps it inside the viewport', async ({ firstWindow: win }) => {
    await connect(win);
    await win.locator('.etab').click({ button: 'right' });
    const menu = win.getByRole('menu', { name: '쿼리 탭 닫기' });
    for (const label of ['왼쪽 탭 닫기', '오른쪽 탭 닫기', '다른 탭 닫기']) {
      await expect(menu.getByRole('menuitem', { name: label })).toBeDisabled();
    }
    await win.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await win.locator('.etab-add').click();
    await win.locator('.etab').nth(0).click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: '왼쪽 탭 닫기' })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: '오른쪽 탭 닫기' })).toBeEnabled();
    await win.locator('.sidebar-head').click();
    await expect(menu).toHaveCount(0);
    await win.locator('.etab').nth(1).click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: '오른쪽 탭 닫기' })).toBeDisabled();
    await win.keyboard.press('Escape');

    // Supply viewport-edge contextmenu coordinates on the real tab.
    const viewport = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await win.locator('.etab').nth(1).evaluate((element, { width, height }) => {
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: width - 1, clientY: height - 1 }));
    }, viewport);
    await expect(menu).toBeInViewport();
    const bounds = await menu.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 7);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 7);
    await win.keyboard.press('Escape');

    await win.locator('.etab').nth(0).click({ button: 'right' });
    const screenshotDir = path.resolve(__dirname, '../test-results');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await win.screenshot({ path: path.join(screenshotDir, 'query-tab-context-menu.png') });
    // Keyboard selection skips disabled entries.
    await expect(menu.getByRole('menuitem', { name: '현재 탭 닫기' })).toBeFocused();
    await win.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: '다른 탭 닫기' })).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(names(win)).toHaveText(['Query 1']);
  });

  test('asks once for pending transactions, preserves tabs on cancel, and rolls back on close', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);
    await connect(win);
    await win.getByTestId('query-mode-write').click();
    await win.getByTestId('tx-mode-manual').click();
    await typeQuery(win, "INSERT INTO e2e_tab_menu VALUES (1, 'pending');");
    await win.locator('.editor-toolbar .btn-primary').click();
    const risk = win.locator('.risk-dialog');
    await expect(risk).toBeVisible({ timeout: 15_000 });
    await risk.getByRole('button', { name: '실행', exact: true }).click();
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션', { timeout: 20_000 });
    await win.locator('.etab-add').click();
    await win.getByTestId('tx-mode-manual').click();
    await typeQuery(win, 'SELECT 1;');
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션', { timeout: 20_000 });

    let confirms = 0;
    win.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('2개 탭');
      confirms++;
      await dialog.dismiss();
    });
    await close(win, 0, '모든 탭 닫기');
    await expect(names(win)).toHaveText(['Query 1', 'Query 2']);
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션');
    expect(confirms).toBe(1);

    win.on('dialog', async (dialog) => {
      confirms++;
      await dialog.accept();
    });
    await close(win, 0, '모든 탭 닫기');
    await expect(names(win)).toHaveText(['Query 1']);
    expect(confirms).toBe(2);
    expect(execFileSync('sqlite3', [databaseFile, 'SELECT COUNT(*) FROM e2e_tab_menu;'], { encoding: 'utf8' }).trim()).toBe('0');
    await win.getByTestId('session-manager-open').click();
    const manager = win.getByRole('dialog', { name: '세션 관리' });
    await expect(manager.getByTestId('session-manager-client')).toHaveCount(1);
    await expect(manager).toContainText('실행별 전용 연결');
  });

  test('protects a running tab while closing the other idle tabs', async ({ firstWindow: win }) => {
    await connect(win);
    await typeQuery(win, 'WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 100000000) SELECT sum(value) FROM numbers;');
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.editor-toolbar .btn-danger')).toBeVisible({ timeout: 15_000 });
    await win.locator('.etab-add').click();
    await win.locator('.etab-add').click();
    await win.locator('.etab').nth(0).click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: '현재 탭 닫기' })).toBeDisabled();
    await expect(win.getByRole('menuitem', { name: '모든 탭 닫기' })).toBeDisabled();
    await expect(win.locator('.etab').nth(0).getByRole('button')).toBeDisabled();
    await win.getByRole('menuitem', { name: '다른 탭 닫기' }).click();
    await expect(names(win)).toHaveText(['Query 1']);
    await expect(win.locator('.editor-toolbar .btn-danger')).toBeVisible();
  });
});
