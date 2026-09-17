import { parseTableRefs, type SchemaInfo, type TableDef } from './sqlCompletion';

export type SqlDiagnosticSeverity = 'error' | 'warning';

export interface SqlDiagnostic {
  start: number;
  end: number;
  severity: SqlDiagnosticSeverity;
  message: string;
}

type ScanState = 'normal' | 'single' | 'double' | 'backtick' | 'bracket' | 'dollar-quote' | 'line-comment' | 'block-comment';

interface MaskedSql {
  text: string;
  unclosed?: { start: number; message: string };
}

const identifier = '[A-Za-z_][A-Za-z0-9_$]*';
const tableRefPattern = new RegExp('\\b(FROM|JOIN|UPDATE|INTO)\\s+(?:(?:LATERAL|ONLY|TABLE)\\s+)?((?:' + identifier + '\\.)*' + identifier + ')', 'gi');
const qualifiedColumnPattern = new RegExp('\\b(' + identifier + ')\\s*\\.\\s*(' + identifier + ')\\b', 'g');

// These objects are database-provided metadata, not tables that need to be
// present in the active schema completion snapshot. Keep this list explicit so
// a similarly named application table is still diagnosed normally.
const SYSTEM_CATALOG_SCHEMAS = new Set([
  'information_schema',
  'pg_catalog',
  'sys',
  'mysql',
  'performance_schema',
]);
const SYSTEM_CATALOG_TABLES = new Set([
  'all_objects',
  'all_tables',
  'all_tab_columns',
  'dba_objects',
  'dba_tables',
  'dba_tab_columns',
  'dual',
  'pg_database',
  'pg_tables',
  'pg_views',
  'pg_namespace',
  'pg_class',
  'pg_attribute',
  'pg_index',
  'pg_constraint',
  'pg_roles',
  'pg_settings',
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
  'user_objects',
  'user_tables',
  'user_tab_columns',
]);
const SQL_BUILTIN_IDENTIFIERS = new Set([
  'current_catalog',
  'current_date',
  'current_role',
  'current_schema',
  'current_time',
  'current_timestamp',
  'localtime',
  'localtimestamp',
  'session_user',
  'system_user',
  'user',
]);
const SQL_NON_TABLE_IDENTIFIERS = new Set([
  'all', 'and', 'as', 'by', 'case', 'cross', 'default', 'do', 'duplicate', 'else', 'end',
  'exists', 'false', 'full', 'group', 'having', 'inner', 'interval', 'is', 'join', 'key',
  'left', 'lateral', 'limit', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'outer',
  'over', 'partition', 'recursive', 'returning', 'right', 'select', 'set', 'table', 'then',
  'true', 'union', 'using', 'values', 'when', 'where', 'window', 'with',
]);
const SQL_TABLE_FUNCTION_IDENTIFIERS = new Set([
  'generate_series',
  'json_each',
  'json_table',
  'json_tree',
  'jsonb_array_elements',
  'jsonb_each',
  'jsonb_each_text',
  'jsonb_to_recordset',
  'openjson',
  'regexp_split_to_table',
  'string_split',
  'unnest',
  'xmltable',
]);

function blank(chars: string[], index: number) {
  if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
}

