import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

// "내보내기 ▾ → CSV/JSON" must open the menu and put a file on disk. Downloads are
// redirected via session will-download (no native dialog). Regression: ResultGrid's
// outside-click listener used to close the menu during the click that opened it.
test.describe('result export', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-result-export-'));
  const databaseFile = path.join(fixtureDir, 'result_export_e2e.db');
  const outDir = path.join(fixtureDir, 'out');

  test.beforeAll(() => {
    fs.mkdirSync(outDir, { recursive: true });
    execFileSync('sqlite3', [databaseFile, "CREATE TABLE export_e2e (id INTEGER PRIMARY KEY, name TEXT, memo TEXT); INSERT INTO export_e2e VALUES (1, '홍길동', 'plain'), (2, '김, 철수', 'say \"hi\"'), (3, NULL, 'x');"]);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('export menu opens; CSV (UTF-8 BOM) and JSON downloads are saved', async ({ app, firstWindow: win }) => {
    await win.getByRole('button', { name: '새 연결', exact: true }).click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E result export');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();
    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E result export' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    await typeQuery(win, 'SELECT id, name, memo FROM export_e2e ORDER BY id;');
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.results > .grid .grid-body .grid-row')).toHaveCount(3, { timeout: 15_000 });

    // Save every download into the temp dir (no native dialog) and record its end state.
    await app.evaluate(({ session }, dir) => {
      const g = globalThis as unknown as { __downloads: Array<{ filename: string; state?: string }> };
      g.__downloads = [];
      session.defaultSession.on('will-download', (_e, item) => {
        const rec: { filename: string; state?: string } = { filename: item.getFilename() };
        g.__downloads.push(rec);
        item.setSavePath(`${dir}/${item.getFilename()}`);
        item.once('done', (_ev, state) => { rec.state = state; });
      });
    }, outDir);
    const downloads = () => app.evaluate(() => (globalThis as unknown as { __downloads: Array<{ filename: string; state?: string }> }).__downloads);

    const exportBtn = win.getByRole('button', { name: /내보내기/ });
    const menu = win.locator('.grid-export-menu');

    // Regression: the menu must stay open after the click that opens it (a window
    // click listener used to close it in the same event).
    await exportBtn.click();
    await expect(menu).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await exportBtn.click();
    await expect(menu).toBeVisible();
    await win.locator('.grid-toolbar .input').click(); // outside click closes it
    await expect(menu).toHaveCount(0);

    // CSV
    await exportBtn.click();
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'CSV', exact: true }).click();
    await expect.poll(async () => (await downloads()).find((d) => d.filename.endsWith('.csv'))?.state, { timeout: 10_000 }).toBe('completed');
    const csvName = (await downloads()).find((d) => d.filename.endsWith('.csv'))!.filename;
    expect(csvName).toMatch(/^result-\d{8}-\d{6}\.csv$/);
    const csv = fs.readFileSync(path.join(outDir, csvName));
    expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.subarray(3).toString('utf8')).toBe('id,name,memo\n1,홍길동,plain\n2,"김, 철수","say ""hi"""\n3,,x');

    // JSON (no BOM)
    await exportBtn.click();
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'JSON', exact: true }).click();
    await expect.poll(async () => (await downloads()).find((d) => d.filename.endsWith('.json'))?.state, { timeout: 10_000 }).toBe('completed');
    const jsonName = (await downloads()).find((d) => d.filename.endsWith('.json'))!.filename;
    const json = fs.readFileSync(path.join(outDir, jsonName));
    expect(json[0]).toBe(0x5b); // '[' — no BOM
    expect(JSON.parse(json.toString('utf8'))).toEqual([
      { id: 1, name: '홍길동', memo: 'plain' },
      { id: 2, name: '김, 철수', memo: 'say "hi"' },
      { id: 3, name: null, memo: 'x' },
    ]);
  });
});
