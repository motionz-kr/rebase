import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { connectMySql } from './helpers';

test.describe('connection schema visibility', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port} — skipping schema visibility test`);
  });

  test('hides and restores a selected schema in the left explorer', async ({ firstWindow: win }) => {
    await connectMySql(win);

    const dbRow = win.locator(`.tree-row:has(.tree-label:text-is("${MYSQL.database}"))`).first();
    await expect(dbRow).toBeVisible({ timeout: 15_000 });

    await win.locator('.conn-row .icon-btn[title="Edit profile"]').click();
    await win.locator('.conn-modal-tabs .seg-tab').filter({ hasText: '스키마' }).click();

    const preferenceRow = win.locator('.ctp-tree .tree-node').filter({ hasText: MYSQL.database }).first();
    await expect(preferenceRow).toBeVisible({ timeout: 15_000 });
    const preferenceCheckbox = preferenceRow.locator('input[type="checkbox"]').first();
    await expect(preferenceCheckbox).toBeChecked();
    await preferenceCheckbox.uncheck();
    await expect(preferenceCheckbox).not.toBeChecked({ timeout: 15_000 });

    await win.locator('.conn-modal .modal-head .icon-btn').click();
    await expect(win.locator(`.tree-row:has(.tree-label:text-is("${MYSQL.database}"))`)).toHaveCount(0);

    await win.locator('.conn-row .icon-btn[title="Edit profile"]').click();
    await win.locator('.conn-modal-tabs .seg-tab').filter({ hasText: '스키마' }).click();
    const restoredCheckbox = win.locator('.ctp-tree .tree-node').filter({ hasText: MYSQL.database }).first().locator('input[type="checkbox"]').first();
    await restoredCheckbox.check();
    await win.locator('.conn-modal .modal-head .icon-btn').click();
    await expect(win.locator(`.tree-row:has(.tree-label:text-is("${MYSQL.database}"))`)).toBeVisible({ timeout: 15_000 });
  });
});