// Keep offsets intact while hiding strings/comments from the lightweight
// context checks. The editor remains permissive for dialect-specific SQL.
function maskSql(sql: string): MaskedSql {
  const chars = sql.split('');
  let state: ScanState = 'normal';
  let start = -1;
  let dollarQuoteEnd: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === 'normal') {
      if (ch === "'") { state = 'single'; start = i; blank(chars, i); }
      else if (ch === '"') { state = 'double'; start = i; }
      else if (ch === '`') { state = 'backtick'; start = i; }
      else if (ch === '[') { state = 'bracket'; start = i; }
      else if (ch === '$') {
        const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
        if (delimiter) {
          state = 'dollar-quote';
          start = i;
          dollarQuoteEnd = delimiter;
          for (let offset = 0; offset < delimiter.length; offset++) blank(chars, i + offset);
          i += delimiter.length - 1;
        }
      }
      else if ((ch === '-' && next === '-') || ch === '#') {
        state = 'line-comment'; start = i; blank(chars, i); if (ch === '-') blank(chars, i + 1);
      } else if (ch === '/' && next === '*') {
        state = 'block-comment'; start = i; blank(chars, i); blank(chars, i + 1);
      }
      continue;
    }
    if (state === 'single') {
      blank(chars, i);
      if (ch === '\\' && i + 1 < sql.length) { blank(chars, i + 1); i++; }
      else if (ch === "'" && next === "'") { blank(chars, i + 1); i++; }
      else if (ch === "'") state = 'normal';
    } else if (state === 'double') {
      blank(chars, i);
      if (ch === '"' && next === '"') i++;
      else if (ch === '"') state = 'normal';
    } else if (state === 'backtick') {
      blank(chars, i);
      if (ch === '`' && next === '`') i++;
      else if (ch === '`') state = 'normal';
    } else if (state === 'bracket') {
      blank(chars, i);
      if (ch === ']' && next === ']') i++;
      else if (ch === ']') state = 'normal';
    } else if (state === 'dollar-quote') {
      if (dollarQuoteEnd && sql.startsWith(dollarQuoteEnd, i)) {
        for (let offset = 0; offset < dollarQuoteEnd.length; offset++) blank(chars, i + offset);
        i += dollarQuoteEnd.length - 1;
        dollarQuoteEnd = null;
        state = 'normal';
      } else {
        blank(chars, i);
      }
    } else if (state === 'line-comment') {
      blank(chars, i);
      if (ch === '\n' || ch === '\r') state = 'normal';
    } else if (state === 'block-comment') {
      blank(chars, i);
      if (ch === '*' && next === '/') { blank(chars, i + 1); i++; state = 'normal'; }
    }
  }
  if (state === 'single') return { text: chars.join(''), unclosed: { start, message: '닫히지 않은 문자열입니다.' } };
  if (state === 'double') return { text: chars.join(''), unclosed: { start, message: '닫히지 않은 quoted identifier입니다.' } };
  if (state === 'backtick') return { text: chars.join(''), unclosed: { start, message: '닫히지 않은 quoted identifier입니다.' } };
  if (state === 'bracket') return { text: chars.join(''), unclosed: { start, message: '닫히지 않은 식별자 괄호입니다.' } };
  if (state === 'dollar-quote') return { text: chars.join(''), unclosed: { start, message: '닫히지 않은 dollar-quoted 문자열입니다.' } };
  if (state === 'block-comment') return { text: chars.join(''), unclosed: { start, message: '닫히지 않은 주석입니다.' } };
  return { text: chars.join('') };
}

