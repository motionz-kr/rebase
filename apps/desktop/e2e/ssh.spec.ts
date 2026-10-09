import { test as base, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { typeQuery } from './helpers';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { SSHConfig } from '../../renderer/src/lib/connectionRoute';

type SSHFixture = { config: SSHConfig; dir: string };
type TestDB = { driver: 'mysql' | 'postgres'; host: string; port: number; database: string; username: string; password: string };
const databases: TestDB[] = [
  { ...MYSQL, driver: 'mysql', port: Number(process.env.E2E_SSH_MYSQL_PORT ?? MYSQL.port), password: process.env.E2E_SSH_MYSQL_PASSWORD ?? MYSQL.password },
  { driver: 'postgres', host: '127.0.0.1', port: Number(process.env.E2E_SSH_POSTGRES_PORT ?? 5432), database: 'postgres', username: 'postgres', password: process.env.E2E_SSH_POSTGRES_PASSWORD ?? 'postgres' },
];
const test = base.extend<{ sshServer: SSHFixture; testDB: TestDB }, { sshBinary: string }>({
  testDB: [databases[0], { option: true }],
  sshBinary: [async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-ssh-build-'));
    try {
      const binary = path.join(dir, process.platform === 'win32' ? 'ssh-tests.exe' : 'ssh-tests');
      execFileSync(process.env.REBASE_GO_BINARY ?? 'go', ['test', '-c', '-o', binary, './engine/internal/adapters/ssh'], { cwd: path.resolve(__dirname, '../../..'), env: process.env, timeout: 120000 });
      await use(binary);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, { scope: 'worker', timeout: 120000 }],
  sshServer: async ({ sshBinary, testDB }, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-ssh-e2e-'));
    const child = spawn(sshBinary, ['-test.run=^TestSSHServerHelper$'], { env: { ...process.env, REBASE_SSH_HELPER: '1', REBASE_SSH_DIR: dir, REBASE_SSH_DESTINATION: `127.0.0.1:${testDB.port}` }, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const lines = readline.createInterface({ input: child.stdout });
      const config = await new Promise<SSHConfig>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSH helper startup timed out')), 10000);
        lines.once('line', (line) => { clearTimeout(timer); try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('SSH helper exited')); });
      });
      await use({ config, dir });
    } finally {
      child.stdin.end();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
});

async function stopMCP(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function rpcClient(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try { const response = JSON.parse(line); const call = pending.get(response.id); if (call) { pending.delete(response.id); call.resolve(response); } }
    catch { for (const call of pending.values()) call.reject(new Error('Non-JSON MCP stdout')); }
  });
  lines.on('close', () => { for (const call of pending.values()) call.reject(new Error('MCP process closed')); });
  return (id: number, method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')); }, 15000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function fillSSH(win: import('@playwright/test').Page, ssh: SSHConfig, db: TestDB = databases[0]) {
  await win.getByRole('button', { name: '새 연결' }).click();
  const form = win.locator('.conn-form');
  await form.locator('select').first().selectOption(db.driver);
  await form.locator('label:text-is("Profile name") + input').fill('SSH E2E');
  await win.getByLabel('접속 경로').selectOption('ssh');
  await win.getByLabel('Bastion Host', { exact: true }).fill(ssh.host);
  await win.getByLabel('SSH Port', { exact: true }).fill(String(ssh.port));
  await win.getByLabel('SSH User', { exact: true }).fill(ssh.username);
  await win.getByLabel('SSH 개인 키 파일', { exact: true }).fill(ssh.identityFile);
  await win.getByLabel('known_hosts 파일 (선택)', { exact: true }).fill(ssh.knownHostsFile!);
  await form.locator('label:text-is("Host") + input').fill('db.e2e.invalid');
  await form.locator('label:text-is("Port") + input').fill(String(db.port));
  await form.locator('label:text-is("Database") + input').fill(db.database);
  await form.locator('label:text-is("Username") + input').fill(db.username);
  await form.locator('label:has-text("Password") + input').fill(db.password);
  return form;
}

test('SSH host verification and missing key errors are shown without saving', async ({ firstWindow: win, sshServer, app }) => {
  const form = await fillSSH(win, sshServer.config);
  // Exercise renderer -> preload -> main picker IPC; the OS dialog response is
  // supplied by this isolated app so no personal files can be selected.
  await win.getByLabel('SSH 개인 키 파일', { exact: true }).fill('');
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async (options) => ({ canceled: false, filePaths: [options.title === 'SSH 개인 키 선택' ? files.identityFile : files.knownHostsFile!] });
  }, sshServer.config);
  await win.getByRole('button', { name: '키 파일 선택', exact: true }).click();
  await expect(win.getByLabel('SSH 개인 키 파일', { exact: true })).toHaveValue(sshServer.config.identityFile);
  await win.getByRole('button', { name: '호스트 키 파일 선택', exact: true }).click();
  await expect(win.getByLabel('known_hosts 파일 (선택)', { exact: true })).toHaveValue(sshServer.config.knownHostsFile!);
  const unknown = path.join(sshServer.dir, 'empty_known_hosts');
  fs.writeFileSync(unknown, '');
  await win.getByLabel('known_hosts 파일 (선택)', { exact: true }).fill(unknown);
  await form.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(win.locator('.conn-form .alert.error')).toContainText('호스트 키');
  await win.getByLabel('SSH 개인 키 파일', { exact: true }).fill(path.join(sshServer.dir, 'missing.pem'));
  await form.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(win.locator('.conn-form .alert.error')).toContainText('개인 키 파일을 읽을 수 없습니다');
  await expect(win.locator('.conn-form .alert.error')).not.toContainText('{"error"');
  const profiles = await win.evaluate(() => window.electronAPI.listProfiles());
  expect(profiles.success).toBe(true);
  expect(profiles.data ?? []).toEqual([]);
  await win.locator('.conn-form .alert.error').scrollIntoViewIfNeeded();
  await win.screenshot({ path: test.info().outputPath('ssh-error.png') });
  await win.getByLabel('접속 경로').scrollIntoViewIfNeeded();
  await win.screenshot({ path: test.info().outputPath('ssh-config-error.png') });
});

