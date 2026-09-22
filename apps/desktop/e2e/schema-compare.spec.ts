import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test.describe('schema compare and migration draft', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-schema-compare-'));
  const sourceFile = path.join(fixtureDir, 'source.db');
  const targetFile = path.join(fixtureDir, 'target.db');

  test.beforeAll(() => {
    execFileSync('sqlite3', [sourceFile,
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT DEFAULT 'n/a'); CREATE UNIQUE INDEX idx_users_email ON users(email); CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);",
    ]);
    execFileSync('sqlite3', [targetFile,
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, old_field TEXT); CREATE UNIQUE INDEX idx_users_name ON users(name); CREATE TABLE legacy (id INTEGER PRIMARY KEY);',
    ]);
  });

  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('compares isolated SQLite files and drafts additive SQL without applying it', async ({ firstWindow: win }) => {
    const createProfile = async (name: string, databaseFile: string) => {
      await win.locator('.sidebar-head button').click();
      const form = win.locator('.conn-form');
      await form.locator('select').first().selectOption('sqlite');
      await form.locator('label:text-is("Profile name") + input').fill(name);
      await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
      await form.locator('button[type="submit"]').click();
      const row = win.locator('.conn-list .conn-row').filter({ hasText: name });
      await expect(row).toBeVisible();
      return row;
    };

    await createProfile('E2E Schema Compare Target', targetFile);
    const source = await createProfile('E2E Schema Compare Source', sourceFile);
    await source.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });
    await source.locator('button[title="Edit profile"]').click();
    await win.locator('.conn-modal-tabs .seg-tab').filter({ hasText: '스키마' }).click();
    await expect(win.getByTestId('schema-visibility-toggle-all')).toBeVisible({ timeout: 15_000 });
    await win.getByTestId('schema-visibility-toggle-all').check();
    await win.locator('.conn-modal .modal-head button[aria-label="닫기"]').click();

    const sourceDatabase = path.basename(sourceFile);
    const databaseRow = win.locator(`.tree-row:has(.tree-label:text-is("${sourceDatabase}"))`).first();
    await expect(databaseRow).toBeVisible({ timeout: 10_000 });
    await databaseRow.click({ button: 'right' });
    await win.locator('.ctx-menu .ctx-item').filter({ hasText: '다른 DB와 스키마 비교' }).click();

    const dialog = win.getByRole('dialog', { name: '스키마 비교' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.schema-compare-source')).toContainText(sourceDatabase);
    await expect(dialog.locator('#schema-compare-profile')).toContainText('E2E Schema Compare Target');
    await expect(dialog.locator('[aria-label="Target database"] option')).toHaveText([path.basename(targetFile)], { timeout: 10_000 });
    await dialog.locator('#schema-compare-profile').selectOption({ label: 'E2E Schema Compare Target' });
    await dialog.getByRole('combobox', { name: 'Target database' }).selectOption(path.basename(targetFile));
    await dialog.getByRole('button', { name: '비교' }).click();

    await expect(dialog.locator('[data-diff-kind="table-missing"]')).toContainText('products', { timeout: 15_000 });
    await expect(dialog.locator('[data-diff-kind="table-extra"]')).toContainText('legacy');
    await expect(dialog.locator('[data-diff-kind="column-missing"]')).toContainText('email');
    await expect(dialog.locator('[data-diff-kind="index-missing"]')).toContainText('idx_users_email');
    await expect(dialog.locator('[data-diff-kind="index-extra"]')).toContainText('idx_users_name');

    await dialog.getByRole('button', { name: 'SQL 초안 생성' }).click();
    const draft = dialog.getByRole('textbox', { name: 'Migration SQL draft' });
    await expect(draft).toHaveValue(/CREATE TABLE products/);
    await expect(draft).toHaveValue(/ALTER TABLE "users" ADD COLUMN "email" TEXT DEFAULT 'n\/a'/);
    await expect(draft).toHaveValue(/CREATE UNIQUE INDEX "idx_users_email"/);
    await expect(dialog.locator('.schema-compare-manual')).toContainText('legacy');

    // Draft generation is read-only: the target is not migrated automatically.
    const targetColumns = execFileSync('sqlite3', [targetFile, 'PRAGMA table_info(users);'], { encoding: 'utf8' });
    expect(targetColumns).not.toContain('email');
    expect(execFileSync('sqlite3', [targetFile, "SELECT name FROM sqlite_master WHERE type='table' AND name='legacy';"], { encoding: 'utf8' }).trim()).toBe('legacy');
  });
});
