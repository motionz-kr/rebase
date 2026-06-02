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
  // Form appears with the database-type selector and its three drivers.
  const driverSelect = firstWindow.locator('.conn-form select').first();
  await expect(driverSelect).toBeVisible();
  await expect(driverSelect.locator('option')).toHaveCount(3); // MySQL / PostgreSQL / Redis
  await expect(newBtn).toContainText('Cancel');
  await newBtn.click();
  await expect(newBtn).toContainText('New');
});
