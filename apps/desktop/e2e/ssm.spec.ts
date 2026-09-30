import { test as base, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { typeQuery } from './helpers';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type TunnelRecord = { pid: number; port: number; profile: string; region: string; host: string; documentName: string; parameterNames: string[] };
type FakeSSM = { dir: string; log: string; env: Record<string, string>; records(): TunnelRecord[] };
const test = base.extend<{ fakeSSM: FakeSSM; customDocumentPort: number }>({
  customDocumentPort: [MYSQL.port, { option: true }],
  fakeSSM: async ({ customDocumentPort }, use) => {
    test.skip(process.platform === 'win32', 'Fake AWS executable fixture uses POSIX shebangs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-ssm-e2e-'));
    const log = path.join(dir, 'sessions.jsonl');
    fs.writeFileSync(path.join(dir, 'aws'), `#!${process.execPath}\n` + String.raw`
const net = require('net');
const fs = require('fs');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const profile = args.includes('--profile') ? option('--profile') : '';
if (profile === 'expired') { console.error('SSO token has expired secret-e2e-token'); process.exit(1); }
if (profile === 'denied') { console.error('AccessDeniedException User: arn:aws:sts::123:assumed-role/AWSReservedSSO_readonly secret-e2e-token'); process.exit(1); }
if (profile === 'missing-plugin') { console.error('SessionManagerPlugin is not found'); process.exit(1); }
const documentName = option('--document-name');
const params = JSON.parse(option('--parameters'));
const port = Number(params.localPortNumber[0]);
let remotePort, host;
if (documentName === 'AWS-StartPortForwardingSessionToRemoteHost') {
  if (params.host?.[0] !== 'db.e2e.invalid') process.exit(1);
  remotePort = Number(params.portNumber[0]); host = params.host[0];
} else if (documentName === 'Revisit-RdsPortForwarding') {
  if (JSON.stringify(Object.keys(params)) !== JSON.stringify(['localPortNumber'])) { console.error('InvalidParameters: document accepts localPortNumber only'); process.exit(1); }
  remotePort = Number(process.env.REBASE_E2E_CUSTOM_SSM_PORT); host = 'document.destination';
} else process.exit(1);
const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect(remotePort, '127.0.0.1');
  sockets.add(client); sockets.add(upstream);
  client.pipe(upstream); upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
  client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
});
server.listen(port, '127.0.0.1', () => {
  fs.appendFileSync(process.env.REBASE_E2E_SSM_LOG, JSON.stringify({ pid: process.pid, port, profile, region: option('--region'), host, documentName, parameterNames: Object.keys(params).sort() }) + '\n');
  console.log('Port ' + port + ' opened for sessionId e2e.');
  console.log('Waiting for connections...');
});
process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); });
`);
    fs.chmodSync(path.join(dir, 'aws'), 0o755);
    fs.writeFileSync(path.join(dir, 'session-manager-plugin'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fake: FakeSSM = {
      dir, log,
      env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, REBASE_E2E_SSM_LOG: log, REBASE_E2E_CUSTOM_SSM_PORT: String(customDocumentPort) },
      records: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [],
    };
    try { await use(fake); } finally {
      for (const record of fake.records()) { try { process.kill(record.pid, 'SIGKILL'); } catch {} }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  launchEnv: async ({ fakeSSM }, use) => { await use(fakeSSM.env); },
});

async function fillSSM(win: import('@playwright/test').Page, profile = 'e2e') {
  await win.locator('.sidebar-head button').click();
  const form = win.locator('.conn-form');
  await form.locator('label:text-is("Profile name") + input').fill('SSM E2E');
  await win.getByLabel('접속 경로').selectOption('ssm');
  await win.getByLabel('AWS profile (선택)', { exact: true }).fill(profile);
  await win.getByLabel('AWS region', { exact: true }).fill('ap-northeast-2');
  await win.getByLabel('EC2 instance ID', { exact: true }).fill('i-0123456789abcdef0');
  await form.locator('label:text-is("Host") + input').fill('db.e2e.invalid');
  await form.locator('label:text-is("Database") + input').fill(MYSQL.database);
  return form;
}

async function stopMCP(child: ChildProcessWithoutNullStreams, signal?: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MCP engine did not shut down gracefully')); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (signal) child.kill(signal); else child.stdin.end();
  });
}

async function sessionQuery(win: import('@playwright/test').Page, profileId: string, database: string, sessionId: string, sql: string) {
  return win.evaluate(({ profileId, database, sessionId, sql }) => new Promise<import('../../renderer/src/global').QueryStreamChunk[]>((resolve, reject) => {
    const queryId = `ssm-session-${crypto.randomUUID()}`;
    const chunks: import('../../renderer/src/global').QueryStreamChunk[] = [];
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('SSM manual query timeout')); }, 15000);
    const unsubscribe = window.electronAPI.onQueryStreamChunk((id, chunk) => {
      if (id !== queryId) return;
      chunks.push(chunk);
      if (['done', 'error', 'policy'].includes(chunk.type)) { clearTimeout(timer); unsubscribe(); resolve(chunks); }
    });
    void window.electronAPI.executeQueryStream(queryId, profileId, sql, { database, sessionId }).then((result) => {
      if (!result.success) { clearTimeout(timer); unsubscribe(); reject(new Error(result.error)); }
    });
  }), { profileId, database, sessionId, sql });
}

