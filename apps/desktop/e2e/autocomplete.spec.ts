import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { connectMySql } from './helpers';

test.describe('SQL autocomplete', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port}`);
  });

  test('light theme suggestions are readable and do not open after semicolon', async ({ firstWindow: win }, testInfo) => {
    await connectMySql(win, 'Autocomplete MySQL');

    await win.locator('.icon-btn[title="설정"]').click();
    const settings = win.locator('.settings-page');
    await settings.locator('.settings-menu-item', { hasText: '테마' }).click();
    await settings.locator('.settings-theme-option', { hasText: '라이트' }).click();
    await settings.locator('.icon-btn[aria-label="설정 닫기"]').click();
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');

    const editor = win.locator('.conn-panel:not([style*="none"]) .monaco-editor').first();
    await editor.click();
    await win.keyboard.press('ControlOrMeta+a');
    await win.keyboard.type('SELECT;');
    await expect(win.locator('.sql-ac')).toHaveCount(0);

    await win.keyboard.press('ControlOrMeta+a');
    await win.keyboard.type('SE');
    const autocomplete = win.locator('.sql-ac');
    await expect(autocomplete).toBeVisible({ timeout: 10_000 });
    await expect(autocomplete.locator('.sql-ac-label').first()).toHaveText(/SE/i);

    const activeLabelColor = await autocomplete.locator('.sql-ac-item.active .sql-ac-label').first().evaluate((el) => {
      return window.getComputedStyle(el).color;
    });
    expect(activeLabelColor).toBe('rgb(31, 35, 40)');

    await win.screenshot({ path: testInfo.outputPath('autocomplete-light.png') });
  });
});