function unquote(name: string): string {
  return name.replace(/^[`"\x5b]/, '').replace(/[`"\]]$/, '');
}

function tableName(name: string): string {
  return unquote(name.split('.').pop() ?? name);
}

function isSystemCatalogReference(name: string): boolean {
  const parts = name.split('.').map(unquote).filter(Boolean);
  const object = parts.at(-1)?.toLowerCase();
  const namespace = parts.length > 1 ? parts.at(-2)?.toLowerCase() : undefined;
  return (namespace !== undefined && SYSTEM_CATALOG_SCHEMAS.has(namespace))
    || (object !== undefined && (SYSTEM_CATALOG_TABLES.has(object) || object.startsWith('sqlite_')));
}

function isSqlBuiltinReference(name: string): boolean {
  return SQL_BUILTIN_IDENTIFIERS.has(tableName(name).toLowerCase());
}

function statementPrefix(sql: string, index: number): string {
  return sql.slice(sql.lastIndexOf(';', index - 1) + 1, index);
}

function lastKeywordIndex(text: string, keyword: string): number {
  let last = -1;
  const pattern = new RegExp('\\b' + keyword + '\\b', 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) last = match.index;
  return last;
}

function isSelectInto(text: string, index: number): boolean {
  const prefix = statementPrefix(text, index);
  const selectIndex = lastKeywordIndex(prefix, 'SELECT');
  const insertIndex = Math.max(lastKeywordIndex(prefix, 'INSERT'), lastKeywordIndex(prefix, 'MERGE'));
  return selectIndex > insertIndex;
}

function isConflictUpdate(text: string, index: number): boolean {
  const prefix = statementPrefix(text, index);
  return /\bON\s+CONFLICT\b[\s\S]*\bDO\s*$/i.test(prefix)
    || /\bON\s+DUPLICATE\s+KEY\s*[\s\S]*$/i.test(prefix);
}

function isFunctionCall(text: string, end: number): boolean {
  return /^\s*\(/.test(text.slice(end));
}

function isNonTableReference(text: string, keyword: string, name: string, start: number, end: number): boolean {
  const normalized = name.toLowerCase();
  if (isSqlBuiltinReference(name) || SQL_NON_TABLE_IDENTIFIERS.has(normalized)) return true;
  if (SQL_TABLE_FUNCTION_IDENTIFIERS.has(normalized)) return true;
  if ((keyword === 'FROM' || keyword === 'JOIN') && isFunctionCall(text, end)) return true;
  if (keyword === 'UPDATE' && isConflictUpdate(text, start)) return true;
  if (keyword === 'INTO' && isSelectInto(text, start)) return true;
  if (keyword === 'INTO') {
    const prefix = statementPrefix(text, start);
    if (lastKeywordIndex(prefix, 'INSERT') < 0 && lastKeywordIndex(prefix, 'MERGE') < 0) return true;
  }
  return false;
}

function findTable(schema: SchemaInfo, name: string): TableDef | undefined {
  return schema.tables.find((table) => table.name.toLowerCase() === name.toLowerCase());
}

function pushUnique(out: SqlDiagnostic[], diagnostic: SqlDiagnostic) {
  if (!out.some((item) => item.start === diagnostic.start && item.end === diagnostic.end && item.message === diagnostic.message)) out.push(diagnostic);
}

export function getSqlDiagnostics(sql: string, schema: SchemaInfo): SqlDiagnostic[] {
  if (!sql.trim()) return [];
  const masked = maskSql(sql);
  const diagnostics: SqlDiagnostic[] = [];
  if (masked.unclosed) {
    pushUnique(diagnostics, { ...masked.unclosed, end: sql.length, severity: 'error' });
  }

  const stack: number[] = [];
  for (let i = 0; i < masked.text.length; i++) {
    if (masked.text[i] === '(') stack.push(i);
    else if (masked.text[i] === ')') {
      const opening = stack.pop();
      if (opening === undefined) pushUnique(diagnostics, { start: i, end: i + 1, severity: 'error', message: '짝이 맞지 않는 닫는 괄호입니다.' });
    }
  }
  for (const opening of stack) pushUnique(diagnostics, { start: opening, end: Math.min(opening + 1, sql.length), severity: 'error', message: '닫히지 않은 괄호입니다.' });

  // Do not report name-resolution warnings while introspection is still loading.
  if (schema.tables.length > 0) {
    const knownCtes = new Set<string>();
    const ctePattern = /(?:\bWITH\b|,)\s*(?:RECURSIVE\s+)?([A-Za-z_][A-Za-z0-9_$]*)(?:\s*\([^)]*\))?\s+AS\s*\(/gi;
    let cte: RegExpExecArray | null;
    while ((cte = ctePattern.exec(masked.text)) !== null) knownCtes.add(cte[1].toLowerCase());

    let tableRef: RegExpExecArray | null;
    while ((tableRef = tableRefPattern.exec(masked.text)) !== null) {
      const keyword = tableRef[1].toUpperCase();
      const name = tableName(tableRef[2]);
      const start = tableRef.index + tableRef[0].lastIndexOf(tableRef[2]);
      const end = start + tableRef[2].length;
      if (isSystemCatalogReference(tableRef[2]) || knownCtes.has(name.toLowerCase()) || findTable(schema, name) || isNonTableReference(masked.text, keyword, name, start, end)) continue;
      pushUnique(diagnostics, { start, end, severity: 'error', message: `테이블을 찾을 수 없습니다: ${name}` });
    }

    const refs = parseTableRefs(masked.text);
    let qualified: RegExpExecArray | null;
    while ((qualified = qualifiedColumnPattern.exec(masked.text)) !== null) {
      const qualifier = qualified[1];
      const column = qualified[2];
      const ref = refs.find((item) => item.alias?.toLowerCase() === qualifier.toLowerCase() || item.table.toLowerCase() === qualifier.toLowerCase());
      if (!ref) continue;
      const table = findTable(schema, ref.table);
      if (!table || table.columns.some((item) => item.name.toLowerCase() === column.toLowerCase())) continue;
      const columnStart = qualified.index + qualified[0].lastIndexOf(column);
      pushUnique(diagnostics, { start: qualified.index, end: columnStart + column.length, severity: 'error', message: `컬럼을 찾을 수 없습니다: ${qualifier}.${column}` });
    }
  }
  return diagnostics.sort((a, b) => a.start - b.start);
}
