import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeQuery } from './helpers';

test.describe('SQLite schema query context', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-query-context-'));
  const databaseFile = path.join(fixtureDir, 'query_context_e2e.db');
  const databaseFileB = path.join(fixtureDir, 'query_context_e2e_b.db');
  const databaseName = path.basename(databaseFile);
  const databaseNameB = path.basename(databaseFileB);

  test.beforeAll(() => {
    execFileSync('sqlite3', [databaseFile, 'CREATE TABLE query_context_e2e (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO query_context_e2e VALUES (1, \'one\'), (2, \'two\');']);
    execFileSync('sqlite3', [databaseFileB, 'CREATE TABLE query_context_e2e_b (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO query_context_e2e_b VALUES (1, \'from-b\');']);
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

    // New connections hide all databases by default. SQLite exposes the same
    // schema preference UI as server-backed connections so the user can opt in.
    await win.locator('.conn-row .icon-btn[title="Edit profile"]').click();
    await win.locator('.conn-modal-tabs .seg-tab').filter({ hasText: '스키마' }).click();
    const allSchemasCheckbox = win.getByTestId('schema-visibility-toggle-all');
    await expect(allSchemasCheckbox).not.toBeChecked();
    await allSchemasCheckbox.check();
    await expect(allSchemasCheckbox).toBeChecked();
    await win.locator('.conn-modal .modal-head .icon-btn').click();

    const dbRow = win.locator(`.tree-row:has(.tree-label:text-is("${databaseName}"))`).first();
    await expect(dbRow).toBeVisible({ timeout: 10_000 });
    await dbRow.click({ button: 'right' });

    const queryInput = win.locator('.ctx-menu .ctx-item').first();
    await expect(queryInput).toContainText('쿼리 입력');
    await queryInput.click();
    await expect(win.locator('.editor-conn-db')).toHaveText(databaseName);
    // Schema explorer actions open a dedicated tab instead of changing the
    // database/session of the tab that was already open.
    await expect(win.locator('.etab')).toHaveCount(2);
    await expect(win.locator('.etab.active .etab-db')).toHaveText(databaseName);

    // A new tab inherits the current schema and keeps the schema visible on
    // each tab, so switching between tabs remains unambiguous.
    await win.locator('.etab-add').click();
    await expect(win.locator('.etab')).toHaveCount(3);
    await expect(win.locator('.etab').nth(0)).toContainText(databaseName);
    await expect(win.locator('.etab').nth(1)).toContainText(databaseName);
    await expect(win.locator('.etab').nth(2)).toContainText(databaseName);

    await dbRow.click();
    const tableRow = win.locator('.tree-row:has(.tree-label:text-is("query_context_e2e"))');
    await expect(tableRow).toBeVisible({ timeout: 10_000 });

    // Completion in a later statement must use only that statement's context,
    // not the table referenced before the semicolon.
    await typeQuery(win, 'SELECT * FROM query_context_e2e; SELECT ');
    await win.keyboard.type('qu');
    const completion = win.locator('.sql-ac');
    await expect(completion).toBeVisible({ timeout: 10_000 });
    await expect(completion.locator('.sql-ac-label').filter({ hasText: /^query_context_e2e$/ })).toBeVisible();

    await tableRow.click({ button: 'right' });
    await win.locator('.ctx-menu .ctx-item').filter({ hasText: '최근 500개 조회' }).click();
    await expect(win.locator('.editor-conn-db')).toHaveText(databaseName);
    await expect(win.locator('.etab')).toHaveCount(4);
    await expect(win.locator('.conn-panel:not([style*="none"]) .grid-body .grid-row')).toHaveCount(2, { timeout: 15_000 });

    // Table-view filters run in the database: exercise text matching and a
    // numeric range rather than filtering only the currently loaded rows.
    const filterBar = win.locator('.conn-panel:not([style*="none"]) .tdv-filterbar');
    await expect(filterBar).toBeVisible();
    await filterBar.getByRole('combobox', { name: 'Filter column' }).selectOption('label');
    await filterBar.getByRole('combobox', { name: 'Filter operator' }).selectOption('contains');
    await filterBar.getByRole('textbox', { name: 'Filter value' }).fill('one');
    await filterBar.getByRole('button', { name: '필터 추가' }).click();
    await expect(win.locator('.tdv .grid-body .grid-row')).toHaveCount(1);
    await expect(win.locator('.tdv .grid-cell[title="one"]')).toBeVisible();

    await filterBar.locator('.filter-chip .fc-x').click();
    await expect(win.locator('.tdv .grid-body .grid-row')).toHaveCount(2);
    await filterBar.getByRole('combobox', { name: 'Filter column' }).selectOption('id');
    await expect(filterBar.getByRole('combobox', { name: 'Filter operator' })).toHaveValue('equals');
    await filterBar.getByRole('combobox', { name: 'Filter operator' }).selectOption('greater-than');
    await filterBar.getByRole('textbox', { name: 'Filter value' }).fill('1');
    await filterBar.getByRole('button', { name: '필터 추가' }).click();
    await expect(win.locator('.tdv .grid-body .grid-row')).toHaveCount(1);
    await expect(win.locator('.tdv .grid-cell[title="2"]')).toBeVisible();

    await filterBar.getByRole('button', { name: '모두 지우기' }).click();
    await expect(win.locator('.tdv .grid-body .grid-row')).toHaveCount(2);

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

    // After a failed statement in a script, Cmd/Ctrl+Enter on that statement
    // must retry only that block. It must not replay the earlier successful
    // statement or the later skipped statement.
    await typeQuery(win, 'SELECT 1 AS first;\nSELECT COUNT(*) AS missing_count FROM missing_retry_table;\nSELECT 3 AS third;');
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.result-strip .result-chip')).toHaveCount(2, { timeout: 15_000 });
    const retryLines = editor.locator('.view-lines .view-line');
    await retryLines.nth(1).click({ position: { x: 70, y: 8 } });
    await expect(win.locator('.monaco-editor .query-statement-active-block')).toHaveCount(1);
    await win.keyboard.press('ControlOrMeta+Enter');
    await expect(win.locator('.result-strip')).toHaveCount(0, { timeout: 15_000 });
    await expect(win.locator('.exec-sql')).toHaveText('SELECT COUNT(*) AS missing_count FROM missing_retry_table');

    // Query history can be searched by SQL text and narrowed by execution
    // outcome; filtering never executes or edits a history entry.
    await win.locator('.conn-panel:not([style*="none"]) .query-library-action').click();
    await win.locator('.library-tab', { hasText: 'History' }).click();
    const historySearch = win.getByRole('searchbox', { name: 'Search query history' });
    const historyStatus = win.getByRole('combobox', { name: 'Filter query history by status' });
    await historySearch.fill('SELECT 2 AS second');
    await expect(win.locator('.library-modal .hist-card').first()).toContainText('SELECT 2 AS second');
    await historyStatus.selectOption('failed');
    await expect(win.locator('.library-modal .history-empty')).toHaveText('No executions match these filters.');

    await historySearch.fill('missing_query_context_table');
    await expect(win.locator('.library-modal .hist-card.fail').first()).toContainText('missing_query_context_table');
    await historyStatus.selectOption('success');
    await expect(win.locator('.library-modal .history-empty')).toHaveText('No executions match these filters.');
  });

  test('routes a schema action to the selected connection tab', async ({ firstWindow: win }) => {
    const addSqliteConnection = async (name: string, file: string) => {
      await win.locator('.sidebar-head button').click();
      const form = win.locator('.conn-form');
      await form.locator('select').first().selectOption('sqlite');
      await form.locator('label:text-is("Profile name") + input').fill(name);
      await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(file);
      await form.locator('button[type="submit"]').click();

      const row = win.locator('.conn-list .conn-row').filter({ hasText: name });
      await expect(row).toBeVisible();
      await row.click();
      await expect(win.locator('.conn-panel:not([style*="none"]) .editor-toolbar')).toBeVisible({ timeout: 20_000 });
      return row;
    };

    const enableAllSchemas = async (row: ReturnType<typeof win.locator>) => {
      await row.locator('button[title="Edit profile"]').click();
      await win.locator('.conn-modal-tabs .seg-tab').filter({ hasText: '스키마' }).click();
      const allSchemasCheckbox = win.getByTestId('schema-visibility-toggle-all');
      await expect(allSchemasCheckbox).not.toBeChecked();
      await allSchemasCheckbox.check();
      await expect(allSchemasCheckbox).toBeChecked();
      await win.locator('.conn-modal .modal-head .icon-btn').click();
    };

    const rowA = await addSqliteConnection('E2E SQLite connection A', databaseFile);
    const rowB = await addSqliteConnection('E2E SQLite connection B', databaseFileB);
    await enableAllSchemas(rowA);
    await enableAllSchemas(rowB);

    const dbRowA = win.locator(`.tree-row:has(.tree-label:text-is("${databaseName}"))`).first();
    const dbRowB = win.locator(`.tree-row:has(.tree-label:text-is("${databaseNameB}"))`).first();
    await expect(dbRowA).toBeVisible({ timeout: 10_000 });
    await expect(dbRowB).toBeVisible({ timeout: 10_000 });
    await dbRowB.click();
    await expect(win.locator('.tree-row:has(.tree-label:text-is("query_context_e2e_b"))').first()).toBeVisible({ timeout: 10_000 });
    await dbRowA.click({ button: 'right' });
    await win.locator('.ctx-menu .ctx-item').filter({ hasText: '쿼리 입력' }).click();
    const aPanel = win.locator('.conn-panel:not([style*="none"])');
    await expect(aPanel.locator('.etab')).toHaveCount(2);
    await aPanel.getByTestId('tx-mode-manual').click();
    await aPanel.locator('.editor-toolbar .btn-primary').click();
    await expect(aPanel.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션', { timeout: 15_000 });

    // Move focus away from A. The B action must activate B and create the B
    // database-bound tab instead of being swallowed by the hidden A editor.
    await rowA.click();
    const tableRowB = win.locator('.tree-row:has(.tree-label:text-is("query_context_e2e_b"))').first();
    await expect(tableRowB).toBeVisible({ timeout: 10_000 });
    await tableRowB.click({ button: 'right' });
    await win.locator('.ctx-menu .ctx-item').filter({ hasText: '최근 500개 조회' }).click();

    const visiblePanel = win.locator('.conn-panel:not([style*="none"])');
    await expect(visiblePanel.locator('.editor-conn-db')).toHaveText(databaseNameB);
    await expect(visiblePanel.locator('.etab')).toHaveCount(2);
    await expect(visiblePanel.locator('.grid-body .grid-row')).toHaveCount(1, { timeout: 15_000 });

    // Switching back must reveal A's original pair of tabs, proving that the
    // two connections do not share one focused editor/session state.
    await rowA.click();
    const visibleA = win.locator('.conn-panel:not([style*="none"])');
    await expect(visibleA.locator('.editor-conn-db')).toHaveText(databaseName);
    await expect(visibleA.locator('.etab')).toHaveCount(2);
    await expect(visibleA.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션');
    await rowB.click();
    const visibleB = win.locator('.conn-panel:not([style*="none"])');
    await expect(visibleB.locator('.editor-conn-db')).toHaveText(databaseNameB);
    await expect(visibleB.locator('.etab')).toHaveCount(2);
  });
});
