import { test, expect } from './fixtures';
import { connectMySql, typeQuery } from './helpers';
import { MYSQL, isPortOpen } from './dbProbe';
import { withConn } from './db';
import type { Page } from '@playwright/test';
import type { QueryStreamChunk } from '../../renderer/src/global';
import fs from 'node:fs';
import path from 'node:path';

const suffix = `${process.pid}_${Date.now()}`;
const policy = `e2e_tx_policy_${suffix}`;
const method = `e2e_tx_method_${suffix}`;
const phone = `e2e_tx_phone_${suffix}`;
const verifiedAt = '2026-10-20 08:58:55.844000';
const dml = [
  `DELETE m FROM ${method} m JOIN ${policy} p ON p.accountId=m.accountId WHERE m.accountId=261 AND m.type='SMS' AND m.slot=1 AND m.verifiedAt='${verifiedAt}' AND p.revision=1`,
  'SELECT ROW_COUNT() AS changed_rows',
  `UPDATE ${policy} p SET p.enabled=0, p.revision=p.revision+1 WHERE p.accountId=261 AND p.revision=1 AND NOT EXISTS (SELECT 1 FROM (SELECT accountId FROM ${method} WHERE accountId=261 AND type='SMS') x)`,
  'SELECT ROW_COUNT() AS changed_rows',
];
const initial = { enabled: 1, revision: 1, methods: 1 };
const changed = { enabled: 0, revision: 2, methods: 0 };

async function seed() {
  await withConn(async c => {
    await c.query(`DELETE FROM ${method}`);
    await c.query(`DELETE FROM ${policy}`);
    await c.query(`DELETE FROM ${phone}`);
    await c.query(`INSERT INTO ${policy} VALUES (261, 1, 1)`);
    await c.query(`INSERT INTO ${phone} VALUES (261, 1)`);
    await c.query(`INSERT INTO ${method} VALUES (261, 'SMS', 1, '${verifiedAt}')`);
  });
}

async function snapshot() {
  return withConn(async c => {
    const [p] = await c.query(`SELECT enabled, revision FROM ${policy} WHERE accountId=261`);
    const [m] = await c.query(`SELECT COUNT(*) AS methods FROM ${method} WHERE accountId=261`);
    return { ...(p as object[])[0], ...(m as object[])[0] };
  });
}

async function observe(win: Page) {
  await win.evaluate(() => {
    const w = window as Window & { txChunks?: QueryStreamChunk[] };
    w.txChunks = [];
    window.electronAPI.onQueryStreamChunk((_qid, chunk) => w.txChunks!.push(chunk));
  });
}

async function run(win: Page, statements: string[], allowError = false) {
  await win.evaluate(() => { (window as Window & { txChunks?: QueryStreamChunk[] }).txChunks = []; });
  await typeQuery(win, statements.join(';\n') + ';');
  await win.locator('.editor-toolbar .btn-primary').click();
  await expect.poll(() => win.evaluate(({ allowError, expected }) => (window as Window & { txChunks?: QueryStreamChunk[] }).txChunks!
    .filter(c => ['done', 'error', 'policy'].includes(c.type))
    .some((c, _i, all) => (allowError && (c.type === 'error' || c.type === 'policy')) || all.length === expected),
    { allowError, expected: statements.length })).toBe(true);
  const chunks = await win.evaluate(() => (window as Window & { txChunks?: QueryStreamChunk[] }).txChunks!);
  if (!allowError) expect(chunks.filter(c => c.type === 'error' || c.type === 'policy')).toEqual([]);
  return chunks;
}

const rows = (chunks: QueryStreamChunk[]) => chunks.filter(c => c.type === 'row').map(c => c.data);