for (const db of databases) {
  test.describe(db.driver, () => {
    test.use({ testDB: db });
    test('SSH test, save, edit, UI and MCP queries through bastion', async ({ firstWindow: win, sshServer, app }) => {
      test.skip(!(await isPortOpen(db.host, db.port)), `No local test ${db.driver}`);
      let id = ''; let secretRef = ''; let mcp: ChildProcessWithoutNullStreams | undefined;
      try {
        const form = await fillSSH(win, sshServer.config, db);
        await form.getByRole('button', { name: 'Test', exact: true }).click();
        await expect(win.locator('.ssm-test-success')).toBeVisible();
        await win.getByLabel('접속 경로').scrollIntoViewIfNeeded();
        await win.screenshot({ path: test.info().outputPath('ssh-config-success.png') });
        await form.locator('button[type="submit"]').click();
        const row = win.locator('.conn-row').filter({ hasText: 'SSH E2E' });
        await expect(row).toContainText('SSH · db.e2e.invalid');
        const saved = await win.evaluate(() => window.electronAPI.listProfiles());
        const profile = saved.data!.find((p) => p.name === 'SSH E2E')!;
        id = profile.id!; secretRef = profile.secretRef ?? '';
        expect(profile.connectionMode).toBe('ssh'); expect(profile.ssh).toEqual(sshServer.config);
        await row.click();
        await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20000 });
        await typeQuery(win, 'SELECT 73 AS ssh_value');
        await win.locator('.conn-panel .editor-toolbar button', { hasText: 'Run' }).first().click();
        await expect(win.locator('.conn-panel .grid-body .grid-cell').first()).toContainText('73');
        await win.screenshot({ path: test.info().outputPath('ssh-query-success.png') });
        // Editing with no new password preserves the DB Keychain item and SSH references.
        await row.locator('button[title="Edit profile"]').click();
        await expect(win.getByLabel('접속 경로')).toHaveValue('ssh');
        await expect(win.getByLabel('SSH 개인 키 파일', { exact: true })).toHaveValue(sshServer.config.identityFile);
        await win.locator('.conn-form').getByRole('button', { name: 'Test', exact: true }).click();
        await expect(win.locator('.ssm-test-success')).toBeVisible();
        await win.locator('.conn-form button[type="submit"]').click();
        await expect(win.locator('.conn-form')).toHaveCount(0);
        const enabled = await win.evaluate((id) => window.electronAPI.mcpSetSettings(id, true, 'unrestricted', undefined, 'disabled'), id);
        expect(enabled.success).toBe(true);
        const binary = await win.evaluate(() => window.electronAPI.mcpEnginePath());
        const userDir = await app.evaluate(({ app }) => app.getPath('userData'));
        mcp = spawn(binary, ['-db', path.join(userDir, 'metadata.db'), '-mcp', 'all'], { env: process.env, stdio: 'pipe' });
        mcp.stderr.on('data', () => undefined);
        const rpc = rpcClient(mcp);
        expect((await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ssh-e2e', version: '1' } })).error).toBeUndefined();
        const connections = await rpc(2, 'tools/call', { name: 'list_connections', arguments: {} });
        expect(connections.result.isError).not.toBe(true);
        expect(connections.result.content[0].text).toContain(id);
        expect(connections.result.content[0].text).not.toContain(sshServer.config.identityFile);
        const result = await rpc(3, 'tools/call', { name: 'run_select', arguments: { connectionId: id, sql: 'SELECT 74 AS ssh_mcp_value' } });
        expect(result.error).toBeUndefined(); expect(result.result.isError).not.toBe(true);
        expect(result.result.content[0].text).toContain('74');
        await stopMCP(mcp);

      } finally {
        if (mcp) await stopMCP(mcp);
        if (id) await win.evaluate((id) => window.electronAPI.deleteProfile(id), id);
        if (secretRef && process.platform === 'darwin') {
          try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', 'AntigravityDBDesktop', '-a', secretRef], { stdio: 'ignore' }); } catch {}
        }
      }
    });
  });
}
