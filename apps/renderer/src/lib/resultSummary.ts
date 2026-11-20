// Display-only helpers for multi-statement runs: what to show in the result
// chips, the run summary line and the status bar. This is NOT write policy; the
// engine remains the authority on what may run.

export interface SummarySource {
  statement: string;
  columns: string[];
  rows: unknown[][];
  rowsAffected: number | null;
  error: string | null;
  // The stream hit the row cap: the row count is a lower bound.
  truncated?: boolean;
}

export interface RunSummary {
  statements: number;
  changedRows: number;
  selectedRows: number;
  errors: number;
  hasWrite: boolean;
  hasQuery: boolean;
  // changedRows came from a truncated RETURNING stream, so it is a lower bound.
  changedLowerBound: boolean;
}

const num = (n: number) => n.toLocaleString('ko-KR');

// Remove leading whitespace and comments (keeping /*! ... */ and /*+ ... */ bodies,
// which are executable) so the first keyword can be read.
function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--') || s.startsWith('#')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
    } else if (s.startsWith('/*')) {
      if (s[2] === '!' || s[2] === '+') {
        // Executable comment / hint: read through the marker (and an optional version number).
        s = s.slice(3).replace(/^\d*/, '');
      } else {
        const end = s.indexOf('*/', 2);
        s = end === -1 ? '' : s.slice(end + 2);
      }
    } else {
      return s;
    }
  }
}

const MULTI_WORD_VERBS: Array<[RegExp, string]> = [
  [/^START\s+TRANSACTION\b/i, 'START TRANSACTION'],
  [/^BEGIN\s+(TRANSACTION|WORK)\b/i, 'BEGIN'],
];

export interface SqlToken {
  // word: bare keyword/identifier (upper-cased); ident: quoted identifier
  // ("x", `x`, [x]; text without the quotes); other: string literal / dollar body.
  kind: 'word' | 'ident' | 'other';
  text: string;
}

// Tokens at parenthesis depth 0. Comments are skipped; quoted identifiers,
// string literals, [bracketed] identifiers and Postgres dollar-quoted bodies are
// opaque, so `WITH [update] AS (SELECT 1) SELECT ...` and
// `WITH x AS (SELECT $$) SELECT $$) UPDATE t ...` are read correctly.
export function sqlTokens(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  const n = sql.length;
  let depth = 0;
  let i = 0;
  const push = (t: SqlToken) => { if (depth === 0) out.push(t); };
  while (i < n) {
    const c = sql[i];
    if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      let text = '';
      while (i < n) {
        if (sql[i] === '\\' && c === "'") { i += 2; continue; }
        if (sql[i] === close) {
          if (sql[i + 1] === close) { text += close; i += 2; continue; }
          break;
        }
        text += sql[i++];
      }
      i = Math.min(n, i + 1);
      push({ kind: c === "'" ? 'other' : 'ident', text });
    } else if (c === '$' && /^\$[A-Za-z_]*\$/.test(sql.slice(i, i + 64))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? n : end + tag.length;
      push({ kind: 'other', text: '' });
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(sql[j])) j++;
      push({ kind: 'word', text: sql.slice(i, j).toUpperCase() });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(sql[j])) j++;
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

function topLevelWords(sql: string): string[] {
  return sqlTokens(sql).filter((t) => t.kind === 'word').map((t) => t.text);
}

const CTE_BODY_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE']);

// Upper-cased leading verb of a statement ('' when blank). WITH ... returns the
// statement verb that follows the CTE list (the first top-level SELECT/INSERT/
// UPDATE/DELETE/MERGE after WITH), not the SELECTs inside the CTEs.
export function statementVerb(sql: string): string {
  const s = stripLeadingComments(sql);
  for (const [re, verb] of MULTI_WORD_VERBS) if (re.test(s)) return verb;
  if (s.startsWith('(')) return 'SELECT';
  const words = topLevelWords(s);
  if (words.length === 0) return '';
  if (words[0] === 'WITH') return words.slice(1).find((w) => CTE_BODY_VERBS.has(w)) ?? 'SELECT';
  return words[0];
}

