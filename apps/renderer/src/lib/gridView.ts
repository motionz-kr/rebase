// Pure client-side grid transforms. No DOM dependency.

export type SortDir = 'asc' | 'desc';

// Compare two cell values: numbers numerically, others by locale string. Nulls last.
function cmp(a: unknown, b: unknown): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

// Return a new array sorted by the given column and direction (stable).
export function sortRows(rows: unknown[][], colIndex: number, dir: SortDir): unknown[][] {
  return rows
    .map((r, i) => [r, i] as const)
    .sort(([a, ai], [b, bi]) => {
      const av = a[colIndex];
      const bv = b[colIndex];
      // Nulls always last, independent of direction
      const an = av === null || av === undefined;
      const bn = bv === null || bv === undefined;
      if (an && bn) return ai - bi;
      if (an) return 1;
      if (bn) return -1;
      const c = cmp(av, bv);
      if (c !== 0) return dir === 'asc' ? c : -c;
      return ai - bi;
    })
    .map(([r]) => r);
}

// Keep rows where any cell's string form contains the query (case-insensitive).
export function filterRows(rows: unknown[][], query: string): unknown[][] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    r.some((v) => {
      if (v === null || v === undefined) return false;
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return s.toLowerCase().includes(q);
    })
  );
}
