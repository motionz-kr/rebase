import { test, expect } from './fixtures';
import { isPortOpen, REDIS } from './dbProbe';
import { connectRedis } from './helpers';
import { redisSet, redisGet, redisDel, redisExists } from './redisProbe';

// End-to-end Redis flow: connect → browse → inspect → edit value → delete →
// run a console command. The app's mutations are verified independently with a
// tiny RESP probe. All keys live under `rebase:e2e:` so the test is safe against
// real data on the same Redis instance.
const K1 = 'rebase:e2e:k1';
const K2 = 'rebase:e2e:k2';

const panel = '.conn-panel:not([style*="none"])';

test.describe('Redis browse / edit / console', () => {
  test.beforeAll(async () => {
    const open = await isPortOpen(REDIS.host, REDIS.port);
    test.skip(!open, `No Redis on ${REDIS.host}:${REDIS.port} — skipping Redis E2E`);
    await redisDel(K1, K2);
    await redisSet(K1, 'e2e-value-1');
  });

  test.afterAll(async () => {
    if (await isPortOpen(REDIS.host, REDIS.port)) {
      await redisDel(K1, K2);
    }
  });

  test('inspect, edit and delete a key, then SET via the console', async ({ firstWindow: win }) => {
    await connectRedis(win);

    // The keyspace explorer lives in the sidebar. Narrow the scan to our prefix,
    // then open the seeded key.
    await win.locator('.redis-search input').fill('rebase:e2e:*');
    await win.locator('.redis-search button').click();

    const keyRow = win.locator('.key-row').filter({ hasText: K1 });
    await expect(keyRow).toBeVisible({ timeout: 15_000 });
    await keyRow.click();

    // Inspector shows the type and current value.
    await expect(win.locator(`${panel} .inspector-key h2`)).toHaveText(K1);
    await expect(win.locator(`${panel} .badge.type`)).toHaveText('STRING');
    await expect(win.locator(`${panel} .value-raw`)).toContainText('e2e-value-1');

    // Edit the value and save.
    await win.locator(`${panel} .key-actions button`, { hasText: 'Edit value' }).click();
    await win.locator(`${panel} textarea.value-editor`).fill('edited-by-e2e');
    await win.locator(`${panel} .value-edit-actions button`, { hasText: 'Save' }).click();
    await expect(win.locator(`${panel} .value-raw`)).toContainText('edited-by-e2e');

    // Independently confirm the write reached Redis.
    expect(await redisGet(K1)).toBe('edited-by-e2e');

    // Delete with the two-step confirm gate.
    await win.locator(`${panel} .key-actions button`, { hasText: 'Delete' }).click();
    await win.locator(`${panel} .confirm-row button`, { hasText: 'Delete' }).click();
    await expect(win.locator(`${panel} .empty-state.full`)).toBeVisible({ timeout: 15_000 });
    expect(await redisExists(K1)).toBe(0);

    // Console: run a SET and verify it lands in Redis.
    await win.locator(`${panel} .redis-tab`, { hasText: 'Console' }).click();
    const input = win.locator(`${panel} .redis-console-input input`);
    await input.fill(`SET ${K2} consoleval`);
    await input.press('Enter');
    await expect(win.locator(`${panel} .redis-console-out`).last()).toHaveText('OK', { timeout: 15_000 });
    expect(await redisGet(K2)).toBe('consoleval');
  });
});
