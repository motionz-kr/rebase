import { test, expect } from './fixtures';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { execFileSync } from 'child_process';
import { createInterface, type Interface } from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type RpcResponse = {
  id?: number;
  result?: { tools?: Array<{ name: string }>; content?: Array<{ text?: string }>; isError?: boolean };
  error?: { message: string };
};

function nextRpcLine(readline: Interface, timeoutMs = 10_000): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for MCP response'));
    }, timeoutMs);
    const onLine = (line: string) => {
      cleanup();
      try {
        resolve(JSON.parse(line) as RpcResponse);
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('MCP server closed before replying'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      readline.removeListener('line', onLine);
      readline.removeListener('close', onClose);
    };
    readline.once('line', onLine);
    readline.once('close', onClose);
  });
}

function sendRpc(process: ChildProcessWithoutNullStreams, message: Record<string, unknown>) {
  process.stdin.write(`${JSON.stringify(message)}\n`);
}

async function stopProcess(process: ChildProcessWithoutNullStreams) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.stdin.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      process.kill('SIGTERM');
      resolve();
    }, 5_000);
    process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('MCP scope is visible in UI and enforced by a real stdio server process', async ({ app, firstWindow: win }) => {
  let profileId = '';
  let mcpProcess: ChildProcessWithoutNullStreams | undefined;

  try {
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('label:text-is("Profile name") + input').fill('MCP Governance E2E');
    await form.locator('label:text-is("Host") + input').fill('127.0.0.1');
    await form.locator('label:text-is("Port") + input').fill('3306');
    await form.locator('label:text-is("Database") + input').fill('e2e_mcp');
    await form.locator('label:text-is("Username") + input').fill('root');
    await form.locator('label:text-is("Password (OS keychain)") + input').fill('');
    await form.locator('button[type="submit"]').click();

    const row = win.locator('.conn-list .conn-row').filter({ hasText: 'MCP Governance E2E' });
    await expect(row).toBeVisible();
    const profiles = await win.evaluate(() => window.electronAPI.listProfiles());
    profileId = profiles.data?.find((profile) => profile.name === 'MCP Governance E2E')?.id ?? '';
    expect(profileId).not.toBe('');

    await row.locator('button[title="Edit profile"]').click();
    await win.getByRole('button', { name: 'MCP', exact: true }).click();
    await expect(win.locator('.mcp-panel')).toBeVisible();

    await win.locator('.mcp-toggle input').check();
    await expect(win.locator('.mcp-toggle input')).toBeChecked();
    await expect(win.locator('.mcp-snippet')).toContainText('mcpServers');
    await expect(win.locator('.mcp-snippet')).not.toContainText('/dev/null');
    await win.getByRole('button', { name: '복사', exact: true }).click();
    await expect(win.getByRole('button', { name: '복사됨', exact: true })).toBeVisible();
    const allowedTables = win.locator('label.mcp-field').filter({ hasText: '허용 테이블' }).locator('textarea');
    await allowedTables.fill('allowed_table');
    await win.getByRole('button', { name: '범위 저장', exact: true }).click();
    await expect(win.locator('.mcp-scope .mcp-note.ok')).toContainText('접근 범위를 저장했습니다');
    await win.locator('.mcp-scope select').selectOption('approval_required');
    await win.getByRole('button', { name: '쓰기 정책 저장', exact: true }).click();
    await expect(win.locator('.mcp-scope .mcp-note.ok')).toContainText('접근 범위를 저장했습니다');

    const enginePath = await win.evaluate(() => window.electronAPI.mcpEnginePath());
    const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const metadataPath = path.join(userDataDir, 'metadata.db');
    mcpProcess = spawn(enginePath, ['-db', metadataPath, '-mcp', profileId, '-token', 'mcp'], {
      env: process.env,
      stdio: 'pipe',
    });
    const output = createInterface({ input: mcpProcess.stdout });
    mcpProcess.stderr.on('data', () => undefined);

    sendRpc(mcpProcess, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
    });
    const initialized = await nextRpcLine(output);
    expect(initialized.result).toMatchObject({ protocolVersion: '2024-11-05' });
    sendRpc(mcpProcess, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    sendRpc(mcpProcess, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await nextRpcLine(output);
    expect(listed.result?.tools?.some((tool) => tool.name === 'run_select')).toBe(true);
    expect(listed.result?.tools?.some((tool) => tool.name === 'write_proposal_status')).toBe(true);

    sendRpc(mcpProcess, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'run_select', arguments: { sql: 'SELECT * FROM denied_table' } },
    });
    const denied = await nextRpcLine(output);
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content?.[0]?.text).toContain('MCP table access denied');

    // The DB may not be running in CI, but the MCP server still traces the
    // exact SQL before the connector is invoked. This gives the activity UI a
    // deterministic query and elapsed-time record to inspect.
    sendRpc(mcpProcess, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'run_select', arguments: { sql: 'SELECT * FROM allowed_table' } },
    });
    const traced = await nextRpcLine(output);
    expect(traced.result?.isError).toBe(true);

    sendRpc(mcpProcess, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'propose_write', arguments: { sql: "UPDATE allowed_table SET name = 'approved' WHERE id = 1" } },
    });
    const proposal = await nextRpcLine(output);
    expect(proposal.result?.isError).not.toBe(true);
    expect(proposal.result?.content?.[0]?.text).toContain('pending_approval');

    // Confirm the existing activity preview before pushing the history past
    // the list limit.
    await win.getByRole('button', { name: '새로 고침', exact: true }).first().click();
    await expect(win.locator('.mcp-activity-row[data-event="session_started"]')).toHaveCount(1);
    await expect(win.locator('.mcp-activity-row[data-event="tool_call"][data-tool="run_select"]')).toHaveCount(2);

    // Add more than the activity list limit with cheap, deterministic tool
    // errors. The final traced call remains the newest row for detail testing.
    for (let i = 0; i < 105; i += 1) {
      sendRpc(mcpProcess, {
        jsonrpc: '2.0',
        id: 100 + i,
        method: 'tools/call',
        params: { name: 'unknown_tool', arguments: {} },
      });
      const overflow = await nextRpcLine(output);
      expect(overflow.result?.isError).toBe(true);
    }
    sendRpc(mcpProcess, {
      jsonrpc: '2.0',
      id: 999,
      method: 'tools/call',
      params: { name: 'run_select', arguments: { sql: 'SELECT * FROM allowed_table' } },
    });
    const newestTraced = await nextRpcLine(output);
    expect(newestTraced.result?.isError).toBe(true);

    await stopProcess(mcpProcess);
    output.close();
    mcpProcess = undefined;

    await win.locator('.conn-modal .modal-head button[aria-label="닫기"]').click();

    await win.locator('.statusbar-action[aria-label="MCP 활동 열기"]').click();
    const activityPage = win.locator('.mcp-activity-page');
    await expect(activityPage).toBeVisible();
    await expect(activityPage.locator('.mcp-activity-list-row')).toHaveCount(100);
    const tracedRow = activityPage.locator('.mcp-activity-list-row[data-event="tool_call"][data-tool="run_select"]').first();
    await tracedRow.click();
    const detail = tracedRow.locator('xpath=following-sibling::div[contains(@class, "mcp-activity-detail")]');
    await expect(detail).toContainText('실행 쿼리');
    await expect(detail).toContainText('SELECT * FROM allowed_table');
    await expect(detail).toContainText('소요 시간');
    await expect(detail.locator('pre')).toBeVisible();
    await expect(activityPage.getByRole('button', { name: 'MCP 활동 닫기' })).toBeVisible();
    const pendingProposal = activityPage.locator('.mcp-write-proposal');
    await expect(pendingProposal).toHaveCount(1);
    await expect(pendingProposal).toContainText("UPDATE allowed_table SET name = 'approved'");
    await pendingProposal.getByRole('button', { name: '거부', exact: true }).click();
    await expect(pendingProposal).toHaveCount(0);
    await activityPage.getByRole('button', { name: 'MCP 활동 닫기' }).click();
  } finally {
    if (mcpProcess) await stopProcess(mcpProcess);
    if (profileId) {
      await win.evaluate((id) => window.electronAPI.deleteProfile(id), profileId).catch(() => undefined);
    }
  }
});