function rpcClient(child: ChildProcessWithoutNullStreams) {
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  lines.on('line', (line) => {
    try { const value = JSON.parse(line); const call = pending.get(value.id); if (call) { pending.delete(value.id); call.resolve(value); } }
    catch { for (const call of pending.values()) call.reject(new Error(`Non-JSON data on MCP stdout: ${line}`)); }
  });
  lines.on('close', () => { for (const call of pending.values()) call.reject(new Error('MCP process closed')); });
  return (id: number, method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')); }, 15000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

test('SSM settings and actionable connection errors in the real app', async ({ firstWindow: win }) => {
  const form = await fillSSM(win, 'expired');
  await form.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(form.locator('.alert.error')).toContainText('aws sso login');
  await expect(form.locator('.alert.error')).not.toContainText('secret-e2e-token');
  await win.getByLabel('AWS profile (선택)', { exact: true }).fill('denied');
  await form.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(form.locator('.alert.error')).toContainText('IAM');
  await win.getByLabel('AWS profile (선택)', { exact: true }).fill('missing-plugin');
  await form.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(form.locator('.alert.error')).toContainText('session-manager-plugin');
  await form.locator('select').first().selectOption('redis');
  await expect(win.locator('.ssm-settings')).toHaveCount(0);
});

for (const db of [
  { driver: 'mysql', ...MYSQL },
  { driver: 'postgres', host: '127.0.0.1', port: Number(process.env.E2E_SSM_POSTGRES_PORT ?? 5432), database: 'postgres', username: 'postgres', password: process.env.E2E_SSM_POSTGRES_PASSWORD ?? 'postgres' },
]) {
 for (const mode of ['remote-host', 'document'] as const) {
 test.describe(`SSM ${db.driver} ${mode} local DB path`, () => {
  test.use({ customDocumentPort: db.port });
  test.beforeAll(async () => { test.skip(!await isPortOpen(db.host, db.port), `No local ${db.driver}; skip SSM DB flow`); });
  test('UI queries, saved settings, tunnel reuse/restart and independent MCP engine', async ({ app, firstWindow: win, fakeSSM }) => {
    test.setTimeout(90000);
    let id = ''; let secretRef = ''; let appClosed = false; let child: ChildProcessWithoutNullStreams | undefined;
    try {
      const form = await fillSSM(win, mode === 'document' ? 'default' : 'e2e');
      await form.locator('select').first().selectOption(db.driver);
      await form.locator('label:text-is("Database") + input').fill(db.database);
      await form.locator('label:text-is("Port") + input').fill(String(db.port));
      await form.locator('label:text-is("Username") + input').fill(db.username);
      await form.locator('label:has-text("Password") + input').fill(db.password);
      if (mode === 'document') {
        await win.getByLabel('SSM document', { exact: false }).fill('Revisit-RdsPortForwarding');
        await win.getByLabel('DB 목적지 설정', { exact: true }).selectOption('document');
        await expect(form.locator('label:text-is("Host") + input')).toHaveCount(0);
        await expect(form.locator('label:text-is("Port") + input')).toHaveCount(0);
      }
      await form.getByRole('button', { name: 'Test', exact: true }).click();
      await expect(win.locator('.ssm-test-success')).toBeVisible();
      await expect(win.locator('.ssm-test-success')).toContainText('연결 테스트에 성공');
      await win.screenshot({ path: test.info().outputPath('ssm-test-success.png') });
      await win.getByLabel('접속 경로').scrollIntoViewIfNeeded();
      await win.screenshot({ path: test.info().outputPath('ssm-config.png') });
      // Unsaved connection-test tunnels are released immediately.
      await expect.poll(async () => isPortOpen('127.0.0.1', fakeSSM.records()[0]?.port ?? 0)).toBe(false);
      await form.locator('button[type="submit"]').click();
      const row = win.locator('.conn-row').filter({ hasText: 'SSM E2E' });
      await expect(row).toContainText(mode === 'document' ? 'SSM · Revisit-RdsPortForwarding' : 'SSM · db.e2e.invalid');
      const saved = await win.evaluate(() => window.electronAPI.listProfiles());
      const profile = saved.data!.find((p) => p.name === 'SSM E2E')!; id = profile.id!; secretRef = profile.secretRef ?? '';
      expect(profile.ssm).toEqual({ profile: mode === 'document' ? 'default' : 'e2e', region: 'ap-northeast-2', instanceId: 'i-0123456789abcdef0', ...(mode === 'document' ? { documentName: 'Revisit-RdsPortForwarding', destinationMode: 'document' } : {}) });
      expect(profile.host).toBe(mode === 'document' ? '' : 'db.e2e.invalid');
      if (mode === 'document') expect(profile.port).toBe(0);
      expect(fakeSSM.records()[0].documentName).toBe(mode === 'document' ? 'Revisit-RdsPortForwarding' : 'AWS-StartPortForwardingSessionToRemoteHost');
      expect(fakeSSM.records()[0].parameterNames).toEqual(mode === 'document' ? ['localPortNumber'] : ['host', 'localPortNumber', 'portNumber']);
      await row.click();
      await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20000 });
      await typeQuery(win, 'SELECT 73 AS ssm_value');
      await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
      await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toContainText('73');
      const databases = await win.evaluate((profileId) => window.electronAPI.listDatabases(profileId), id);
      expect(databases.success).toBe(true);
      const tables = await win.evaluate(({ profileId, database }) => window.electronAPI.listTables(profileId, database), { profileId: id, database: db.database });
      expect(tables.success).toBe(true);
      expect(fakeSSM.records()).toHaveLength(2);
      const batch = await win.evaluate((profileId) => window.electronAPI.executeBatch(profileId, ['SELECT 71 AS ssm_batch']), id);
      expect(batch.success).toBe(true); expect(batch.data!.ok).toBe(true);
      const opened = await win.evaluate(({ profileId, database }) => window.electronAPI.querySession('open', profileId, database, '', true), { profileId: id, database: db.database });
      expect(opened.success).toBe(true);
      const sessionId = opened.data!.sessionId!;
      const manual = await sessionQuery(win, id, db.database, sessionId, 'SELECT 72 AS ssm_manual');
      expect(manual.some((chunk) => chunk.type === 'error')).toBe(false);
      expect(manual.find((chunk) => chunk.type === 'row')!.data).toEqual([72]);
      expect(fakeSSM.records()).toHaveLength(2);
      // Simulate a dropped SSM process: the next new DB operation starts a tunnel.
      process.kill(fakeSSM.records()[1].pid, 'SIGKILL');
      await expect.poll(async () => isPortOpen('127.0.0.1', fakeSSM.records()[1].port)).toBe(false);
      const broken = await sessionQuery(win, id, db.database, sessionId, 'SELECT 999 AS must_not_replay');
      expect(broken.some((chunk) => chunk.type === 'error')).toBe(true);
      expect(broken.some((chunk) => chunk.type === 'row')).toBe(false);
      expect(fakeSSM.records()).toHaveLength(2); // A broken manual transaction is never replayed on a new tunnel.
      await win.evaluate(({ profileId, database, sessionId }) => window.electronAPI.querySession('close', profileId, database, sessionId, true), { profileId: id, database: db.database, sessionId });
      await typeQuery(win, 'SELECT 75 AS ssm_value');
      await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
      await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toContainText('75');
      expect(fakeSSM.records()).toHaveLength(3);
      await win.screenshot({ path: test.info().outputPath('ssm-query.png') });
      await row.locator('button[title="Edit profile"]').click();
      await expect(win.getByLabel('AWS region', { exact: true })).toHaveValue('ap-northeast-2');
      if (mode === 'document') {
        await expect(win.getByLabel('SSM document', { exact: false })).toHaveValue('Revisit-RdsPortForwarding');
        await expect(win.getByLabel('DB 목적지 설정', { exact: true })).toHaveValue('document');
      }
      // Test the edited route with its existing Keychain password.
      await win.locator('.conn-form').getByRole('button', { name: 'Test', exact: true }).click();
      await expect(win.locator('.ssm-test-success')).toBeVisible();
      await expect(win.locator('.ssm-test-success')).toContainText('연결 테스트에 성공');
      await win.getByRole('button', { name: 'MCP', exact: true }).click();
      await win.locator('.mcp-toggle input').check();
      await expect.poll(async () => (await win.evaluate(() => window.electronAPI.listProfiles())).data!.find((p) => p.id === id)!.mcpEnabled).toBe(true);
      await win.getByRole('button', { name: '기본 정보', exact: true }).click();
      await win.getByLabel('AWS region', { exact: true }).fill('us-east-1');
      await expect(win.locator('.ssm-test-success')).toHaveCount(0);
      await win.locator('.conn-form button[type="submit"]').click();
      const updated = (await win.evaluate(() => window.electronAPI.listProfiles())).data!.find((p) => p.id === id)!;
      expect(updated.mcpEnabled).toBe(true); expect(updated.ssm!.region).toBe('us-east-1');
      await expect.poll(async () => isPortOpen('127.0.0.1', fakeSSM.records()[2].port)).toBe(false);
      const engine = await win.evaluate(() => window.electronAPI.mcpEnginePath());
      const userDir = await app.evaluate(({ app }) => app.getPath('userData'));
      child = spawn(engine, ['-db', path.join(userDir, 'metadata.db'), '-mcp', id, '-token', 'mcp'], { env: { ...process.env, ...fakeSSM.env }, stdio: 'pipe' });
      child.stderr.on('data', () => undefined);
      const rpc = rpcClient(child);
      const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ssm-e2e', version: '1' } });
      expect(init.error).toBeUndefined();
      const result = await rpc(2, 'tools/call', { name: 'run_select', arguments: { sql: 'SELECT 74 AS ssm_mcp_value' } });
      expect(result.result.isError).not.toBe(true); expect(result.result.content[0].text).toContain('74');
      expect(fakeSSM.records()).toHaveLength(4);
      expect(fakeSSM.records()[3].region).toBe('us-east-1');
      const again = await rpc(3, 'tools/call', { name: 'run_select', arguments: { sql: 'SELECT 76 AS ssm_mcp_value' } });
      expect(again.result.content[0].text).toContain('76'); expect(fakeSSM.records()).toHaveLength(4);
      // Both engines hold live tunnels at the same time and must use distinct ports.
      await typeQuery(win, 'SELECT 78 AS ssm_parallel_desktop');
      await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
      await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toHaveText('78');
      expect(fakeSSM.records()).toHaveLength(5);
      expect(fakeSSM.records()[3].port).not.toBe(fakeSSM.records()[4].port);
      expect(await isPortOpen('127.0.0.1', fakeSSM.records()[3].port)).toBe(true);
      expect(await isPortOpen('127.0.0.1', fakeSSM.records()[4].port)).toBe(true);
      await stopMCP(child);
      await expect.poll(async () => isPortOpen('127.0.0.1', fakeSSM.records()[3].port)).toBe(false);
      expect(await isPortOpen('127.0.0.1', fakeSSM.records()[4].port)).toBe(true);
      await typeQuery(win, 'SELECT 77 AS ssm_after_mcp');
      await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
      await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toHaveText('77');
      expect(fakeSSM.records()).toHaveLength(5);
      // SIGTERM must stop a standalone MCP engine even with stdin still open.
      child = spawn(engine, ['-db', path.join(userDir, 'metadata.db'), '-mcp', id, '-token', 'mcp'], { env: { ...process.env, ...fakeSSM.env }, stdio: 'pipe' });
      child.stderr.on('data', () => undefined);
      const signalRPC = rpcClient(child);
      expect((await signalRPC(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ssm-signal-e2e', version: '1' } })).error).toBeUndefined();
      const signalResult = await signalRPC(2, 'tools/call', { name: 'run_select', arguments: { sql: 'SELECT 79 AS ssm_signal' } });
      expect(signalResult.result.isError).not.toBe(true); expect(signalResult.result.content[0].text).toContain('79');
      expect(fakeSSM.records()).toHaveLength(6);
      expect(fakeSSM.records()[5].port).not.toBe(fakeSSM.records()[4].port);
      await stopMCP(child, 'SIGTERM');
      expect(child.signalCode).not.toBe('SIGKILL');
      await expect.poll(async () => isPortOpen('127.0.0.1', fakeSSM.records()[5].port)).toBe(false);
      expect(await isPortOpen('127.0.0.1', fakeSSM.records()[4].port)).toBe(true);
      // Desktop shutdown also cleans its own live tunnel, independently of MCP.
      await app.close(); appClosed = true;
      await expect.poll(async () => isPortOpen('127.0.0.1', fakeSSM.records()[4].port)).toBe(false);
    } finally {
      if (child) await stopMCP(child);
      if (id && !appClosed) await win.evaluate((profileId) => window.electronAPI.deleteProfile(profileId), id);
      if (appClosed && secretRef && process.platform === 'darwin') {
        try { execFileSync('security', ['delete-generic-password', '-s', 'AntigravityDBDesktop', '-a', secretRef], { stdio: 'ignore' }); } catch {}
      }
    }
  });
});

}
}
