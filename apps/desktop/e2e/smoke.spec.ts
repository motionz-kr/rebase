import { test, expect } from './fixtures';

test('app boots and shows the connections sidebar', async ({ firstWindow }) => {
  await expect(firstWindow.locator('.sidebar-head h2')).toHaveText('Connections');
  // Isolated user-data dir → no saved profiles → empty state.
  await expect(firstWindow.locator('text=No connections')).toBeVisible();
});

test('the New button reveals and hides the connection form', async ({ firstWindow }) => {
  const newBtn = firstWindow.locator('.sidebar-head button');
  await expect(newBtn).toContainText('New');
  await newBtn.click();
  // Form appears with the database-type selector and all supported drivers.
  const driverSelect = firstWindow.locator('.conn-form select').first();
  await expect(driverSelect).toBeVisible();
  await expect(driverSelect.locator('option')).toHaveText([
    'MySQL',
    'PostgreSQL',
    'SQL Server',
    'MongoDB',
    'Redis',
    'SQLite',
  ]);
  await expect(firstWindow.locator('.conn-modal')).toBeVisible();
  await firstWindow.locator('.conn-modal .modal-head button[aria-label="닫기"]').click();
  await expect(newBtn).toContainText('New');
});
