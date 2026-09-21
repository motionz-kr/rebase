export type PersistedTransactionMode = 'auto' | 'manual';

export interface PersistedQueryTab {
  id: string;
  name: string;
  database: string;
  query: string;
  writeMode: boolean;
  transactionMode: PersistedTransactionMode;
}

export interface PersistedQueryTabs {
  activeTabId: string;
  tabs: PersistedQueryTab[];
}

export interface QueryTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_PREFIX = 'rebase.query-tabs.v1';
const MAX_TABS = 50;
const MAX_QUERY_LENGTH = 1_000_000;
const MAX_LABEL_LENGTH = 200;

export function queryTabsStorageKey(profileId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(profileId)}`;
}

export function encodeQueryTabs(snapshot: PersistedQueryTabs): string {
  return JSON.stringify({ version: 1, ...snapshot });
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isPersistedTab(value: unknown): value is PersistedQueryTab {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Partial<PersistedQueryTab>;
  return isBoundedString(tab.id, 100)
    && isBoundedString(tab.name, MAX_LABEL_LENGTH)
    && isBoundedString(tab.database, MAX_LABEL_LENGTH)
    && isBoundedString(tab.query, MAX_QUERY_LENGTH)
    && typeof tab.writeMode === 'boolean'
    && (tab.transactionMode === 'auto' || tab.transactionMode === 'manual');
}

export function decodeQueryTabs(raw: string | null): PersistedQueryTabs | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { version?: unknown; activeTabId?: unknown; tabs?: unknown };
    if (value.version !== 1 || !isBoundedString(value.activeTabId, 100) || !Array.isArray(value.tabs)) return null;
    if (value.tabs.length === 0 || value.tabs.length > MAX_TABS || !value.tabs.every(isPersistedTab)) return null;
    const tabs = value.tabs as PersistedQueryTab[];
    const ids = new Set(tabs.map((tab) => tab.id));
    if (ids.size !== tabs.length || !ids.has(value.activeTabId)) return null;
    return { activeTabId: value.activeTabId, tabs };
  } catch {
    return null;
  }
}

export function readQueryTabs(storage: QueryTabStorage | undefined, profileId: string): PersistedQueryTabs | null {
  if (!storage || !profileId) return null;
  try {
    return decodeQueryTabs(storage.getItem(queryTabsStorageKey(profileId)));
  } catch {
    return null;
  }
}

export function writeQueryTabs(storage: QueryTabStorage | undefined, profileId: string, snapshot: PersistedQueryTabs): void {
  if (!storage || !profileId) return;
  try {
    storage.setItem(queryTabsStorageKey(profileId), encodeQueryTabs(snapshot));
  } catch {
    // Storage can be unavailable in private/restricted renderer contexts.
  }
}
