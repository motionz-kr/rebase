// Per-connection, per-database set of tables the user has hidden from the tree.
export type HiddenStore = Record<string, Record<string, string[]>>;

const KEY = 'rebase.ui.hiddenTables';

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
export function visibleTables(all: string[], hidden: string[]): string[] {
  const h = new Set(hidden);
  return all.filter((t) => !h.has(t));
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
