import { test, expect } from './fixtures';
import { isPortOpen, MYSQL } from './dbProbe';
import { connectMySql } from './helpers';

test.describe('Agent markdown rendering', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(MYSQL.host, MYSQL.port);
    test.skip(!open, `No MySQL on ${MYSQL.host}:${MYSQL.port}`);
  });

  test('renders streamed assistant markdown as formatted content', async ({ app, firstWindow: win }, testInfo) => {
    await connectMySql(win, 'Agent Markdown MySQL');

    await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
      ipcMain.removeHandler('agent-run');
      ipcMain.handle('agent-run', async (_event, runId: string, _profileId: string, _messages: unknown, options?: { responseLanguage?: string }) => {
        if (options?.responseLanguage !== 'english') {
          throw new Error(`expected English response language, got ${options?.responseLanguage ?? 'unset'}`);
        }
        setTimeout(() => {
          const win = BrowserWindow.getAllWindows()[0];
          const text = `# Summary

- **users** table is available
- Run \`SELECT\` for a quick check

\`\`\`sql
SELECT * FROM users;
\`\`\`

| Column | Type | Nullable | Primary Key |
|--------|------|----------|-------------|
| id | int | No | Yes |
| name | varchar | No | No |`;
          win.webContents.send('agent-stream-chunk', runId, { kind: 'text', text });
          win.webContents.send('agent-stream-chunk', runId, { kind: 'done' });
        }, 0);
        return { success: true, data: { success: true } };
      });
    });

    await win.locator('.icon-btn[title="설정"]').click();
    const settings = win.locator('.settings-page');
    await settings.locator('.settings-menu-item', { hasText: 'Agent' }).click();
    await settings.locator('label', { hasText: 'Response language' }).locator('select').selectOption('english');
    await settings.locator('.icon-btn[aria-label="설정 닫기"]').click();

    await win.locator('.agent-toggle').click();
    await expect(win.locator('.agent-chat')).toBeVisible();

    const composer = win.locator('.agent-composer textarea');
    await composer.fill('Show a markdown summary');
    await composer.press('Enter');

    const markdown = win.locator('.agent-msg.assistant .agent-markdown');
    await expect(markdown.locator('h1')).toHaveText('Summary');
    await expect(markdown.locator('strong')).toHaveText('users');
    await expect(markdown.locator('code').filter({ hasText: 'SELECT' }).first()).toBeVisible();
    await expect(markdown.locator('pre code')).toContainText('SELECT * FROM users;');
    await expect(markdown.locator('table')).toBeVisible();
    await expect(markdown.locator('th').filter({ hasText: 'Column' })).toBeVisible();
    await expect(markdown.locator('td').filter({ hasText: 'varchar' })).toBeVisible();

    await win.screenshot({ path: testInfo.outputPath('agent-markdown.png') });
  });
});
