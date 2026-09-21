import { describe, expect, it } from 'vitest';
import {
  decodeQueryTabs,
  encodeQueryTabs,
  queryTabsStorageKey,
  type PersistedQueryTab,
} from './queryTabPersistence';

const tabs: PersistedQueryTab[] = [
  {
    id: 'tab-1',
    name: 'Users',
    database: 'app',
    query: 'SELECT * FROM users;',
    writeMode: true,
    transactionMode: 'manual',
  },
];

describe('query tab persistence', () => {
  it('round-trips durable tab state and active tab', () => {
    const encoded = encodeQueryTabs({ activeTabId: 'tab-1', tabs });

    expect(decodeQueryTabs(encoded)).toEqual({ activeTabId: 'tab-1', tabs });
  });

  it('rejects malformed or unsafe snapshots instead of restoring them', () => {
    expect(decodeQueryTabs('not-json')).toBeNull();
    expect(decodeQueryTabs(JSON.stringify({ activeTabId: 'tab-1', tabs: [] }))).toBeNull();
    expect(decodeQueryTabs(JSON.stringify({
      activeTabId: 'tab-1',
      tabs: [{ ...tabs[0], transactionMode: 'unknown' }],
    }))).toBeNull();
    expect(decodeQueryTabs(JSON.stringify({
      activeTabId: 'tab-1',
      tabs: [{ ...tabs[0], query: 'x'.repeat(1_000_001) }],
    }))).toBeNull();
  });

  it('uses a profile-scoped storage key', () => {
    expect(queryTabsStorageKey('profile-a')).not.toBe(queryTabsStorageKey('profile-b'));
    expect(queryTabsStorageKey('profile-a')).toContain('profile-a');
  });
});
