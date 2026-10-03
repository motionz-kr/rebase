import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('query result column resizing', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-grid-resize-'));
  const databaseFile = path.join(fixtureDir, 'grid_resize_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, "CREATE TABLE result_grid_resize_e2e (id INTEGER PRIMARY KEY, description TEXT); INSERT INTO result_grid_resize_e2e VALUES (1, 'A value to display in the result grid');"]);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('resizes a result column from its current rendered width and keeps the width on its cells', async ({ firstWindow: win }) => {
    await win.setViewportSize({ width: 1600, height: 900 });
    await win.getByRole('button', { name: '새 연결' }).click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E result grid resize');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E result grid resize' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await typeQuery(win, 'SELECT id, description FROM result_grid_resize_e2e ORDER BY id;');
    await win.locator('.editor-toolbar .btn-primary').click();
    const grid = win.locator('.results > .grid');
    await expect(grid.locator('.grid-body .grid-row')).toHaveCount(1, { timeout: 15_000 });

    const headers = grid.locator('.grid-head-cell');
    await expect(headers).toHaveCount(2);
    const idHeader = headers.nth(0);
    const header = headers.nth(1);
    const idInitialWidth = await idHeader.evaluate((element) => element.getBoundingClientRect().width);
    const initialWidth = await header.evaluate((element) => element.getBoundingClientRect().width);
    expect(idInitialWidth).toBeGreaterThan(250);
    expect(initialWidth).toBeGreaterThan(250);

    const dragBy = async (target: typeof header, delta: number) => {
      const handleBox = await target.locator('.col-resizer').boundingBox();
      expect(handleBox).not.toBeNull();
      const startX = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2;
      const startY = (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2;
      await win.mouse.move(startX, startY);
      await win.mouse.down();
      await win.mouse.move(startX + delta, startY, { steps: 3 });
      await win.mouse.up();
    };
    await dragBy(header, 12);

    await expect.poll(async () => header.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(initialWidth + 8);
    const resizedWidth = await header.evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.abs(resizedWidth - initialWidth - 12)).toBeLessThanOrEqual(2);
    const idWidthAfterDescriptionResize = await idHeader.evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.abs(idWidthAfterDescriptionResize - idInitialWidth)).toBeLessThanOrEqual(1);

    const bodyCell = grid.locator('.grid-body .grid-row').first().locator('.grid-cell').nth(1);
    const cellWidth = await bodyCell.evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.abs(cellWidth - resizedWidth)).toBeLessThanOrEqual(1);

    const storedWidths = await win.evaluate(() => JSON.parse(localStorage.getItem('rebase.ui.colWidths') ?? '{}') as Record<string, number>);
    expect(storedWidths.description).toBe(resizedWidth);
    expect(storedWidths.id).toBe(idInitialWidth);

    await dragBy(idHeader, 18);
    const resizedIdWidth = await idHeader.evaluate((element) => element.getBoundingClientRect().width);
    const descriptionWidthAfterIdResize = await header.evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.abs(resizedIdWidth - idInitialWidth - 18)).toBeLessThanOrEqual(2);
    expect(Math.abs(descriptionWidthAfterIdResize - resizedWidth)).toBeLessThanOrEqual(1);

    const finalStoredWidths = await win.evaluate(() => JSON.parse(localStorage.getItem('rebase.ui.colWidths') ?? '{}') as Record<string, number>);
    expect(finalStoredWidths.description).toBe(resizedWidth);
    expect(finalStoredWidths.id).toBe(resizedIdWidth);
  });
});
