// Per-connection, per-database set of tables the user has hidden from the tree.
export type HiddenStore = Record<string, Record<string, string[]>>;

const KEY = 'rebase.ui.hiddenTables';
const HIDDEN_DATABASES_KEY = '__databases__';

export function loadHidden(): HiddenStore {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as HiddenStore) : {};
  } catch {
    return {};
  }
}
export function saveHidden(store: HiddenStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}
export function hiddenFor(store: HiddenStore, profileId: string, db: string): string[] {
  return store[profileId]?.[db] ?? [];
}
export function withHidden(store: HiddenStore, profileId: string, db: string, hidden: string[]): HiddenStore {
  return { ...store, [profileId]: { ...(store[profileId] ?? {}), [db]: hidden } };
}

// Database-level visibility uses a reserved per-profile entry so existing
// table visibility preferences remain backward-compatible in localStorage.
export function hiddenDatabasesFor(store: HiddenStore, profileId: string): string[] {
  return hiddenFor(store, profileId, HIDDEN_DATABASES_KEY);
}

export function hasDatabaseVisibilityPreference(store: HiddenStore, profileId: string): boolean {
  return Object.prototype.hasOwnProperty.call(store[profileId] ?? {}, HIDDEN_DATABASES_KEY);
}

export function withDatabaseHidden(store: HiddenStore, profileId: string, db: string, hidden: boolean): HiddenStore {
  const current = hiddenDatabasesFor(store, profileId);
  const next = hidden ? (current.includes(db) ? current : [...current, db]) : current.filter((name) => name !== db);
  return withHidden(store, profileId, HIDDEN_DATABASES_KEY, next);
}

export function withDatabasesHidden(store: HiddenStore, profileId: string, databases: string[], hidden: boolean): HiddenStore {
  return withHidden(store, profileId, HIDDEN_DATABASES_KEY, hidden ? [...databases] : []);
}

// New connections opt into schemas explicitly. Existing table preferences are
// treated as an older, visible-by-default configuration and are preserved.
export function initializeDatabaseVisibility(store: HiddenStore, profileId: string, databases: string[]): HiddenStore {
  if (hasDatabaseVisibilityPreference(store, profileId)) return store;
  const hasLegacyPreferences = Object.keys(store[profileId] ?? {}).length > 0;
  return withDatabasesHidden(store, profileId, databases, !hasLegacyPreferences);
}

export function visibleTables(all: string[], hidden: string[]): string[] {
  const h = new Set(hidden);
  return all.filter((t) => !h.has(t));
}

export function visibleDatabases(all: string[], hidden: string[]): string[] {
  const h = new Set(hidden);
  return all.filter((db) => !h.has(db));
}
export function hiddenCount(all: string[], hidden: string[]): number {
  const h = new Set(hidden);
  return all.filter((t) => h.has(t)).length;
}

// Toggle one table's membership in a db's hidden list (immutably).
export function toggleHidden(hidden: string[], table: string): string[] {
  return hidden.includes(table) ? hidden.filter((t) => t !== table) : [...hidden, table];
}

// Tri-state for a database's parent checkbox: are all/none/some of its tables
// visible? Stale hidden entries (tables that no longer exist) are ignored.
export function dbVisibilityState(all: string[], hidden: string[]): 'all' | 'none' | 'some' {
  const hiddenExisting = hiddenCount(all, hidden);
  if (hiddenExisting === 0) return 'all';
  if (hiddenExisting === all.length) return 'none';
  return 'some';
}
