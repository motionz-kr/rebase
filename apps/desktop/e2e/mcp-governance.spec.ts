import { test, expect } from './fixtures';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface } from 'readline';
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

    sendRpc(mcpProcess, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'run_select', arguments: { sql: 'SELECT * FROM denied_table' } },
    });
    const denied = await nextRpcLine(output);
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content?.[0]?.text).toContain('MCP table access denied');
    await stopProcess(mcpProcess);
    output.close();
    mcpProcess = undefined;

    await win.getByRole('button', { name: '새로 고침', exact: true }).first().click();
    await expect(win.locator('.mcp-activity-row[data-event="session_started"]')).toHaveCount(1);
    await expect(win.locator('.mcp-activity-row[data-event="tool_call"][data-tool="run_select"]')).toHaveCount(1);
  } finally {
    if (mcpProcess) await stopProcess(mcpProcess);
    if (profileId) {
      await win.evaluate((id) => window.electronAPI.deleteProfile(id), profileId).catch(() => undefined);
    }
  }
});
