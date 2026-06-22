import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { withConn } from './db';
import { connectMySql } from './helpers';

const TABLE = 'e2e_agent_proposal_lock';
const OPS_TABLE = 'e2e_agent_ops';

async function installAgentRunCapture(app: Parameters<Parameters<typeof test>[1]>[0]['app']) {
  await app.evaluate(async ({ ipcMain }) => {
    ipcMain.removeHandler('agent-run');
    ipcMain.handle('agent-run', async (_event, runId: string) => {
      (globalThis as unknown as { __agentProposalRunId: string }).__agentProposalRunId = runId;
      return { success: true, data: { success: true } };
    });
  });
}

async function emitAgentProposal(app: Parameters<Parameters<typeof test>[1]>[0]['app'], sql: string, text = 'I recommend this change.') {
  await app.evaluate(async ({ BrowserWindow }, payload) => {
    const runId = (globalThis as unknown as { __agentProposalRunId: string }).__agentProposalRunId;
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.send('agent-stream-chunk', runId, {
      kind: 'text',
      text: payload.text,
    });
    win.webContents.send('agent-stream-chunk', runId, {
      kind: 'tool_call',
      toolCall: {
        id: `proposal-${Date.now()}`,
        name: 'mcp__rebase__propose_write',
        args: {
          sql: payload.sql,
        },
      },
    });
    win.webContents.send('agent-stream-chunk', runId, { kind: 'done' });
  }, { sql, text });
}

async function askAndRunProposal(
  app: Parameters<Parameters<typeof test>[1]>[0]['app'],
  win: Parameters<Parameters<typeof test>[1]>[0]['firstWindow'],
  prompt: string,
  sql: string,
  expectedStatus: RegExp | string
) {
  const composer = win.locator('.agent-composer textarea');
  await composer.fill(prompt);
  await win.locator('.agent-composer button[title="Send (Enter)"]').click();
  await emitAgentProposal(app, sql);

  const proposal = win.locator('.agent-proposal').last();
  await expect(proposal).toContainText(sql);
  await proposal.locator('button', { hasText: 'Run' }).click();
  await expect(proposal.locator('.agent-proposal-status.ok')).toContainText(expectedStatus, { timeout: 10_000 });
}

test.describe('Agent write proposals', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port}`);
  });

  test.beforeEach(async () => {
    await withConn(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await c.query(`DROP TABLE IF EXISTS ${OPS_TABLE}`);
    });
  });

  test.afterEach(async () => {
    await withConn(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await c.query(`DROP TABLE IF EXISTS ${OPS_TABLE}`);
    });
  });

  test('running a proposed CREATE TABLE keeps the app interactive', async ({ app, firstWindow: win }) => {
    await connectMySql(win, 'Agent Proposal MySQL');
    await installAgentRunCapture(app);

    await win.locator('.agent-toggle').click();

    const sql = `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL)`;
    await askAndRunProposal(app, win, 'Create a table for testing', sql, '0 row(s) affected');

    await win.locator('.icon-btn[title="설정"]').click();
    await expect(win.locator('.settings-page')).toBeVisible();
  });

  test('runs production-like table, index, data, and cleanup operations from agent proposals', async ({ app, firstWindow: win }) => {
    await connectMySql(win, 'Agent Operations MySQL');
    await installAgentRunCapture(app);
    await win.locator('.agent-toggle').click();

    await askAndRunProposal(
      app,
      win,
      'Create a customer-like table',
      `CREATE TABLE ${OPS_TABLE} (id INT PRIMARY KEY, email VARCHAR(100) NOT NULL, active TINYINT NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
      '0 row(s) affected'
    );
    await withConn(async (c) => {
      const [rows] = await c.query(`SHOW TABLES LIKE '${OPS_TABLE}'`);
      expect(Array.isArray(rows) ? rows.length : 0).toBe(1);
    });

    await askAndRunProposal(
      app,
      win,
      'Insert a couple of safe test rows',
      `INSERT INTO ${OPS_TABLE} (id, email, active) VALUES (1, 'alpha@example.test', 1), (2, 'beta@example.test', 1)`,
      '2 row(s) affected'
    );
    await withConn(async (c) => {
      const [rows] = await c.query(`SELECT COUNT(*) AS count FROM ${OPS_TABLE}`);
      expect((rows as Array<{ count: number }>)[0].count).toBe(2);
    });

    await askAndRunProposal(
      app,
      win,
      'Add an index for email lookup',
      `CREATE INDEX idx_${OPS_TABLE}_email ON ${OPS_TABLE} (email)`,
      '0 row(s) affected'
    );
    await withConn(async (c) => {
      const [rows] = await c.query(`SHOW INDEX FROM ${OPS_TABLE} WHERE Key_name = 'idx_${OPS_TABLE}_email'`);
      expect(Array.isArray(rows) ? rows.length : 0).toBeGreaterThan(0);
    });

    await askAndRunProposal(
      app,
      win,
      'Delete the second test row',
      `DELETE FROM ${OPS_TABLE} WHERE id = 2`,
      '1 row(s) affected'
    );
    await withConn(async (c) => {
      const [rows] = await c.query(`SELECT COUNT(*) AS count FROM ${OPS_TABLE}`);
      expect((rows as Array<{ count: number }>)[0].count).toBe(1);
    });

    await askAndRunProposal(
      app,
      win,
      'Remove the email index',
      `DROP INDEX idx_${OPS_TABLE}_email ON ${OPS_TABLE}`,
      '0 row(s) affected'
    );
    await withConn(async (c) => {
      const [rows] = await c.query(`SHOW INDEX FROM ${OPS_TABLE} WHERE Key_name = 'idx_${OPS_TABLE}_email'`);
      expect(Array.isArray(rows) ? rows.length : 0).toBe(0);
    });

    await askAndRunProposal(
      app,
      win,
      'Clean up the test table',
      `DROP TABLE ${OPS_TABLE}`,
      '0 row(s) affected'
    );
    await withConn(async (c) => {
      const [rows] = await c.query(`SHOW TABLES LIKE '${OPS_TABLE}'`);
      expect(Array.isArray(rows) ? rows.length : 0).toBe(0);
    });

    await expect(win.locator('.agent-composer textarea')).toBeEnabled();
    await win.locator('.icon-btn[title="설정"]').click();
    await expect(win.locator('.settings-page')).toBeVisible();
  });
});
