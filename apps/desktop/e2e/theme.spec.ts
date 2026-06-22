import { test, expect } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';

// Live regression for the Light/Dark/System theme selector (AGENTS Rule 0).
// The fixture boots with an isolated user-data dir, so no theme.json exists and
// the app must fall back to the default source ('dark').

test('boots with the default dark theme', async ({ firstWindow }) => {
  await expect(firstWindow.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the settings page toggles light / dark / system', async ({ firstWindow }) => {
  const gear = firstWindow.locator('.icon-btn[title="설정"]');
  await gear.click();
  const settings = firstWindow.locator('.settings-page');
  await expect(settings).toBeVisible();
  await settings.locator('.settings-menu-item', { hasText: '테마' }).click();

  const seg = (label: string) =>
    settings.locator('.settings-theme-option', { hasText: label });
  const html = firstWindow.locator('html');

  // Light: html flips to light and the segment reports itself selected.
  await seg('라이트').click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(seg('라이트')).toHaveAttribute('aria-pressed', 'true');

  // Dark: explicit switch back.
  await seg('다크').click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(seg('다크')).toHaveAttribute('aria-pressed', 'true');

  // System: source becomes 'system'; resolved is whatever the OS reports, so the
  // html attribute must be one of the two concrete themes (never 'system').
  await seg('시스템').click();
  await expect(seg('시스템')).toHaveAttribute('aria-pressed', 'true');
  await expect(html).toHaveAttribute('data-theme', /^(light|dark)$/);
});

test('the chosen source round-trips through the main process', async ({ firstWindow }) => {
  const gear = firstWindow.locator('.icon-btn[title="설정"]');
  await gear.click();
  const settings = firstWindow.locator('.settings-page');
  await settings.locator('.settings-menu-item', { hasText: '테마' }).click();
  await settings.locator('.settings-theme-option', { hasText: '라이트' }).click();
  await expect(firstWindow.locator('html')).toHaveAttribute('data-theme', 'light');

  // The renderer's optimistic state is reconciled by an IPC round-trip to main
  // (nativeTheme + persisted theme.json). Confirm main agrees.
  const ipc = await firstWindow.evaluate(() => window.electronAPI.getTheme());
  expect(ipc).toEqual({ source: 'light', resolved: 'light' });
});

test('the settings page shows version and update status', async ({ firstWindow }) => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../..', 'package.json'), 'utf8')) as { version: string };

  await firstWindow.locator('.icon-btn[title="설정"]').click();
  const settings = firstWindow.locator('.settings-page');
  await expect(settings).toBeVisible();
  await expect(settings.locator('.settings-menu-item', { hasText: '일반' })).toHaveAttribute('aria-current', 'page');
  await expect(settings).toContainText(`v${pkg.version}`);
  await expect(settings).toContainText('아직 확인하지 않음');

  await firstWindow.evaluate(() => window.electronAPI.updateSimulate({ kind: 'available', version: '9.9.9', notes: '테스트 릴리스' }));
  await expect(settings).toContainText('새 버전 9.9.9 사용 가능');
  await expect(settings).toContainText('테스트 릴리스');
});
