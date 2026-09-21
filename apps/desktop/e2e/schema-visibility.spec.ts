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
    await expect(win.getByText('표시할 스키마가 없습니다. 연결 설정에서 선택하세요.')).toBeVisible({ timeout: 15_000 });

    await win.locator('.conn-row .icon-btn[title="Edit profile"]').click();
    await win.locator('.conn-modal-tabs .seg-tab').filter({ hasText: '스키마' }).click();

    const preferenceRow = win.locator('.ctp-tree .tree-node').filter({ hasText: MYSQL.database }).first();
    await expect(preferenceRow).toBeVisible({ timeout: 15_000 });
    const preferenceCheckbox = preferenceRow.locator('input[type="checkbox"]').first();
    const allSchemasCheckbox = win.getByTestId('schema-visibility-toggle-all');
    await expect(allSchemasCheckbox).not.toBeChecked({ timeout: 15_000 });
    await expect(preferenceCheckbox).not.toBeChecked({ timeout: 15_000 });

    await allSchemasCheckbox.check();
    await expect(allSchemasCheckbox).toBeChecked();
    await expect(preferenceCheckbox).toBeChecked();

    await win.locator('.conn-modal .modal-head .icon-btn').click();
    await expect(win.locator(`.tree-row:has(.tree-label:text-is("${MYSQL.database}"))`)).toBeVisible({ timeout: 15_000 });

    await win.locator('.conn-row .icon-btn[title="Edit profile"]').click();
    await win.locator('.conn-modal-tabs .seg-tab').filter({ hasText: '스키마' }).click();
    const hideAllSchemasCheckbox = win.getByTestId('schema-visibility-toggle-all');
    await hideAllSchemasCheckbox.uncheck();
    await expect(hideAllSchemasCheckbox).not.toBeChecked();
    await win.locator('.conn-modal .modal-head .icon-btn').click();
    await expect(win.locator(`.tree-row:has(.tree-label:text-is("${MYSQL.database}"))`)).toHaveCount(0);

    await win.locator('.conn-row .icon-btn[title="Edit profile"]').click();
    await win.locator('.conn-modal-tabs .seg-tab').filter({ hasText: '스키마' }).click();
    const restoredCheckbox = win.locator('.ctp-tree .tree-node').filter({ hasText: MYSQL.database }).first().locator('input[type="checkbox"]').first();
    await restoredCheckbox.check();
    await expect(restoredCheckbox).toBeChecked();
    await win.locator('.conn-modal .modal-head .icon-btn').click();
    await expect(win.locator(`.tree-row:has(.tree-label:text-is("${MYSQL.database}"))`)).toBeVisible({ timeout: 15_000 });
  });
});
