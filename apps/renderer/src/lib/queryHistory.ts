export type QueryHistoryStatusFilter = 'all' | 'success' | 'failed';

export interface QueryHistoryFilter {
  name?: string | null;
  queryText: string;
  success: boolean;
}

export function filterQueryHistory<T extends QueryHistoryFilter>(
  entries: T[],
  search: string,
  status: QueryHistoryStatusFilter
): T[] {
  const needle = search.trim().toLowerCase();

  return entries.filter((entry) => {
    if (status === 'success' && !entry.success) return false;
    if (status === 'failed' && entry.success) return false;
    if (!needle) return true;

    const searchable = `${entry.name ?? ''}\n${entry.queryText}`.toLowerCase();
    return searchable.includes(needle);
  });
}
