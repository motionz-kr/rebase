import { test, expect } from './fixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface } from 'readline';
import { isPortOpen } from './dbProbe';

type RpcResponse = {
  result?: { tools?: Array<{ name: string }>; content?: Array<{ text?: string }>; isError?: boolean };
  error?: { message: string };
};

function nextRpcLine(output: Interface): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for MCP response'));
    }, 10_000);
    const onLine = (line: string) => {
      cleanup();
      try {
        resolve(JSON.parse(line) as RpcResponse);
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      output.removeListener('line', onLine);
    };
    output.once('line', onLine);
  });
}

function sendRpc(process: ChildProcessWithoutNullStreams, id: number, method: string, params: Record<string, unknown> = {}) {
  process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
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

const dockerFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-fake-docker-'));
const dockerFixture = path.join(dockerFixtureDir, 'docker');
const discoveryMysqlPort = Number(process.env.E2E_DISCOVERY_MYSQL_PORT ?? 43306);
const dockerListOutput = JSON.stringify({
  Names: 'rebase-e2e-mysql',
  Ports: `127.0.0.1:${discoveryMysqlPort}->3306/tcp`,
});
fs.writeFileSync(dockerFixture, `#!/bin/sh\nprintf '%s\\n' '${dockerListOutput}'\n`, { mode: 0o755 });

test.use({
  launchEnv: {
    PATH: `${dockerFixtureDir}:${process.env.PATH ?? ''}`,
    DOCKER_HOST: 'tcp://127.0.0.1:2375',
  },
});

test.afterAll(() => {
  fs.rmSync(dockerFixtureDir, { recursive: true, force: true });
});

test('one discovery flow finds a local Docker database and fills only safe connection defaults', async ({ firstWindow: win }) => {
  await win.getByRole('button', { name: '찾기' }).click();
  const dialog = win.getByRole('dialog', { name: '내 PC에서 데이터베이스 찾기' });
  const candidate = dialog.getByRole('button', { name: new RegExp(`MySQL.*127\\.0\\.0\\.1:${discoveryMysqlPort}.*Docker.*rebase-e2e-mysql`) });
  await expect(candidate).toBeVisible();
  await candidate.click();

  const form = win.locator('.conn-form');
  await expect(form.locator('label:text-is("Host") + input')).toHaveValue('127.0.0.1');
  await expect(form.locator('label:text-is("Port") + input')).toHaveValue(String(discoveryMysqlPort));
  await expect(form.locator('label:text-is("Profile name") + input')).toHaveValue(`MySQL · 127.0.0.1:${discoveryMysqlPort}`);
  await expect(form.locator('label:text-is("Database") + input')).toHaveValue('');
  await expect(form.locator('label:text-is("Username") + input')).toHaveValue('');
  await expect(form.locator('label:text-is("Password (OS keychain)") + input')).toHaveValue('');
  await form.locator('label:text-is("Database") + input').fill('e2e_discovery');
  await form.locator('button[type="submit"]').click();
  await expect(win.getByText('저장하기 전에 현재 연결 정보로 연결 테스트를 성공시켜 주세요.')).toBeVisible();

  const profiles = await win.evaluate(() => window.electronAPI.listProfiles());
  expect(profiles.data ?? []).toHaveLength(0);
});

test('MCP can request a profile but Rebase requires its connection test before saving', async ({ app, firstWindow: win }) => {
  let mcpProcess: ChildProcessWithoutNullStreams | undefined;
  try {
    const enginePath = await win.evaluate(() => window.electronAPI.mcpEnginePath());
    const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    mcpProcess = spawn(enginePath, ['-db', path.join(userDataDir, 'metadata.db'), '-mcp', 'all'], {
      env: {
        ...process.env,
        PATH: `${dockerFixtureDir}:${process.env.PATH ?? ''}`,
        DOCKER_HOST: 'tcp://127.0.0.1:2375',
      },
      stdio: 'pipe',
    });
    const output = createInterface({ input: mcpProcess.stdout });
    mcpProcess.stderr.on('data', () => undefined);

    sendRpc(mcpProcess, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    const initialized = await nextRpcLine(output);
    expect(initialized.result).toMatchObject({ protocolVersion: '2024-11-05' });
    mcpProcess.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    sendRpc(mcpProcess, 2, 'tools/call', { name: 'discover_local_databases', arguments: {} });
    const discovery = await nextRpcLine(output);
    const discoveryText = discovery.result?.content?.[0]?.text;
    expect(discoveryText).toBeTruthy();
    const candidates = JSON.parse(discoveryText!) as { candidates: Array<{ id: string; driver: string; port: number }> };
    const candidate = candidates.candidates.find((item) => item.driver === 'mysql' && item.port === discoveryMysqlPort);
    expect(candidate).toBeTruthy();

    sendRpc(mcpProcess, 3, 'tools/call', {
      name: 'propose_connection_profile',
      arguments: { operation: 'create', candidateId: candidate!.id, name: 'MCP proposed test', database: 'e2e_test' },
    });
    const proposalResponse = await nextRpcLine(output);
    expect(proposalResponse.result?.isError).not.toBe(true);
  } finally {
    if (mcpProcess) await stopProcess(mcpProcess);
  }

  await win.getByRole('button', { name: 'MCP 활동 열기' }).click();
  const activity = win.getByRole('dialog', { name: 'MCP 활동' });
  await expect(activity.getByText('데이터베이스 연결 제안')).toBeVisible();
  await activity.getByRole('button', { name: '검토하고 연결' }).click();

  const form = win.locator('.conn-form');
  await expect(form.locator('label:text-is("Profile name") + input')).toHaveValue('MCP proposed test');
  await expect(form.locator('label:text-is("Database") + input')).toHaveValue('e2e_test');
  await form.locator('button[type="submit"]').click();
  await expect(win.getByText('저장하기 전에 현재 연결 정보로 연결 테스트를 성공시켜 주세요.')).toBeVisible();

  const profiles = await win.evaluate(() => window.electronAPI.listProfiles());
  expect(profiles.data ?? []).toHaveLength(0);
});

test('an approved MCP proposal connects, saves safely, then appears in the running MCP registry', async ({ app, firstWindow: win }) => {
  const databaseAvailable = await isPortOpen('127.0.0.1', discoveryMysqlPort);
  test.skip(!databaseAvailable, 'No disposable MySQL fixture is listening on the discovery test port');

  let mcpProcess: ChildProcessWithoutNullStreams | undefined;
  let createdProfileId = '';
  try {
    const enginePath = await win.evaluate(() => window.electronAPI.mcpEnginePath());
    const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    mcpProcess = spawn(enginePath, ['-db', path.join(userDataDir, 'metadata.db'), '-mcp', 'all'], {
      env: {
        ...process.env,
        PATH: `${dockerFixtureDir}:${process.env.PATH ?? ''}`,
        DOCKER_HOST: 'tcp://127.0.0.1:2375',
      },
      stdio: 'pipe',
    });
    const output = createInterface({ input: mcpProcess.stdout });
    mcpProcess.stderr.on('data', () => undefined);

    sendRpc(mcpProcess, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    expect((await nextRpcLine(output)).result).toMatchObject({ protocolVersion: '2024-11-05' });
    mcpProcess.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    sendRpc(mcpProcess, 2, 'tools/call', { name: 'discover_local_databases', arguments: {} });
    const discovery = await nextRpcLine(output);
    const discoveryText = discovery.result?.content?.[0]?.text;
    expect(discoveryText).toBeTruthy();
    const candidates = JSON.parse(discoveryText!) as { candidates: Array<{ id: string; driver: string; port: number }> };
    const candidate = candidates.candidates.find((item) => item.driver === 'mysql' && item.port === discoveryMysqlPort);
    expect(candidate).toBeTruthy();

    sendRpc(mcpProcess, 3, 'tools/call', {
      name: 'propose_connection_profile',
      arguments: { operation: 'create', candidateId: candidate!.id, name: 'MCP verified local test', database: 'e2e_discovery', username: 'root' },
    });
    const proposal = await nextRpcLine(output);
    expect(proposal.result?.isError).not.toBe(true);

    await win.getByRole('button', { name: 'MCP 활동 열기' }).click();
    const activity = win.getByRole('dialog', { name: 'MCP 활동' });
    await expect(activity.getByText('데이터베이스 연결 제안')).toBeVisible();
    await activity.getByRole('button', { name: '검토하고 연결' }).click();

    const form = win.locator('.conn-form');
    await expect(form.locator('label:text-is("Port") + input')).toHaveValue(String(discoveryMysqlPort));
    await expect(form.locator('label:text-is("Database") + input')).toHaveValue('e2e_discovery');
    await expect(form.locator('label:text-is("Username") + input')).toHaveValue('root');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(win.getByRole('status').getByText('연결 테스트에 성공했습니다.')).toBeVisible();
    await form.getByRole('button', { name: 'Save' }).click();

    const row = win.locator('.conn-list .conn-row').filter({ hasText: 'MCP verified local test' });
    await expect(row).toBeVisible();
    const profiles = await win.evaluate(() => window.electronAPI.listProfiles());
    const saved = profiles.data?.find((profile) => profile.name === 'MCP verified local test');
    expect(saved).toBeTruthy();
    createdProfileId = saved?.id ?? '';
    expect(saved?.mcpEnabled).toBe(false);
    expect(saved?.mcpWriteMode).toBe('disabled');
    expect(JSON.parse(saved?.mcpAllowedDatabases ?? '[]')).toEqual(['e2e_discovery']);

    const pending = await win.evaluate(() => window.electronAPI.mcpConnectionProposalsList('pending_approval'));
    expect(pending.data ?? []).toHaveLength(0);

    await row.locator('button[title="Edit profile"]').click();
    await win.getByRole('button', { name: 'MCP', exact: true }).click();
    const exposure = win.locator('.mcp-toggle input');
    await exposure.check();
    await expect(exposure).toBeChecked();
    await expect.poll(async () => {
      const result = await win.evaluate(() => window.electronAPI.listProfiles());
      return result.data?.find((profile) => profile.id === createdProfileId)?.mcpEnabled;
    }).toBe(true);
    await win.locator('.conn-modal .modal-head button[aria-label="닫기"]').click();

    sendRpc(mcpProcess, 4, 'tools/call', { name: 'list_connections', arguments: {} });
    const listed = await nextRpcLine(output);
    expect(listed.result?.isError).not.toBe(true);
    const connections = JSON.parse(listed.result?.content?.[0]?.text ?? '[]') as Array<{ connectionId: string }>;
    expect(connections.some((connection) => connection.connectionId === createdProfileId)).toBe(true);

    sendRpc(mcpProcess, 5, 'tools/call', {
      name: 'run_select',
      arguments: { connectionId: createdProfileId, sql: 'SELECT 1 AS ok' },
    });
    const query = await nextRpcLine(output);
    expect(query.result?.isError).not.toBe(true);
    expect(query.result?.content?.[0]?.text).toContain('1');
  } finally {
    if (mcpProcess) await stopProcess(mcpProcess);
    if (createdProfileId) {
      await win.evaluate((id) => window.electronAPI.deleteProfile(id), createdProfileId).catch(() => undefined);
    }
  }
});
