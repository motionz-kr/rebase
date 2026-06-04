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
