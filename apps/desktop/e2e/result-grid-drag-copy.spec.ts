import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('query result grid drag selection and copy', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-grid-copy-'));
  const databaseFile = path.join(fixtureDir, 'grid_drag_copy_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, "CREATE TABLE result_grid_drag_copy_e2e (id INTEGER PRIMARY KEY, label TEXT, active INTEGER); INSERT INTO result_grid_drag_copy_e2e VALUES (1, 'alpha', 1), (2, 'bravo', 0), (3, 'charlie', 1), (4, 'delta', 0); WITH RECURSIVE ids(n) AS (SELECT 5 UNION ALL SELECT n + 1 FROM ids WHERE n < 80) INSERT INTO result_grid_drag_copy_e2e SELECT n, 'row-' || n, n % 2 FROM ids;"]);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('copies rectangular cells, rows, columns, and the full result after dragging', async ({ firstWindow: win }) => {
    await win.setViewportSize({ width: 1600, height: 900 });
    await win.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E result grid drag copy');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E result grid drag copy' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await typeQuery(win, 'SELECT id, label, active FROM result_grid_drag_copy_e2e WHERE id <= 4 ORDER BY id;');
    await win.locator('.editor-toolbar .btn-primary').click();
    const grid = win.locator('.results > .grid');
    const rows = grid.locator('.grid-body .grid-row');
    await expect(rows).toHaveCount(4, { timeout: 15_000 });

    const cellAt = (row: number, col: number) => rows.nth(row).locator('.grid-cell').nth(col);
    const rowIndexAt = (row: number) => rows.nth(row).locator('.grid-idx');
    const drag = async (from: typeof rows, to: typeof rows) => {
      const fromBox = await from.boundingBox();
      const toBox = await to.boundingBox();
      expect(fromBox).not.toBeNull();
      expect(toBox).not.toBeNull();
      const sx = (fromBox?.x ?? 0) + (fromBox?.width ?? 0) / 2;
      const sy = (fromBox?.y ?? 0) + (fromBox?.height ?? 0) / 2;
      const tx = (toBox?.x ?? 0) + (toBox?.width ?? 0) / 2;
      const ty = (toBox?.y ?? 0) + (toBox?.height ?? 0) / 2;
      await win.mouse.move(sx, sy);
      await win.mouse.down();
      await win.mouse.move(tx, ty, { steps: 8 });
      await win.mouse.up();
    };
    const copy = async () => {
      await grid.focus();
      await win.keyboard.press('ControlOrMeta+C');
      return win.evaluate(() => navigator.clipboard.readText());
    };

    await drag(cellAt(1, 1), cellAt(2, 2));
    await expect(grid.locator('.grid-cell.sel')).toHaveCount(4);
    expect(await copy()).toBe('bravo\t0\ncharlie\t1');

    await drag(rowIndexAt(1), rowIndexAt(2));
    await expect(grid.locator('.grid-cell.sel')).toHaveCount(6);
    expect(await copy()).toBe('2\tbravo\t0\n3\tcharlie\t1');

    const headers = grid.locator('.grid-head-cell');
    const labelHeader = headers.nth(1);
    const activeHeader = headers.nth(2);
    await win.keyboard.down('Shift');
    await drag(labelHeader, activeHeader);
    await win.keyboard.up('Shift');
    await expect(grid.locator('.grid-cell.sel')).toHaveCount(8);
    expect(await copy()).toBe('alpha\t1\nbravo\t0\ncharlie\t1\ndelta\t0');

    await drag(rowIndexAt(0), rowIndexAt(3));
    await expect(grid.locator('.grid-cell.sel')).toHaveCount(12);
    expect(await copy()).toBe('1\talpha\t1\n2\tbravo\t0\n3\tcharlie\t1\n4\tdelta\t0');

    await typeQuery(win, 'SELECT id, label, active FROM result_grid_drag_copy_e2e ORDER BY id;');
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(rows.first()).toContainText('alpha', { timeout: 15_000 });
    const body = grid.locator('.grid-body');
    const bodyBox = await body.boundingBox();
    const firstIndexBox = await rowIndexAt(0).boundingBox();
    expect(bodyBox).not.toBeNull();
    expect(firstIndexBox).not.toBeNull();
    const startX = (firstIndexBox?.x ?? 0) + (firstIndexBox?.width ?? 0) / 2;
    const startY = (firstIndexBox?.y ?? 0) + (firstIndexBox?.height ?? 0) / 2;
    const edgeY = (bodyBox?.y ?? 0) + (bodyBox?.height ?? 0) - 8;
    await win.mouse.move(startX, startY);
    await win.mouse.down();
    await win.mouse.move(startX, edgeY, { steps: 12 });
    await expect.poll(() => body.evaluate((element) => element.scrollTop + element.clientHeight), { timeout: 15_000 }).toBeGreaterThan(2_520);
    await win.mouse.up();
    const allRowsClipboard = await copy();
    const copiedRows = allRowsClipboard.split('\n');
    expect(copiedRows).toHaveLength(80);
    expect(copiedRows[0]).toBe('1\talpha\t1');
    expect(copiedRows[79]).toBe('80\trow-80\t0');
  });
});
