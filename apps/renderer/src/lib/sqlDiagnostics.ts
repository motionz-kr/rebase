import { parseTableRefs, type SchemaInfo, type TableDef } from './sqlCompletion';

export type SqlDiagnosticSeverity = 'error' | 'warning';

export interface SqlDiagnostic {
  start: number;
  end: number;
  severity: SqlDiagnosticSeverity;
  message: string;
}

type ScanState = 'normal' | 'single' | 'double' | 'backtick' | 'bracket' | 'line-comment' | 'block-comment';

interface MaskedSql {
  text: string;
  unclosed?: { start: number; message: string };
}

const identifier = '[A-Za-z_][A-Za-z0-9_$]*';
const tableRefPattern = new RegExp('\\b(?:FROM|JOIN|UPDATE|INTO)\\s+((?:' + identifier + '\\.)*' + identifier + ')', 'gi');
const qualifiedColumnPattern = new RegExp('\\b(' + identifier + ')\\s*\\.\\s*(' + identifier + ')\\b', 'g');

function blank(chars: string[], index: number) {
  if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
}

// Keep offsets intact while hiding strings/comments from the lightweight
// context checks. The editor remains permissive for dialect-specific SQL.
function maskSql(sql: string): MaskedSql {
  const chars = sql.split('');
  let state: ScanState = 'normal';
  let start = -1;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === 'normal') {
      if (ch === "'") { state = 'single'; start = i; blank(chars, i); }
      else if (ch === '"') { state = 'double'; start = i; }
      else if (ch === '`') { state = 'backtick'; start = i; }
      else if (ch === '[') { state = 'bracket'; start = i; }
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
  if (state === 'block-comment') return { text: chars.join(''), unclosed: { start, message: '닫히지 않은 주석입니다.' } };
  return { text: chars.join('') };
}

function unquote(name: string): string {
  return name.replace(/^[`"\[]/, '').replace(/[`"\]]$/, '');
}

function tableName(name: string): string {
  return unquote(name.split('.').pop() ?? name);
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
    const ctePattern = /\bWITH\s+([A-Za-z_][A-Za-z0-9_$]*)\s+AS\s*\(/gi;
    let cte: RegExpExecArray | null;
    while ((cte = ctePattern.exec(masked.text)) !== null) knownCtes.add(cte[1].toLowerCase());

    let tableRef: RegExpExecArray | null;
    while ((tableRef = tableRefPattern.exec(masked.text)) !== null) {
      const name = tableName(tableRef[1]);
      if (knownCtes.has(name.toLowerCase()) || findTable(schema, name)) continue;
      const start = tableRef.index + tableRef[0].lastIndexOf(tableRef[1]);
      pushUnique(diagnostics, { start, end: start + tableRef[1].length, severity: 'error', message: `테이블을 찾을 수 없습니다: ${name}` });
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
