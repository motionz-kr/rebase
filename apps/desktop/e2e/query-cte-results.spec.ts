import { test, expect } from './fixtures';
import { connectMySql, typeQuery } from './helpers';
import { MYSQL, isPortOpen } from './dbProbe';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';

const queries = [
  {
    sql: 'WITH t AS (SELECT 7 AS updated_at, 8 AS created_at, 9 AS deleted_at) SELECT updated_at, created_at, deleted_at FROM t',
    values: ['7', '8', '9'],
  },
  {
    sql: "WITH t AS (SELECT 'UPDATE; -- /* DROP */' AS value) SELECT value FROM t",
    values: ['UPDATE; -- /* DROP */'],
  },
  {
    sql: 'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<2), updated_items AS (SELECT n FROM t) SELECT n FROM updated_items ORDER BY n',
    values: ['1', '2'],
  },
  { sql: "SELECT 'a;b' AS value", values: ['a;b'] },
];

async function checkResults(win: Page) {
  for (const query of queries) {
    await typeQuery(win, query.sql);
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.grid-body .grid-cell')).toHaveText(query.values);
    await expect(win.locator('.policy-banner')).toHaveCount(0);
    await expect(win.locator('.risk-dialog')).toHaveCount(0);
  }
}

test('SQLite displays CTE and quoted SQL results in Read-only, Write Auto and Manual', async ({ firstWindow: win }, testInfo) => {
  test.setTimeout(120_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-cte-'));
  try {
    const database = path.join(dir, 'cte.db');
    execFileSync('sqlite3', [database, 'VACUUM;']);
    await win.getByRole('button', { name: '새 연결', exact: true }).click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('E2E CTE results');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(database);
    await form.locator('button[type="submit"]').click();
    await win.locator('.conn-list .conn-row').filter({ hasText: 'E2E CTE results' }).click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible();
    await checkResults(win);
    await win.getByTestId('query-mode-write').click();
    await checkResults(win);
    await win.getByTestId('tx-mode-manual').click();
    await checkResults(win);
    await typeQuery(win, queries[0].sql);
    await win.locator('.editor-toolbar .btn-primary').click();
    await expect(win.locator('.grid-body .grid-cell')).toHaveText(queries[0].values);
    await win.screenshot({ path: testInfo.outputPath('cte-results.png') });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MySQL displays CTE results through the real query session', async ({ firstWindow: win }) => {
  test.setTimeout(120_000);
  test.skip(!await isPortOpen(MYSQL.host, MYSQL.port), 'local MySQL is unavailable');
  // These queries use constants only: no devdb schema or user tables needed.
  await connectMySql(win, 'E2E MySQL CTE results', 'information_schema');
  await checkResults(win);
  await win.getByTestId('query-mode-write').click();
  await checkResults(win);
  await win.getByTestId('tx-mode-manual').click();
  await checkResults(win);
});
