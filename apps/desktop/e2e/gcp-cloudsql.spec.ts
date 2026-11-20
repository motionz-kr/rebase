import { test as base, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { typeQuery } from './helpers';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const INSTANCE = 'e2e-proj:asia-northeast3:db1';
const POSTGRES = {
  host: '127.0.0.1',
  port: Number(process.env.E2E_POSTGRES_PORT ?? 5432),
  database: process.env.E2E_POSTGRES_DATABASE ?? 'e2edb',
  username: process.env.E2E_POSTGRES_USER ?? 'postgres',
  password: process.env.E2E_POSTGRES_PASSWORD ?? 'e2epass',
};

type ProxyRecord = { pid: number; args: string[]; port: number; address: string; instance: string };
type FakeProxy = { dir: string; log: string; env: Record<string, string>; records(): ProxyRecord[] };

const test = base.extend<{ fakeProxy: FakeProxy; dbPort: number }>({
  dbPort: [MYSQL.port, { option: true }],
  fakeProxy: async ({ dbPort }, use) => {
    test.skip(process.platform === 'win32', 'Fake cloud-sql-proxy fixture uses POSIX shebangs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-gcp-e2e-'));
    const log = path.join(dir, 'launches.jsonl');
    fs.writeFileSync(path.join(dir, 'cloud-sql-proxy'), `#!${process.execPath}\n` + String.raw`
const net = require('net');
const fs = require('fs');
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1]; };
const port = Number(option('--port'));
const instance = args[args.length - 1];
fs.appendFileSync(process.env.REBASE_E2E_GCP_LOG, JSON.stringify({ pid: process.pid, args, port, address: option('--address'), instance }) + '\n');
const fail = (line) => { console.error(line); process.exit(1); };
if (instance.endsWith(':expired')) {
  console.error('Authorizing with gcloud user credentials');
  fail('failed to refresh token: oauth2: "invalid_grant" "Reauthentication failed. Please run gcloud auth login" secret-e2e-token');
}
if (instance.endsWith(':denied')) {
  console.error('Authorizing with gcloud user credentials');
  console.error('Connection test started');
  fail('Connection test failed; proxy server error: failed to get instance: googleapi: Error 403: boss::NOT_AUTHORIZED: Not authorized to access resource. Possibly missing permission cloudsql.instances.get on resource instances/denied., forbidden secret-e2e-token');
}
if (instance.endsWith(':missing')) {
  console.error('Authorizing with gcloud user credentials');
  console.error('Connection test started');
  fail('proxy server error: failed to get instance: refresh error: failed to get instance metadata (connection name = "' + instance + '"): googleapi: Error 400: Project specified in the request is invalid., errorInvalidProject secret-e2e-token');
}
const dbPort = Number(process.env.REBASE_E2E_GCP_DB_PORT);
const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect(dbPort, '127.0.0.1');
  sockets.add(client); sockets.add(upstream);
  client.pipe(upstream); upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
  client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
});
server.listen(port, option('--address') || '127.0.0.1', () => {
  console.error('Authorizing with gcloud user credentials');
  console.error('[' + instance + '] Listening on ' + option('--address') + ':' + port);
  console.error('The proxy has started successfully and is ready for new connections!');
  console.error('Connection test started');
  console.error('Connection test passed');
});
process.on('SIGTERM', () => { for (const s of sockets) s.destroy(); server.close(() => process.exit(0)); });
`);
    fs.chmodSync(path.join(dir, 'cloud-sql-proxy'), 0o755);
    // --gcloud-auth needs a gcloud on the child PATH; the fake never calls it.
    fs.writeFileSync(path.join(dir, 'gcloud'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fake: FakeProxy = {
      dir, log,
      env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, REBASE_E2E_GCP_LOG: log, REBASE_E2E_GCP_DB_PORT: String(dbPort) },
      records: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [],
    };
    try { await use(fake); } finally {
      for (const record of fake.records()) { try { process.kill(record.pid, 'SIGKILL'); } catch {} }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  launchEnv: async ({ fakeProxy }, use) => { await use(fakeProxy.env); },
});

// Engine stores each profile password in the real login Keychain (independent of the temp metadata DB).
function deleteKeychainSecret(account: string) {
  try { execFileSync('security', ['delete-generic-password', '-s', 'AntigravityDBDesktop', '-a', account], { stdio: 'pipe' }); }
  catch (error) {
    const text = String((error as { stderr?: Buffer }).stderr ?? error);
    if (!/could not be found/i.test(text)) throw error;
  }
}

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function fillCloudSQL(win: import('@playwright/test').Page, db: { driver: string; database: string; username: string; password: string }, instance = INSTANCE, name = 'GCP E2E') {
  await win.getByRole('button', { name: '새 연결' }).click();
  const form = win.locator('.conn-form');
  await form.locator('label:text-is("Profile name") + input').fill(name);
  await form.locator('select').first().selectOption(db.driver);
  await win.locator('#connection-mode').selectOption('gcp_cloudsql');
  await expect(win.locator('#gcp-instance')).toBeVisible();
  await expect(form.locator('label:text-is("Host") + input')).toHaveCount(0);
  await expect(form.locator('label:text-is("Port") + input')).toHaveCount(0);
  await win.locator('#gcp-instance').fill(instance);
  await form.locator('label:text-is("Database") + input').fill(db.database);
  await form.locator('label:text-is("Username") + input').fill(db.username);
  await form.locator('label:has-text("Password") + input').fill(db.password);
  return form;
}

function rpcClient(child: ChildProcessWithoutNullStreams, rawLines: string[]) {
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  lines.on('line', (line) => {
    rawLines.push(line);
    try { const value = JSON.parse(line); const call = pending.get(value.id); if (call) { pending.delete(value.id); call.resolve(value); } }
    catch { for (const call of pending.values()) call.reject(new Error(`Non-JSON data on MCP stdout: ${line}`)); }
  });
  lines.on('close', () => { for (const call of pending.values()) call.reject(new Error('MCP process closed')); });
  return (id: number, method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')); }, 20000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function stopMCP(child: ChildProcessWithoutNullStreams, signal?: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MCP engine did not shut down gracefully')); }, 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (signal) child.kill(signal); else child.stdin.end();
  });
}

