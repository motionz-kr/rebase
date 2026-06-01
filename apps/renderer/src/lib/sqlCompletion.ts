// Pure, context-aware SQL completion engine. No Monaco/DOM dependency so it can
// be unit-tested directly. The Monaco provider is a thin adapter over this.

export interface ColumnDef {
  name: string;
  type: string;
}
export interface TableDef {
  name: string;
  columns: ColumnDef[];
}
export interface SchemaInfo {
  tables: TableDef[];
}

export type SuggestionKind = 'keyword' | 'table' | 'column' | 'function';
export interface SqlSuggestion {
  label: string;
  kind: SuggestionKind;
  detail?: string;
  insertText: string;
}

export type Clause = 'select' | 'from' | 'where' | 'join' | 'on' | 'groupby' | 'orderby' | 'having' | 'other';

export interface TableRef {
  table: string;
  alias?: string;
}

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'ON', 'AND', 'OR',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE FROM', 'AS', 'DISTINCT', 'COUNT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', 'ASC', 'DESC',
];
const FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NOW', 'LOWER', 'UPPER', 'LENGTH'];

// Words that can immediately follow a table name but are NOT aliases.
const NON_ALIAS = new Set([
  'ON', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'GROUP', 'ORDER',
  'LIMIT', 'OFFSET', 'HAVING', 'UNION', 'SET', 'VALUES', 'USING', 'AND', 'OR', 'SELECT', 'AS',
]);

function unquote(s: string): string {
  return s.replace(/^[`"[]/, '').replace(/[`"\]]$/, '');
}

// Extract table references (with optional aliases) from FROM / JOIN / UPDATE / INTO clauses.
export function parseTableRefs(sql: string): TableRef[] {
  const refs: TableRef[] = [];
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([`"[]?[\w]+[`"\]]?(?:\.[`"[]?[\w]+[`"\]]?)?)(?:\s+(?:AS\s+)?([`"[]?[\w]+[`"\]]?))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    let table = unquote(m[1]);
    if (table.includes('.')) table = table.split('.').pop() as string;
    let alias = m[2] ? unquote(m[2]) : undefined;
    if (alias && NON_ALIAS.has(alias.toUpperCase())) alias = undefined;
    refs.push({ table, alias });
  }
  return refs;
}

// If the cursor sits right after `identifier.` (optionally with a partial word),
// return that identifier (a table name or alias).
export function dotPrefix(textBeforeCursor: string): string | null {
  const m = /([`"[]?\w+[`"\]]?)\.\s*\w*$/.exec(textBeforeCursor);
  return m ? unquote(m[1]) : null;
}

// Determine the clause the cursor is in, by the nearest preceding clause keyword.
export function currentClause(textBeforeCursor: string): Clause {
  const upper = textBeforeCursor.toUpperCase();
  const markers: [Clause, RegExp][] = [
    ['select', /\bSELECT\b/g],
    ['from', /\bFROM\b/g],
    ['where', /\bWHERE\b/g],
    ['join', /\bJOIN\b/g],
    ['on', /\bON\b/g],
    ['groupby', /\bGROUP\s+BY\b/g],
    ['orderby', /\bORDER\s+BY\b/g],
    ['having', /\bHAVING\b/g],
  ];
  let best: Clause = 'other';
  let bestIdx = -1;
  for (const [clause, re] of markers) {
    let last = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(upper)) !== null) last = m.index;
    if (last > bestIdx) {
      bestIdx = last;
      best = clause;
    }
  }
  return best;
}

function tableSuggestion(t: TableDef): SqlSuggestion {
  return { label: t.name, kind: 'table', detail: `${t.columns.length} columns`, insertText: t.name };
}
function columnSuggestion(table: string, c: ColumnDef): SqlSuggestion {
  return { label: c.name, kind: 'column', detail: `${table} · ${c.type}`, insertText: c.name };
}
function keywordSuggestions(): SqlSuggestion[] {
  return KEYWORDS.map((k) => ({ label: k, kind: 'keyword', insertText: k }));
}
function functionSuggestions(): SqlSuggestion[] {
  return FUNCTIONS.map((f) => ({ label: f, kind: 'function', insertText: `${f}()` }));
}

function findTable(schema: SchemaInfo, name: string): TableDef | undefined {
  return schema.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
}

// The partial identifier currently being typed at the cursor (the run of word
// characters ending at the cursor). This is both the prefix to filter by and
// the text a chosen suggestion should replace.
export function currentWord(textBeforeCursor: string): string {
  const m = /[A-Za-z0-9_]*$/.exec(textBeforeCursor);
  return m ? m[0] : '';
}

// Keep only suggestions whose label starts with the typed prefix (case-
// insensitive). An empty prefix keeps everything.
export function filterByPrefix(suggestions: SqlSuggestion[], prefix: string): SqlSuggestion[] {
  if (!prefix) return suggestions;
  const p = prefix.toLowerCase();
  return suggestions.filter((s) => s.label.toLowerCase().startsWith(p));
}

export function getSuggestions(schema: SchemaInfo, textBeforeCursor: string): SqlSuggestion[] {
  const refs = parseTableRefs(textBeforeCursor);

  // 1. Dot completion: `alias.` or `table.` → only that table's columns.
  const dot = dotPrefix(textBeforeCursor);
  if (dot) {
    const ref =
      refs.find((r) => r.alias?.toLowerCase() === dot.toLowerCase()) ||
      refs.find((r) => r.table.toLowerCase() === dot.toLowerCase());
    const tableName = ref ? ref.table : dot;
    const table = findTable(schema, tableName);
    return table ? table.columns.map((c) => columnSuggestion(table.name, c)) : [];
  }

  const clause = currentClause(textBeforeCursor);

  // 2. FROM / JOIN → table names.
  if (clause === 'from' || clause === 'join') {
    return schema.tables.map(tableSuggestion);
  }

  // 3. Columns of in-scope tables (resolved from FROM/JOIN refs).
  const columns: SqlSuggestion[] = [];
  for (const r of refs) {
    const t = findTable(schema, r.table);
    if (t) for (const c of t.columns) columns.push(columnSuggestion(t.name, c));
  }

  // SELECT with nothing referenced yet → offer keywords + tables to get started.
  if (refs.length === 0) {
    return [...keywordSuggestions(), ...schema.tables.map(tableSuggestion)];
  }

  // SELECT / WHERE / ON / GROUP BY / ORDER BY / HAVING with tables in scope.
  return [...columns, ...functionSuggestions(), ...keywordSuggestions()];
}
