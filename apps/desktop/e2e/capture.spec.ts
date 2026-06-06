import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { withConn } from './db';
import { typeQuery } from './helpers';
import * as path from 'path';
import * as fs from 'fs';

// Screenshot capture run (not a CI test). Seeds a throwaway `erg_readme_demo`
// table, drives the real app against local MySQL, and writes marketing PNGs to
// docs/. Run explicitly:
//   pnpm --filter desktop exec playwright test e2e/capture.spec.ts
//
// Throwaway table only (erg_ prefix); the user's data is never touched.

const OUT = path.resolve(__dirname, '..', '..', '..', 'docs');
const TABLE = 'erg_readme_demo';

test.describe('README screenshots', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port}`);
    await withConn(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await c.query(`CREATE TABLE ${TABLE} (
        id INT PRIMARY KEY,
        name VARCHAR(40),
        phone VARCHAR(20),
        hospitalId INT,
        status VARCHAR(12),
        visits INT,
        createdAt DATE
      )`);
      await c.query(`INSERT INTO ${TABLE} VALUES
        (1,'Olivia Bennett','010-2847-1193',153,'active',12,'2025-11-02'),
        (2,'Liam Carter','010-9933-2841',153,'active',3,'2026-01-14'),
        (3,'Emma Sullivan','010-4471-9920',153,'inactive',0,'2024-08-21'),
        (4,'Noah Whitfield','010-2210-7754',204,'active',7,'2025-06-30'),
        (5,'Ava Lindqvist','010-8890-1123',204,'inactive',1,'2024-03-11'),
        (6,'Mason Reyes','010-5512-6678',153,'inactive',0,'2023-12-05'),
        (7,'Sophia Nakamura','010-7741-3398',204,'active',21,'2026-02-19'),
        (8,'Ethan Delgado','010-3326-8845',153,'active',5,'2025-09-08')`);
    });
  });

  test.afterAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    if (!open) return;
    await withConn((c) => c.query(`DROP TABLE IF EXISTS ${TABLE}`));
  });

  test('capture hero + safe-execution-mode dialog', async ({ app, firstWindow: win }) => {
    test.setTimeout(120_000);
    // Roomy window for crisp marketing shots.
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(1360, 860);
      w.center();
    });

    // --- connect a SAFE-MODE MySQL connection via the form ---
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('label:text-is("Profile name") + input').fill('Production MySQL');
    await form.locator('label:text-is("Host") + input').fill(MYSQL.host);
    await form.locator('label:text-is("Port") + input').fill(String(MYSQL.port));
    await form.locator('label:text-is("Database") + input').fill(MYSQL.database);
    await form.locator('label:text-is("Username") + input').fill(MYSQL.username);
    await form.locator('label:has-text("Password") + input').fill(MYSQL.password);
    // Turn on safe mode (production DB) + tenant scope column.
    await form.locator('.field-check label:has-text("안전 모드") input[type="checkbox"]').check();
    await form.locator('label:has-text("tenant 스코프 컬럼") + input').fill('hospitalId,tenantId');
    await form.locator('button[type="submit"]').click();

    const row = win.locator('.conn-list .conn-row').filter({ hasText: 'Production MySQL' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    // --- Shot 1: hero — a SELECT with a populated result grid ---
    await typeQuery(win, `SELECT id, name, phone, hospitalId, status, visits\n  FROM ${TABLE}\n  ORDER BY visits DESC`);
    await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
    await expect(win.locator('.conn-panel .grid-head-cell').filter({ hasText: 'name' })).toBeVisible({ timeout: 15_000 });
    await win.waitForTimeout(600);
    await win.screenshot({ path: path.join(OUT, 'hero.png') });

    // --- Shot 2: safe execution mode — risky DELETE with no tenant scope ---
    // status filter, no hospitalId → tenant-missing → HIGH risk in safe mode,
    // showing affected rows + SELECT preview + generated Rollback SQL.
    await typeQuery(win, `DELETE FROM ${TABLE} WHERE status = 'inactive'`);
    await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
    const dialog = win.locator('.risk-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    // Let the affected-count / rollback fields settle.
    await expect(dialog.locator('.risk-sql').first()).toBeVisible({ timeout: 15_000 });
    await win.waitForTimeout(500);
    await win.screenshot({ path: path.join(OUT, 'safe-execution-mode.png') });

    // Cancel — never actually run the destructive statement.
    await dialog.locator('button', { hasText: '취소' }).click();

    // Report what we wrote.
    for (const f of ['hero.png', 'safe-execution-mode.png']) {
      const p = path.join(OUT, f);
      console.log('WROTE', p, fs.existsSync(p) ? `${(fs.statSync(p).size / 1024).toFixed(0)}KB` : 'MISSING');
    }
  });
});