test('Cloud SQL curated startup errors never leak raw proxy output', async ({ firstWindow: win, fakeProxy }) => {
  const form = await fillCloudSQL(win, { driver: 'mysql', ...MYSQL }, 'e2e-proj:asia-northeast3:expired', 'GCP Errors');
  const cases = [
    { instance: 'e2e-proj:asia-northeast3:expired', text: 'gcloud 로그인이 만료' },
    { instance: 'e2e-proj:asia-northeast3:denied', text: 'IAM 권한이 부족' },
    { instance: 'e2e-proj:asia-northeast3:missing', text: '인스턴스를 찾을 수 없습니다' },
  ];
  for (const [i, c] of cases.entries()) {
    await win.locator('#gcp-instance').fill(c.instance);
    await form.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(form.locator('.alert.error')).toContainText(c.text);
    await expect(form.locator('.alert.error')).not.toContainText('secret-e2e-token');
    await expect(form.locator('.alert.error')).not.toContainText('oauth2');
    await expect(form.locator('.alert.error')).not.toContainText('googleapi');
    await expect.poll(() => fakeProxy.records().length).toBe(i + 1);
    expect(fakeProxy.records()[i].instance).toBe(c.instance);
  }
  expect(fakeProxy.records().every((r) => !alive(r.pid))).toBe(true);
  await win.screenshot({ path: test.info().outputPath('gcp-errors.png') });
});

test('Cloud SQL route form: host/port hidden, auth fields shown, switching away restores direct form', async ({ firstWindow: win }) => {
  await win.getByRole('button', { name: '새 연결' }).click();
  const form = win.locator('.conn-form');
  await expect(win.locator('#connection-mode option[value="gcp_cloudsql"]')).toHaveText('GCP Cloud SQL (cloud-sql-proxy)');
  await win.locator('#connection-mode').selectOption('gcp_cloudsql');
  await expect(win.locator('#gcp-auth-mode')).toBeVisible();
  await expect(win.locator('#gcp-private-ip')).toBeVisible();
  await expect(win.locator('#gcp-proxy-path')).toBeVisible();
  await win.locator('#gcp-auth-mode').selectOption('credentials_file');
  await expect(win.locator('#gcp-credentials-file')).toBeVisible();
  await win.locator('#connection-mode').selectOption('direct');
  await expect(win.locator('#gcp-instance')).toHaveCount(0);
  await expect(form.locator('label:text-is("Host") + input')).toBeVisible();
});

