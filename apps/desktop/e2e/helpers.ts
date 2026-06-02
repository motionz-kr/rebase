import { expect, type Page } from '@playwright/test';
import { MYSQL } from './dbProbe';

// Create a MySQL connection profile via the UI form and open it. Assumes a fresh
// (profile-less) app instance. Leaves the connection panel visible.
export async function connectMySql(win: Page, name = 'E2E MySQL') {
  await win.locator('.sidebar-head button').click();
  const form = win.locator('.conn-form');
  await form.locator('label:text-is("Profile name") + input').fill(name);
  await form.locator('label:text-is("Host") + input').fill(MYSQL.host);
  await form.locator('label:text-is("Port") + input').fill(String(MYSQL.port));
  await form.locator('label:text-is("Database") + input').fill(MYSQL.database);
  await form.locator('label:text-is("Username") + input').fill(MYSQL.username);
  await form.locator('label:has-text("Password") + input').fill(MYSQL.password);
  await form.locator('button[type="submit"]').click();

  const row = win.locator('.conn-list .conn-row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.click();
  await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });
}

// Replace the Monaco editor contents with `sql`, dismissing any autocomplete popup.
export async function typeQuery(win: Page, sql: string) {
  const editor = win.locator('.conn-panel .monaco-editor').first();
  await editor.click();
  await win.keyboard.press('ControlOrMeta+a');
  await win.keyboard.type(sql);
  await win.keyboard.press('Escape');
}
