import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { connectMySql } from './helpers';

test.describe('connection credential persistence', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port} — skipping credential persistence test`);
  });

  test('keeps the keychain password when editing without entering a new password', async ({ firstWindow: win }) => {
    const originalName = 'E2E Credential Persistence';
    const editedName = 'E2E Credential Persistence Updated';

    await connectMySql(win, originalName);

    const originalRow = win.locator('.conn-list .conn-row').filter({ hasText: originalName });
    await originalRow.locator('button[title="Edit profile"]').click();
    const form = win.locator('.conn-form');
    await form.locator('label:text-is("Profile name") + input').fill(editedName);
    // Leave the password input blank: this is the user path that must preserve
    // the existing OS keychain entry.
    await expect(form.locator('label:has-text("Password") + input')).toHaveValue('');
    await form.locator('button[type="submit"]').click();

    const updatedRow = win.locator('.conn-list .conn-row').filter({ hasText: editedName });
    await expect(updatedRow).toBeVisible();
    await updatedRow.locator('button[title="Disconnect"]').click();
    await expect(updatedRow.locator('button[title="Disconnect"]')).toHaveCount(0);

    await updatedRow.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });
  });
});