const TX_CONTROL_VERBS = new Set(['START TRANSACTION', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT']);

export function isTransactionControl(sql: string): boolean {
  return TX_CONTROL_VERBS.has(statementVerb(sql));
}

const ROW_CHANGING_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE']);

// DML whose rowsAffected means "rows changed". DDL, SET, SAVEPOINT etc. are
// excluded: some drivers (SQLite changes()) repeat the previous statement's count.
export function isRowChanging(sql: string): boolean {
  return ROW_CHANGING_VERBS.has(statementVerb(sql));
}

export function summarizeResults(results: SummarySource[]): RunSummary {
  const summary: RunSummary = { statements: results.length, changedRows: 0, selectedRows: 0, errors: 0, hasWrite: false, hasQuery: false, changedLowerBound: false };
  for (const r of results) {
    if (r.error) {
      summary.errors += 1;
    } else if (isRowChanging(r.statement)) {
      // A write that also returns rows (RETURNING / OUTPUT) reports the streamed row count.
      summary.hasWrite = true;
      summary.changedRows += r.rowsAffected ?? (r.columns.length > 0 ? r.rows.length : 0);
      if (r.truncated) summary.changedLowerBound = true;
    } else if (r.columns.length > 0) {
      summary.hasQuery = true;
      summary.selectedRows += r.rows.length;
    }
  }
  return summary;
}

// "3개 문장 · 변경 116행 · 조회 1행"
export function formatRunSummary(s: RunSummary): string {
  const parts = [`${num(s.statements)}개 문장`];
  if (s.hasWrite) parts.push(`변경 ${num(s.changedRows)}행${s.changedLowerBound ? ' 이상' : ''}`);
  if (s.hasQuery) parts.push(`조회 ${num(s.selectedRows)}행`);
  if (s.errors > 0) parts.push(`실패 ${num(s.errors)}건`);
  return parts.join(' · ');
}

// Which result to show when a run finishes: the first failure, otherwise the last
// result that is not transaction control (START TRANSACTION/COMMIT carry no data).
export function pickDefaultResultIndex(results: SummarySource[]): number {
  if (results.length === 0) return 0;
  const firstError = results.findIndex((r) => r.error);
  if (firstError >= 0) return firstError;
  for (let i = results.length - 1; i >= 0; i -= 1) {
    if (!isTransactionControl(results[i].statement)) return i;
  }
  return results.length - 1;
}

// Chip text, e.g. "2 UPDATE · 116행 변경", "3 SELECT · 1행", "1 START TRANSACTION".
export function chipLabel(index: number, r: SummarySource): string {
  const head = `${index + 1}`;
  const verb = statementVerb(r.statement);
  if (!verb) return head;
  const label = `${head} ${verb}`;
  if (r.error) return `${label} · 실패`;
  if (isRowChanging(r.statement)) return `${label} · ${num(r.rowsAffected ?? (r.columns.length > 0 ? r.rows.length : 0))}행${r.truncated ? ' 이상' : ''} 변경`;
  if (r.columns.length > 0) return `${label} · ${num(r.rows.length)}행`;
  return isTransactionControl(r.statement) ? label : `${label} · 완료`;
}

// Status-bar count text. Queried rows and changed rows can both be present.
export function formatExecCount(info: { rowCount?: number | null; rowsAffected?: number | null; error?: string | null }): string {
  if (info.error != null) return '실패';
  const parts: string[] = [];
  if (info.rowCount != null) parts.push(`${num(info.rowCount)} rows`);
  if (info.rowsAffected != null) parts.push(`변경 ${num(info.rowsAffected)}행`);
  return parts.length > 0 ? parts.join(' · ') : '완료';
}

// MySQL/MariaDB report only rows whose value actually changed, so a matching
// UPDATE that sets the same value reports 0. Explain that instead of leaving 0 unexplained.
export function zeroAffectedHint(driver: string, sql: string, rowsAffected: number | null): string | null {
  if (driver !== 'mysql' || rowsAffected !== 0) return null;
  if (statementVerb(sql) !== 'UPDATE') return null;
  return '값이 실제로 바뀐 행만 셉니다(조건에 맞아도 같은 값이면 0으로 표시됩니다).';
}