test.describe('MySQL query-console transaction sessions', () => {
  let available = false;
  test.beforeAll(async () => {
    available = await isPortOpen(MYSQL.host, MYSQL.port);
    if (!available) return;
    await withConn(async c => {
      await c.query(`CREATE TABLE ${policy} (accountId INT PRIMARY KEY, enabled INT, revision INT) ENGINE=InnoDB`);
      await c.query(`CREATE TABLE ${phone} (accountId INT PRIMARY KEY, revision INT) ENGINE=InnoDB`);
      await c.query(`CREATE TABLE ${method} (accountId INT, type VARCHAR(20), slot INT, verifiedAt DATETIME(6)) ENGINE=InnoDB`);
    });
  });
  test.afterAll(async () => {
    if (!available) return;
    await withConn(async c => {
      for (const table of [method, phone, policy]) await c.query(`DROP TABLE IF EXISTS ${table}`);
    });
  });
  test.beforeEach(async () => {
    test.skip(!available, 'local MySQL is unavailable');
    await seed();
  });

  test('Auto honors separately executed SQL transactions, locks, session settings and affected counts', async ({ firstWindow: win }) => {
    test.setTimeout(120_000);
    await connectMySql(win, 'E2E MySQL explicit transactions');
    await win.getByTestId('query-mode-write').click();
    await observe(win);
    const opened = await run(win, [
      "SET SESSION time_zone = '+09:00'", 'START TRANSACTION',
      `SELECT accountId, enabled, revision FROM ${policy} WHERE accountId=261 FOR UPDATE`,
      `SELECT accountId, revision FROM ${phone} WHERE accountId=261 FOR UPDATE`,
      'SELECT CONNECTION_ID() AS cid, @@session.time_zone AS timezone',
    ]);
    const cid = rows(opened).at(-1)![0];
    expect(rows(opened).at(-1)![1]).toBe('+09:00');
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션');
    await expect(win.getByTestId('tx-rollback')).toBeEnabled();
    // This runs before any DML: the SELECT FOR UPDATE itself must hold its lock.
    await withConn(async c => {
      await c.beginTransaction();
      try {
        await expect(c.query(`SELECT accountId FROM ${policy} WHERE accountId=261 FOR UPDATE NOWAIT`)).rejects.toMatchObject({ errno: 3572 });
      } finally { await c.rollback(); }
    });
    const applied = await run(win, dml);
    expect(rows(applied)).toEqual([[1], [1]]);
    expect(applied.filter(c => c.type === 'done').map(c => c.rowsAffected)).toEqual([1, 1, 1, 1]);
    expect(await snapshot()).toEqual(initial);
    const ownRows = rows(await run(win, [`SELECT * FROM ${policy} WHERE accountId=261`]));
    expect(ownRows).toEqual([[261, 0, 2]]);
    const same = rows(await run(win, ['SELECT CONNECTION_ID(), @@session.time_zone']));
    expect(same).toEqual([[cid, '+09:00']]);
    // A second console must not share either the transaction or session settings.
    await win.locator('.etab-add').click();
    const other = rows(await run(win, ['SELECT CONNECTION_ID()']));
    expect(other[0]![0]).not.toBe(cid);
    await win.locator('.etab').nth(1).getByRole('button').click();
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션');
    await run(win, ['ROLLBACK']);
    await expect(win.getByTestId('transaction-status')).toHaveText('Auto-commit');
    expect(await snapshot()).toEqual(initial);
    // The same full script can be run in one action and committed explicitly.
    await run(win, ['START TRANSACTION', ...dml]);
    expect(await snapshot()).toEqual(initial);
    await win.getByTestId('tx-commit').click();
    await expect(win.locator('.transaction-notice')).toHaveText('Committed');
    expect(await snapshot()).toEqual(changed);
    await run(win, [`UPDATE ${policy} SET enabled=1 WHERE accountId=261`, 'SELECT ROW_COUNT()']);
    expect(await snapshot()).toEqual({ ...changed, enabled: 1 });
    await expect(win.getByTestId('transaction-status')).toHaveText('Auto-commit');
    const running = run(win, ['SELECT SLEEP(2)']);
    await expect(win.getByTestId('tx-mode-manual')).toBeDisabled();
    await expect(win.getByTestId('query-mode-readonly')).toBeDisabled();
    await running;
    const screenshotDir = path.resolve(__dirname, '../test-results');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await win.screenshot({ path: path.join(screenshotDir, 'mysql-auto-sql-rollback-fixed.png') });
  });

  test('Manual accepts SQL boundaries and preserves the connection across mode changes', async ({ firstWindow: win }) => {
    await connectMySql(win, 'E2E MySQL Manual SQL');
    await win.getByTestId('query-mode-write').click();
    await win.getByTestId('tx-mode-manual').click();
    await observe(win);
    const opened = rows(await run(win, ["SET SESSION time_zone='+09:00'", 'START TRANSACTION', 'SELECT CONNECTION_ID()']));
    const cid = opened[0]![0];
    expect(rows(await run(win, dml))).toEqual([[1], [1]]);
    await run(win, ['ROLLBACK']);
    expect(await snapshot()).toEqual(initial);
    await run(win, [dml[0], 'SELECT ROW_COUNT()']);
    expect(await snapshot()).toEqual(initial);
    await win.getByTestId('tx-rollback').click();
    await expect(win.locator('.transaction-notice')).toHaveText('Rolled back');
    await win.getByTestId('tx-mode-auto').click();
    await expect(win.getByTestId('tx-mode-auto')).toHaveAttribute('aria-pressed', 'true');
    expect(rows(await run(win, ['SELECT CONNECTION_ID(), @@session.time_zone']))).toEqual([[cid, '+09:00']]);
    await run(win, ['START TRANSACTION', ...dml, 'COMMIT']);
    expect(await snapshot()).toEqual(changed);
  });

  test('Auto keeps a transaction after an error and rolls it back when its tab closes', async ({ firstWindow: win }) => {
    await connectMySql(win, 'E2E MySQL close rollback');
    await win.getByTestId('query-mode-write').click();
    await observe(win);
    await run(win, ['START TRANSACTION', ...dml]);
    await run(win, [`SELECT * FROM e2e_nonexistent_${suffix}`], true);
    await expect(win.getByTestId('transaction-status')).toHaveText('오류 · 롤백 필요');
    expect(await snapshot()).toEqual(initial);
    await win.locator('.etab-add').click();
    await win.locator('.etab').first().click();
    let confirmed = false;
    win.once('dialog', async dialog => { confirmed = true; await dialog.accept(); });
    await win.locator('.etab').first().getByRole('button').click();
    expect(confirmed).toBe(true);
    await expect(win.locator('.etab')).toHaveCount(1);
    expect(await snapshot()).toEqual(initial);
    // A concurrent write must succeed after close, proving the locks were released.
    await withConn(c => c.query(`UPDATE ${policy} SET revision=3 WHERE accountId=261`));
    expect(await snapshot()).toEqual({ ...initial, revision: 3 });
  });

  test('a lost session fails without reconnecting or replaying writes', async ({ firstWindow: win }) => {
    await connectMySql(win, 'E2E MySQL lost session');
    await win.getByTestId('query-mode-write').click();
    await observe(win);
    const opened = rows(await run(win, ['START TRANSACTION', ...dml, 'SELECT CONNECTION_ID()']));
    const cid = opened.at(-1)![0];
    expect(typeof cid).toBe('number');
    await withConn(c => c.query(`KILL CONNECTION ${cid}`));
    const first = await run(win, ['SELECT 1'], true);
    expect(first.some(c => c.type === 'error')).toBe(true);
    const second = await run(win, [dml[0], 'SELECT 1'], true);
    expect(second.some(c => c.type === 'error')).toBe(true);
    expect(await snapshot()).toEqual(initial);
  });

  test('savepoints, chain and SQL autocommit settings retain native MySQL semantics', async ({ firstWindow: win }) => {
    await connectMySql(win, 'E2E MySQL SQL boundaries');
    await win.getByTestId('query-mode-write').click();
    await observe(win);
    await run(win, ['START TRANSACTION', dml[0], 'SAVEPOINT before_policy', dml[2], 'ROLLBACK TO SAVEPOINT before_policy']);
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션');
    expect(rows(await run(win, [`SELECT enabled, revision FROM ${policy} WHERE accountId=261`]))).toEqual([[1, 1]]);
    await run(win, ['ROLLBACK AND CHAIN']);
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션');
    expect(await snapshot()).toEqual(initial);
    await run(win, ['ROLLBACK']);
    await run(win, ['SET autocommit=0', ...dml]);
    expect(await snapshot()).toEqual(initial);
    await expect(win.getByTestId('transaction-status')).toHaveText('미커밋 트랜잭션');
    await run(win, ['ROLLBACK', 'SET autocommit=1']);
    await expect(win.getByTestId('transaction-status')).toHaveText('Auto-commit');
    expect(await snapshot()).toEqual(initial);
  });

  test('resolving a transaction discards a paused script instead of continuing its writes', async ({ firstWindow: win }) => {
    await connectMySql(win, 'E2E MySQL paused transaction');
    await win.getByTestId('query-mode-write').click();
    await observe(win);
    // The unqualified DELETE pauses on the destructive confirmation gate.
    await run(win, ['START TRANSACTION', `DELETE FROM ${method}`], true);
    await expect(win.locator('.policy-banner')).toBeVisible();
    await win.getByTestId('tx-rollback').click();
    await expect(win.locator('.transaction-notice')).toHaveText('Rolled back');
    await expect(win.locator('.policy-banner')).toHaveCount(0);
    expect(await snapshot()).toEqual(initial);
  });
});