for (const db of [
  { driver: 'mysql', ...MYSQL, database: process.env.E2E_MYSQL_DATABASE ?? 'mysql' },
  { driver: 'postgres', ...POSTGRES },
]) {
  test.describe(`Cloud SQL ${db.driver} local DB path`, () => {
    test.use({ dbPort: db.port });
    test.beforeAll(async () => { test.skip(!await isPortOpen(db.host, db.port), `No local ${db.driver}; skip Cloud SQL DB flow`); });
    test('UI queries, proxy reuse, legacy profiles, shutdown cleanup and independent MCP engine', async ({ app, firstWindow: win, fakeProxy }) => {
      test.setTimeout(120000);
      let id = ''; let child: ChildProcessWithoutNullStreams | undefined; let appClosed = false;
      const secretAccounts = new Set<string>();
      const track = (profile?: { id?: string; secretRef?: string }) => { if (profile?.id) secretAccounts.add(profile.secretRef || `secret-${profile.id}`); };
      const mcpLines: string[] = [];
      try {
        // Pre-existing SSM and SSH profiles in the same isolated metadata DB.
        const ssm = await win.evaluate(() => window.electronAPI.createProfile({ name: 'Legacy SSM', driver: 'mysql', host: 'db.e2e.invalid', port: 3306, database: 'x', username: 'u', tlsMode: 'none', connectionMode: 'ssm', ssm: { profile: 'e2e', region: 'ap-northeast-2', instanceId: 'i-0123456789abcdef0' } } as any, 'pw'));
        track(ssm.data); expect(ssm.success).toBe(true);
        fs.writeFileSync(path.join(fakeProxy.dir, 'id_e2e'), 'not-a-real-key\n', { mode: 0o600 });
        const ssh = await win.evaluate((identityFile) => window.electronAPI.createProfile({ name: 'Legacy SSH', driver: 'mysql', host: 'db.e2e.invalid', port: 3306, database: 'x', username: 'u', tlsMode: 'none', connectionMode: 'ssh', ssh: { host: 'bastion.e2e.invalid', port: 22, username: 'e2e', identityFile } } as any, 'pw'), path.join(fakeProxy.dir, 'id_e2e'));
        track(ssh.data); expect(ssh.success).toBe(true);
        await win.reload();
        await win.waitForLoadState('domcontentloaded');
        await expect(win.locator('.conn-row').filter({ hasText: 'Legacy SSM' })).toContainText('SSM · db.e2e.invalid');
        await expect(win.locator('.conn-row').filter({ hasText: 'Legacy SSH' })).toContainText('SSH · db.e2e.invalid');

        const form = await fillCloudSQL(win, db);
        await expect(win.locator('#gcp-auth-mode')).toHaveValue('gcloud');
        await form.getByRole('button', { name: 'Test', exact: true }).click();
        await expect(win.locator('.ssm-test-success')).toContainText('연결 테스트에 성공');
        await win.screenshot({ path: test.info().outputPath('gcp-test-success.png') });
        expect(fakeProxy.records()).toHaveLength(1);
        // Unsaved test proxy is released immediately.
        await expect.poll(async () => isPortOpen('127.0.0.1', fakeProxy.records()[0].port)).toBe(false);
        await expect.poll(() => alive(fakeProxy.records()[0].pid)).toBe(false);

        await form.locator('button[type="submit"]').click();
        const row = win.locator('.conn-row').filter({ hasText: 'GCP E2E' });
        await expect(row).toContainText(`Cloud SQL · ${INSTANCE}`);
        const saved = await win.evaluate(() => window.electronAPI.listProfiles());
        const profile = saved.data!.find((p) => p.name === 'GCP E2E')!; id = profile.id!; track(profile);
        expect(profile.connectionMode).toBe('gcp_cloudsql');
        expect(profile.gcpCloudSql).toMatchObject({ instanceConnectionName: INSTANCE });
        expect(profile.tlsMode).toBe('none');
        expect(JSON.stringify(profile)).not.toContain(db.password);
        expect(saved.data!.find((p) => p.name === 'Legacy SSM')!.ssm!.instanceId).toBe('i-0123456789abcdef0');
        expect(saved.data!.find((p) => p.name === 'Legacy SSH')!.ssh!.host).toBe('bastion.e2e.invalid');

        await row.click();
        await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20000 });
        await typeQuery(win, 'SELECT 1 AS gcp_one');
        await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
        await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toContainText('1');
        // Concurrent operations share one proxy.
        const results = await win.evaluate(({ profileId, database }) => Promise.all([
          window.electronAPI.listDatabases(profileId),
          window.electronAPI.listTables(profileId, database),
          window.electronAPI.executeBatch(profileId, ['SELECT 2 AS gcp_a']),
          window.electronAPI.executeBatch(profileId, ['SELECT 3 AS gcp_b']),
        ]), { profileId: id, database: db.database });
        for (const r of results) expect(r.success).toBe(true);
        const records = fakeProxy.records();
        // [0] was the unsaved connection test; opening the saved profile reuses one proxy for its test, queries and batches.
        expect(records).toHaveLength(2);
        const launch = records[1];
        expect(launch.instance).toBe(INSTANCE);
        expect(launch.args).toContain('--gcloud-auth');
        expect(launch.args).toContain('--run-connection-test');
        expect(launch.args).not.toContain('--private-ip');
        expect(launch.args[launch.args.length - 1]).toBe(INSTANCE);
        expect(launch.address).toBe('127.0.0.1');
        expect(launch.port).not.toBe(db.port);
        expect(launch.port).toBeGreaterThan(0);
        expect(records[0].args.slice(-1)[0]).toBe(INSTANCE);
        await win.screenshot({ path: test.info().outputPath('gcp-query.png') });

        // Testing an edited route (not saved) runs on a temporary proxy and leaves the saved proxy alone.
        await row.locator('button[title="Edit profile"]').click();
        await win.locator('#gcp-instance').fill('e2e-proj:asia-northeast3:edited');
        await win.locator('.conn-form').getByRole('button', { name: 'Test', exact: true }).click();
        await expect(win.locator('.ssm-test-success')).toContainText('연결 테스트에 성공');
        expect(fakeProxy.records()).toHaveLength(3);
        const tempLaunch = fakeProxy.records()[2];
        expect(tempLaunch.instance).toBe('e2e-proj:asia-northeast3:edited');
        await expect.poll(() => alive(tempLaunch.pid)).toBe(false);
        await expect.poll(async () => isPortOpen('127.0.0.1', tempLaunch.port)).toBe(false);
        expect(alive(launch.pid)).toBe(true);
        expect(await isPortOpen('127.0.0.1', launch.port)).toBe(true);
        await win.locator('#gcp-instance').fill(INSTANCE);

        // Independent MCP engine for the saved profile.
        await row.locator('button[title="Edit profile"]').click();
        await expect(win.locator('#gcp-instance')).toHaveValue(INSTANCE);
        await win.getByRole('button', { name: 'MCP', exact: true }).click();
        await win.locator('.mcp-toggle input').check();
        await expect.poll(async () => (await win.evaluate(() => window.electronAPI.listProfiles())).data!.find((p) => p.id === id)!.mcpEnabled).toBe(true);
        await win.getByRole('button', { name: '기본 정보', exact: true }).click();
        await win.locator('.conn-form button[type="submit"]').click();
        await expect(win.locator('.conn-form')).toHaveCount(0);
        await expect.poll(async () => isPortOpen('127.0.0.1', launch.port)).toBe(false);
        // The edit released the old proxy; reconnect so the tab does not reuse a session bound to it.
        await row.getByRole('button', { name: 'Disconnect' }).click();
        await row.click();
        await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20000 });
        await typeQuery(win, 'SELECT 77 AS gcp_after_save');
        await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
        await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toHaveText('77');
        const desktopLaunch = fakeProxy.records().slice(-1)[0];
        const baseCount = fakeProxy.records().length;
        expect(desktopLaunch.pid).not.toBe(launch.pid);
        expect(await isPortOpen('127.0.0.1', desktopLaunch.port)).toBe(true);
        const engine = await win.evaluate(() => window.electronAPI.mcpEnginePath());
        const userDir = await app.evaluate(({ app }) => app.getPath('userData'));
        child = spawn(engine, ['-db', path.join(userDir, 'metadata.db'), '-mcp', id, '-token', 'mcp'], { env: { ...process.env, ...fakeProxy.env }, stdio: 'pipe' });
        const stderr: string[] = [];
        child.stderr.on('data', (d) => stderr.push(String(d)));
        const rpc = rpcClient(child, mcpLines);
        const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gcp-e2e', version: '1' } });
        expect(init.error).toBeUndefined();
        const result = await rpc(2, 'tools/call', { name: 'run_select', arguments: { sql: 'SELECT 74 AS gcp_mcp_value' } });
        expect(result.result.isError).not.toBe(true); expect(result.result.content[0].text).toContain('74');
        expect(fakeProxy.records()).toHaveLength(baseCount + 1);
        const mcpLaunch = fakeProxy.records()[baseCount];
        const again = await rpc(3, 'tools/call', { name: 'run_select', arguments: { sql: 'SELECT 76 AS gcp_mcp_value' } });
        expect(again.result.content[0].text).toContain('76');
        expect(fakeProxy.records()).toHaveLength(baseCount + 1);
        // Both engines hold live proxies at the same time on distinct ports.
        await typeQuery(win, 'SELECT 78 AS gcp_parallel_desktop');
        await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
        await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toHaveText('78');
        expect(fakeProxy.records()).toHaveLength(baseCount + 1); // desktop reuses its live proxy
        expect(desktopLaunch.port).not.toBe(mcpLaunch.port);
        expect(await isPortOpen('127.0.0.1', mcpLaunch.port)).toBe(true);
        expect(await isPortOpen('127.0.0.1', desktopLaunch.port)).toBe(true);
        expect(mcpLines.length).toBeGreaterThan(0);
        await stopMCP(child);
        // Validate the complete capture, including output written during shutdown.
        if (!child.stdout.closed) await new Promise((resolve) => child!.stdout.once('close', resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(mcpLines.length).toBeGreaterThan(0);
        for (const line of mcpLines) expect(JSON.parse(line).jsonrpc).toBe('2.0');
        expect(mcpLines.join('\n') + stderr.join('')).not.toContain('Connection test passed');
        await expect.poll(async () => isPortOpen('127.0.0.1', mcpLaunch.port)).toBe(false);
        await expect.poll(() => alive(mcpLaunch.pid)).toBe(false);
        // Desktop proxy is unaffected by the MCP engine exit.
        expect(alive(desktopLaunch.pid)).toBe(true);
        expect(await isPortOpen('127.0.0.1', desktopLaunch.port)).toBe(true);

        // Disconnect stops this profile's proxy; reconnecting starts a fresh one.
        const beforeDisconnect = fakeProxy.records().length;
        await row.getByRole('button', { name: 'Disconnect' }).click();
        await expect.poll(() => alive(desktopLaunch.pid)).toBe(false);
        await expect.poll(async () => isPortOpen('127.0.0.1', desktopLaunch.port)).toBe(false);
        expect(fakeProxy.records()).toHaveLength(beforeDisconnect);
        await row.click();
        await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20000 });
        await typeQuery(win, 'SELECT 1 AS gcp_after_disconnect');
        await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
        await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toHaveText('1');
        expect(fakeProxy.records()).toHaveLength(beforeDisconnect + 1);
        const reconnectLaunch = fakeProxy.records()[beforeDisconnect];
        expect(reconnectLaunch.pid).not.toBe(desktopLaunch.pid);
        expect(alive(reconnectLaunch.pid)).toBe(true);

        await app.close(); appClosed = true;
        await expect.poll(() => alive(reconnectLaunch.pid)).toBe(false);
        await expect.poll(() => alive(desktopLaunch.pid)).toBe(false);
        await expect.poll(async () => isPortOpen('127.0.0.1', desktopLaunch.port)).toBe(false);
      } finally {
        if (child) await stopMCP(child).catch(() => undefined);
        if (!appClosed) {
          // Best effort via the app while it is open (also catches profiles created before an id was tracked).
          const list = await win.evaluate(() => window.electronAPI.listProfiles()).catch(() => undefined);
          for (const p of list?.data ?? []) { track(p); await win.evaluate((profileId) => window.electronAPI.deleteProfile(profileId), p.id!).catch(() => undefined); }
        }
        // Remove exactly the Keychain entries this test created, also after app shutdown.
        if (process.platform === 'darwin') for (const account of secretAccounts) deleteKeychainSecret(account);
      }
    });
  });
}
