import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('recovers a saved credential reference cleared by an older profile editor', async ({ app, firstWindow: win }) => {
  const appArgs = app.process()?.spawnargs ?? [];
  const userDataArg = appArgs.find((arg) => arg.startsWith('--user-data-dir='));
  if (!userDataArg) throw new Error('Isolated Electron user-data directory was not provided');
  const metadataDbPath = path.join(userDataArg.slice('--user-data-dir='.length), 'metadata.db');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-credential-recovery-'));
  const databaseFile = path.join(fixtureDir, 'credential_recovery_e2e.db');
  const profileName = 'E2E Legacy Credential Recovery';
  let profileId = '';

  execFileSync('sqlite3', [databaseFile, 'CREATE TABLE credential_recovery_e2e (id INTEGER PRIMARY KEY);']);

  try {
    await win.getByRole('button', { name: '새 연결' }).click();
    const form = win.locator('.conn-form');
    await form.locator('select').first().selectOption('sqlite');
    await form.locator('label:text-is("Profile name") + input').fill(profileName);
    await form.locator('label:text-is("Database file")').locator('..').locator('input').fill(databaseFile);
    await form.locator('button[type="submit"]').click();

    const connection = win.locator('.conn-list .conn-row').filter({ hasText: profileName });
    await expect(connection).toBeVisible();
    profileId = execFileSync('sqlite3', [metadataDbPath, `SELECT id FROM connection_profiles WHERE name='${profileName}';`], {
      encoding: 'utf8',
    }).trim();
    expect(profileId).not.toBe('');

    // Recreate the empty secret_ref written by versions before 0.29.0. The
    // existing Keychain item remains in place for this isolated test profile.
    execFileSync('sqlite3', [metadataDbPath, `UPDATE connection_profiles SET secret_ref='' WHERE id='${profileId}';`]);

    await connection.click();
    await expect(win.locator('.conn-panel .editor-toolbar')).toBeVisible({ timeout: 20_000 });

    const repairedSecretRef = execFileSync('sqlite3', [metadataDbPath, `SELECT secret_ref FROM connection_profiles WHERE id='${profileId}';`], {
      encoding: 'utf8',
    }).trim();
    expect(repairedSecretRef).toBe(`secret-${profileId}`);
  } finally {
    if (profileId) {
      // Ensure DeleteProfile can remove the temporary Keychain item even when
      // an assertion above fails before the recovery assertion completes.
      execFileSync('sqlite3', [metadataDbPath, `UPDATE connection_profiles SET secret_ref='secret-${profileId}' WHERE id='${profileId}';`]);
      const deleted = await win.evaluate(async (id) => window.electronAPI.deleteProfile(id), profileId);
      if (!deleted.success) throw new Error(`Could not remove temporary credential test profile: ${deleted.error}`);
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
