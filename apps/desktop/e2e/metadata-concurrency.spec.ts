import { test, expect } from './fixtures';
import { connectMySql, typeQuery } from './helpers';
import { MYSQL, isPortOpen } from './dbProbe';
import { withConn } from './db';
import { execFileSync } from 'node:child_process';

const tables = Array.from({ length: 6 }, (_, i) => `e2e_metadata_ddl_${process.pid}_${i}`);

test('creates multiple MySQL tables while metadata history writes and profile reads overlap', async ({ firstWindow: win, app }) => {
  test.setTimeout(90_000);
  test.skip(!await isPortOpen(MYSQL.host, MYSQL.port), 'local MySQL is unavailable');
  try {
    await connectMySql(win, 'E2E MySQL metadata contention');
    await win.getByTestId('query-mode-write').click();
    const profiles = await win.evaluate(() => window.electronAPI.listProfiles());
    expect(profiles.success).toBe(true);
    const profileId = profiles.data![0].id!;
    const marker = 'SELECT 1 /* e2e_metadata_parallel */';
    await typeQuery(win, tables.map(table => `CREATE TABLE ${table} (id INT PRIMARY KEY)`).join(';\n') + ';');
    const pending = win.evaluate(async ({ profileId, marker }) => {
      const writes = Array.from({ length: 64 }, () => window.electronAPI.addQueryHistory({
        workspaceId: 'default', profileId, name: 'Metadata contention', queryText: marker,
        durationMs: 0, success: true, rowCount: 1,
      }));
      const reads = Array.from({ length: 64 }, () => window.electronAPI.listProfiles());
      return Promise.all([...writes, ...reads]);
    }, { profileId, marker });
    await win.locator('.editor-toolbar .btn-primary').click();
    const responses = await pending;
    expect(responses.filter(response => !response.success)).toEqual([]);
    await expect(win.locator('.result-chip')).toHaveCount(tables.length);
    await expect(win.locator('.result-chip.err, .alert.error, .policy-banner')).toHaveCount(0);
    await withConn(async c => {
      const [rows] = await c.query(`SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=? AND table_name IN (${tables.map(() => '?').join(',')})`, [MYSQL.database, ...tables]);
      expect((rows as { count: number }[])[0].count).toBe(tables.length);
    });
    const metadata = await app.evaluate(() => process.env.ENGINE_DB_PATH!);
    const count = execFileSync('sqlite3', [metadata, "SELECT COUNT(*) FROM query_history WHERE query_text='SELECT 1 /* e2e_metadata_parallel */';"], { encoding: 'utf8' }).trim();
    expect(count).toBe('64');
    expect(execFileSync('sqlite3', [metadata, 'PRAGMA journal_mode;'], { encoding: 'utf8' }).trim()).toBe('wal');
  } finally {
    await withConn(async c => {
      for (const table of tables) await c.query(`DROP TABLE IF EXISTS ${table}`);
    });
  }
});