test('MCP write approval executes the reviewed SQL for the selected connection', async ({ app, firstWindow: win }) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-mcp-write-'));
  const databaseFile = path.join(fixtureDir, 'write-approval.db');
  execFileSync('sqlite3', [databaseFile, "CREATE TABLE mcp_write_e2e (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO mcp_write_e2e VALUES (1, 'before');"]);
  let profileId = '';
  let mcpProcess: ChildProcessWithoutNullStreams | undefined;

  try {
    await win.locator('.sidebar-head button').click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill('MCP Write Approval E2E');
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const row = win.locator('.conn-list .conn-row').filter({ hasText: 'MCP Write Approval E2E' });
    await expect(row).toBeVisible();
    const profiles = await win.evaluate(() => window.electronAPI.listProfiles());
    profileId = profiles.data?.find((profile) => profile.name === 'MCP Write Approval E2E')?.id ?? '';
    expect(profileId).not.toBe('');

    await row.locator('button[title="Edit profile"]').click();
    await win.getByRole('button', { name: 'MCP', exact: true }).click();
    await win.locator('.mcp-toggle input').check();
    await win.locator('.mcp-scope select').selectOption('approval_required');
    await win.getByRole('button', { name: '쓰기 정책 저장', exact: true }).click();
    await expect(win.locator('.mcp-scope .mcp-note.ok')).toContainText('접근 범위를 저장했습니다');

    const enginePath = await win.evaluate(() => window.electronAPI.mcpEnginePath());
    const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    mcpProcess = spawn(enginePath, ['-db', path.join(userDataDir, 'metadata.db'), '-mcp', profileId, '-token', 'mcp'], { env: process.env, stdio: 'pipe' });
    const output = createInterface({ input: mcpProcess.stdout });
    mcpProcess.stderr.on('data', () => undefined);
    sendRpc(mcpProcess, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'write-e2e', version: '1' } },
    });
    await nextRpcLine(output);
    sendRpc(mcpProcess, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    sendRpc(mcpProcess, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'propose_write', arguments: { sql: "UPDATE mcp_write_e2e SET value = 'after' WHERE id = 1" } },
    });
    const proposal = await nextRpcLine(output);
    expect(proposal.result?.content?.[0]?.text).toContain('pending_approval');
    await stopProcess(mcpProcess);
    output.close();
    mcpProcess = undefined;

    await win.locator('.conn-modal .modal-head button[aria-label="닫기"]').click();
    await win.locator('.statusbar-action[aria-label="MCP 활동 열기"]').click();
    const activityPage = win.locator('.mcp-activity-page');
    await expect(activityPage).toBeVisible();
    const pendingProposal = activityPage.locator('.mcp-write-proposal');
    await expect(pendingProposal).toHaveCount(1);
    await expect(pendingProposal).toContainText("UPDATE mcp_write_e2e SET value = 'after'");
    await pendingProposal.getByRole('button', { name: '승인 후 실행', exact: true }).click();
    await expect(pendingProposal).toHaveCount(0, { timeout: 20_000 });
    expect(execFileSync('sqlite3', [databaseFile, 'SELECT value FROM mcp_write_e2e WHERE id = 1;'], { encoding: 'utf8' }).trim()).toBe('after');
    await activityPage.getByRole('button', { name: 'MCP 활동 닫기' }).click();
  } finally {
    if (mcpProcess) await stopProcess(mcpProcess);
    if (profileId) await win.evaluate((id) => window.electronAPI.deleteProfile(id), profileId).catch(() => undefined);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
