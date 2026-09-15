import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('SQLite schema query context', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-query-context-'));
  const databaseFile = path.join(fixtureDir, 'query_context_e2e.db');
  const databaseName = path.basename(databaseFile);

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE query_context_e2e (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO query_context_e2e VALUES (1, \'one\'), (2, \'two\');']);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('opens the editor from the database menu and keeps its selected database', async ({ firstWindow: win }) => {
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E SQLite query context');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: 'E2E SQLite query context' });
    await expect(connection).toBeVisible();
    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    const dbRow = win.locator(`.tree-row:has(.tree-label:text-is("${databaseName}"))`).first();
    await expect(dbRow).toBeVisible({ timeout: 10_000 });
    await dbRow.click({ button: 'right' });

    const queryInput = win.locator('.ctx-menu .ctx-item').first();
    await expect(queryInput).toContainText('쿼리 입력');
    await queryInput.click();
    await expect(win.locator('.editor-conn-db')).toHaveText(databaseName);
    await expect(win.locator('.etab .etab-db')).toHaveText(databaseName);

    // A new tab inherits the current schema and keeps the schema visible on
    // each tab, so switching between tabs remains unambiguous.
    await win.locator('.etab-add').click();
    await expect(win.locator('.etab .etab-db')).toHaveCount(2);
    await expect(win.locator('.etab').nth(0)).toContainText(databaseName);
    await expect(win.locator('.etab').nth(1)).toContainText(databaseName);

    await dbRow.click();
    const tableRow = win.locator('.tree-row:has(.tree-label:text-is("query_context_e2e"))');
    await expect(tableRow).toBeVisible({ timeout: 10_000 });
    await tableRow.click({ button: 'right' });
    await win.locator('.ctx-menu .ctx-item').filter({ hasText: '최근 500개 조회' }).click();
    await expect(win.locator('.editor-conn-db')).toHaveText(databaseName);
    await expect(win.locator('.conn-panel:not([style*="none"]) .grid-body .grid-row')).toHaveCount(2, { timeout: 15_000 });

    await typeQuery(win, 'SELECT 1 AS first;\nSELECT 2 AS second;');
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.result-strip .result-chip')).toHaveCount(2, { timeout: 15_000 });
    await expect(win.locator('.query-statement-glyph-success')).toHaveCount(2);

    await typeQuery(win, 'SELECT 1 AS ok;\nSELECT * FROM missing_query_context_table;\nSELECT 3 AS not_run;');
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.result-strip .result-chip')).toHaveCount(2, { timeout: 15_000 });
    await expect(win.locator('.query-statement-glyph-success')).toHaveCount(1);
    await expect(win.locator('.query-statement-glyph-error')).toHaveCount(1);
    await expect(win.locator('.query-statement-glyph-skipped')).toHaveCount(1);

    // Cmd/Ctrl+Enter targets only the statement containing the caret. The
    // idle statement has a full-width rectangular outline before it runs.
    await typeQuery(win, 'SELECT 1 AS first;\nSELECT 2 AS second;\nSELECT 3 AS third;');
    const editor = win.locator('.conn-panel .monaco-editor').first();
    const editorLines = editor.locator('.view-lines .view-line');
    await expect(editorLines).toHaveCount(3);
    await editorLines.nth(1).click({ position: { x: 70, y: 8 } });
    const activeBlock = win.locator('.monaco-editor .query-statement-active-block');
    await expect(activeBlock).toBeVisible();
    await expect(activeBlock).toHaveCSS('border-style', 'solid');
    const editorBox = await editor.boundingBox();
    const activeBlockBox = await activeBlock.boundingBox();
    expect(editorBox).not.toBeNull();
    expect(activeBlockBox).not.toBeNull();
    expect(activeBlockBox?.width ?? 0).toBeGreaterThan((editorBox?.width ?? 0) * 0.75);
    await win.keyboard.press('ControlOrMeta+Enter');

    await expect(win.locator('.grid-cell[title="second"]')).toBeVisible({ timeout: 15_000 });
    await expect(win.locator('.grid-cell[title="2"]')).toBeVisible();
    await expect(win.locator('.exec-sql')).toHaveText('SELECT 2 AS second');
    await expect(win.locator('.query-statement-glyph-success')).toHaveCount(1);
    await expect(win.locator('.query-statement-glyph-error, .query-statement-glyph-skipped')).toHaveCount(0);
    const secondLineBox = await editorLines.nth(1).boundingBox();
    const successGlyphBox = await win.locator('.query-statement-glyph-success').boundingBox();
    expect(secondLineBox).not.toBeNull();
    expect(successGlyphBox).not.toBeNull();
    expect(Math.abs((successGlyphBox?.y ?? 0) - (secondLineBox?.y ?? 0))).toBeLessThan(3);
  });
});
