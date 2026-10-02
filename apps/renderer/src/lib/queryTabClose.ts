export type QueryTabCloseScope = 'current' | 'others' | 'left' | 'right' | 'all';

interface TabIdentity { id: string }

export function canCloseQueryTabs(tabs: readonly (TabIdentity & { loading: boolean })[], targetId: string, scope: QueryTabCloseScope): boolean {
  const ids = new Set(getQueryTabCloseIds(tabs, targetId, scope));
  return ids.size > 0 && !tabs.some((tab) => ids.has(tab.id) && tab.loading);
}

export function getQueryTabCloseIds(tabs: readonly TabIdentity[], targetId: string, scope: QueryTabCloseScope): string[] {
  const index = tabs.findIndex((tab) => tab.id === targetId);
  if (index < 0) return [];
  switch (scope) {
    case 'current': return [targetId];
    case 'others': return tabs.filter((tab) => tab.id !== targetId).map((tab) => tab.id);
    case 'left': return tabs.slice(0, index).map((tab) => tab.id);
    case 'right': return tabs.slice(index + 1).map((tab) => tab.id);
    case 'all': return tabs.map((tab) => tab.id);
  }
}

export function getRemainingActiveTabId(tabs: readonly TabIdentity[], activeId: string, closedIds: readonly string[]): string | null {
  const closed = new Set(closedIds);
  const remaining = tabs.filter((tab) => !closed.has(tab.id));
  if (remaining.some((tab) => tab.id === activeId)) return activeId;
  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
  return tabs.slice(activeIndex + 1).find((tab) => !closed.has(tab.id))?.id
    ?? remaining.at(-1)?.id
    ?? null;
}
