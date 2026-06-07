export interface DomainEntry {
  kind: 'table' | 'column';
  table: string;
  column: string; // '' for table entries
  meaning: string;
}

/** Lenient parse: invalid/empty/undefined → []. */
export function parseGlossary(json: string | undefined): DomainEntry[] {
  if (!json || !json.trim()) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as DomainEntry[]) : [];
  } catch {
    return [];
  }
}

/** Drop blank-meaning entries, then JSON-stringify. */
export function serializeGlossary(entries: DomainEntry[]): string {
  return JSON.stringify(entries.filter((e) => e.meaning.trim() !== ''));
}

const key = (e: { table: string; column: string }) => `${e.table} ${e.column}`;

/**
 * Merge live schema (tables + columns-per-table) with existing entries:
 * preserve existing meanings, add new schema rows with blank meaning, keep
 * orphaned (schema-removed) entries only if they still carry a meaning.
 */
export function mergeSchema(
  existing: DomainEntry[],
  tables: string[],
  columnsByTable: Record<string, string[]>,
): DomainEntry[] {
  const byKey = new Map(existing.map((e) => [key(e), e]));
  const out: DomainEntry[] = [];
  const seen = new Set<string>();

  for (const t of tables) {
    const tk = key({ table: t, column: '' });
    out.push({ kind: 'table', table: t, column: '', meaning: byKey.get(tk)?.meaning ?? '' });
    seen.add(tk);
    for (const c of columnsByTable[t] ?? []) {
      const ck = key({ table: t, column: c });
      out.push({ kind: 'column', table: t, column: c, meaning: byKey.get(ck)?.meaning ?? '' });
      seen.add(ck);
    }
  }
  for (const e of existing) {
    if (!seen.has(key(e)) && e.meaning.trim() !== '') out.push(e);
  }
  return out;
}
