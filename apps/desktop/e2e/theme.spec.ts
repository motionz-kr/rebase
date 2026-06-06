import { test, expect } from './fixtures';

// Live regression for the Light/Dark/System theme selector (AGENTS Rule 0).
// The fixture boots with an isolated user-data dir, so no theme.json exists and
// the app must fall back to the default source ('dark').

test('boots with the default dark theme', async ({ firstWindow }) => {
  await expect(firstWindow.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the settings popover toggles light / dark / system', async ({ firstWindow }) => {
  const gear = firstWindow.locator('.icon-btn[title="설정"]');
  await gear.click();
  const popover = firstWindow.locator('.settings-popover');
  await expect(popover).toBeVisible();

  const seg = (label: string) =>
    popover.locator('.theme-seg', { hasText: label });
  const html = firstWindow.locator('html');

  // Light: html flips to light and the segment reports itself selected.
  await seg('라이트').click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(seg('라이트')).toHaveAttribute('aria-checked', 'true');

  // Dark: explicit switch back.
  await seg('다크').click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(seg('다크')).toHaveAttribute('aria-checked', 'true');

  // System: source becomes 'system'; resolved is whatever the OS reports, so the
  // html attribute must be one of the two concrete themes (never 'system').
  await seg('시스템').click();
  await expect(seg('시스템')).toHaveAttribute('aria-checked', 'true');
  await expect(html).toHaveAttribute('data-theme', /^(light|dark)$/);
});

test('the chosen source round-trips through the main process', async ({ firstWindow }) => {
  const gear = firstWindow.locator('.icon-btn[title="설정"]');
  await gear.click();
  await firstWindow.locator('.settings-popover .theme-seg', { hasText: '라이트' }).click();
  await expect(firstWindow.locator('html')).toHaveAttribute('data-theme', 'light');

  // The renderer's optimistic state is reconciled by an IPC round-trip to main
  // (nativeTheme + persisted theme.json). Confirm main agrees.
  const ipc = await firstWindow.evaluate(() => window.electronAPI.getTheme());
  expect(ipc).toEqual({ source: 'light', resolved: 'light' });
});
