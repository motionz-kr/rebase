import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

// Multi-statement runs: comment-only tails are not sent, a summary line explains
// the totals, chips name each statement, and the view lands on the answer.
test.describe('multi-statement result summary', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-multi-summary-'));
  const databaseFile = path.join(fixtureDir, 'multi_summary_e2e.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE seed_e2e (id INTEGER PRIMARY KEY);']);
  });
  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('shows totals, labelled chips, and selects the answer / the failure', async ({ firstWindow: win }) => {
    test.setTimeout(90_000);
    await win.getByRole('button', { name: '새 연결', exact: true }).click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E multi summary');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();
    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E multi summary' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });
    await win.getByTestId('query-mode-write').click();

    const run = async () => {
      await win.locator('.editor-toolbar .btn-primary').click();
      const riskDialog = win.locator('.risk-dialog');
      if (await riskDialog.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true).catch(() => false)) {
        const ack = riskDialog.locator('.risk-ack input');
        if (await ack.count()) await ack.check();
        await riskDialog.getByRole('button', { name: '실행' }).click();
      }
    };

    await typeQuery(win, [
      '-- setup',
      'CREATE TABLE e2e_summary (id INTEGER PRIMARY KEY, v INTEGER);',
      'INSERT INTO e2e_summary VALUES (1, 0), (2, 0), (3, 0);',
      'UPDATE e2e_summary SET v = 1 WHERE id <= 2;',
      'SELECT COUNT(*) AS n FROM e2e_summary;',
      '-- the answer is 3',
      '-- COMMIT;',
    ].join('\n'));
    await run();

    // Four statements; the comment-only tail is not a fifth result.
    const chips = win.locator('.result-strip .result-chip');
    await expect(chips).toHaveCount(4, { timeout: 20_000 });
    await expect(win.getByTestId('run-summary')).toHaveText('4개 문장 · 변경 5행 · 조회 1행');
    await expect(chips.nth(0)).toHaveText('1 CREATE · 완료');
    await expect(chips.nth(1)).toHaveText('2 INSERT · 3행 변경');
    await expect(chips.nth(2)).toHaveText('3 UPDATE · 2행 변경');
    await expect(chips.nth(3)).toHaveText('4 SELECT · 1행');
    // Lands on the SELECT, not on statement 1.
    await expect(chips.nth(3)).toHaveClass(/active/);
    await expect(win.locator('.results .grid-body .grid-row').first()).toContainText('3');
    await expect(win.locator('.exec-meta')).toContainText('1 rows · 변경 5행');
    // The UPDATE result is one click away and shows its count.
    await chips.nth(2).click();
    await expect(win.locator('.results .alert')).toContainText('Rows affected: 2');

    // A failing statement stops the run and becomes the selected result.
    await typeQuery(win, ['SELECT 1;', 'UPDATE e2e_missing_table SET v = 1 WHERE id = 1;', 'SELECT 2;'].join('\n'));
    await run();
    await expect(chips).toHaveCount(2, { timeout: 20_000 });
    await expect(chips.nth(1)).toHaveClass(/active/);
    await expect(chips.nth(1)).toHaveClass(/err/);
    await expect(chips.nth(1)).toHaveText('2 UPDATE · 실패');
    await expect(win.locator('.results .alert.error')).toContainText('Execution failed');
    await expect(win.getByTestId('run-summary')).toHaveText('2개 문장 · 조회 1행 · 실패 1건');

    // Cleanup of the throwaway table happens with the temp database file (afterAll).
  });
});
