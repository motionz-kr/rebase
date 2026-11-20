import { isRowChanging, sqlTokens, type SqlToken } from './resultSummary';

// Per-tab tally of rows changed inside a still-open transaction, so Commit and
// Rollback (which report 0 affected themselves) can say how many rows they
// made permanent or cancelled. Display only.

export type TransactionControlKind = 'begin' | 'commit' | 'rollback';

export interface TransactionOutcome {
  kind: 'commit' | 'rollback';
  affected: number;
  // The tally came from a truncated RETURNING stream: at least this many rows.
  lowerBound?: boolean;
  // A COMMIT that the server turned into a rollback (aborted PostgreSQL transaction).
  aborted?: boolean;
}

const words = (tokens: SqlToken[]) => tokens.map((t) => (t.kind === 'word' ? t.text : ''));

// begin/commit/rollback of a whole transaction, read from comment-stripped tokens.
// `ROLLBACK [WORK|TRANSACTION] TO [SAVEPOINT] x` keeps the transaction open, so it
// is not classified.
export function transactionControlKind(sql: string): TransactionControlKind | null {
  const w = words(sqlTokens(sql));
  if ((w[0] === 'START' && w[1] === 'TRANSACTION') || w[0] === 'BEGIN') return 'begin';
  if (w[0] === 'COMMIT' || w[0] === 'END') return 'commit';
  if (w[0] === 'ROLLBACK' || w[0] === 'ABORT') {
    let i = 1;
    if (w[i] === 'WORK' || w[i] === 'TRANSACTION') i += 1;
    return w[i] === 'TO' ? null : 'rollback';
  }
  return null;
}

export interface SavepointMark {
  name: string;
  total: number;
}

export interface PendingTally {
  pending: number;
  savepoints: SavepointMark[];
  // pending includes a truncated RETURNING count: show "N행 이상".
  lowerBound?: boolean;
}

export const EMPTY_TALLY: PendingTally = { pending: 0, savepoints: [] };

export interface StatementOutcome {
  sql: string;
  hasColumns: boolean;
  // For a write that returns rows (RETURNING / OUTPUT) the engine reports the
  // streamed row count, which is also the number of rows it changed.
  rowsAffected: number | null;
  error: string | null;
  // The result stopped at the row cap.
  truncated?: boolean;
  // Session state the engine reported after this statement.
  transactionStateAfter: string;
}

export interface TallyOptions {
  // Renderer driver id ('mysql' | 'postgres' | 'sqlite' | 'sqlserver' | ...).
  // mysql (also MariaDB): START TRANSACTION / BEGIN / DDL implicitly commit, RELEASE
  // removes only the named savepoint, savepoint names are unique. Other drivers
  // follow PostgreSQL/SQLite savepoints: duplicate names stack and RELEASE also
  // destroys later savepoints.
  driver?: string;
  // Session state before the statement. Only on postgres is a COMMIT in a failed
  // (aborted) transaction a ROLLBACK; SQLite and MySQL really commit the earlier
  // successful changes.
  transactionStateBefore?: string;
}

// MySQL/InnoDB rolls the whole transaction back on a deadlock (error 1213). A lock
// wait timeout (1205) only rolls back the statement, so it is not matched.
export function isMysqlDeadlock(message: string | null | undefined): boolean {
  return !!message && /\bError 1213\b|Deadlock found when trying to get lock/i.test(message);
}

// Statements MySQL commits implicitly BEFORE executing them, so the pending work is
// already committed even when the statement itself then fails. Mirrors the engine's
// sqlsession.mysqlImplicitCommit plus START TRANSACTION / BEGIN.
export function impliesMysqlCommit(sql: string): boolean {
  const w = sqlTokens(sql).map((t) => (t.kind === 'word' ? t.text : ''));
  if ((w[0] === 'START' && w[1] === 'TRANSACTION') || w[0] === 'BEGIN') return true;
  if (['ALTER', 'DROP', 'RENAME', 'TRUNCATE', 'GRANT', 'REVOKE', 'ANALYZE', 'OPTIMIZE', 'REPAIR', 'FLUSH'].includes(w[0])) {
    return !(w[0] === 'DROP' && w[1] === 'TEMPORARY');
  }
  if (w[0] === 'CREATE') return w[1] !== 'TEMPORARY';
  return w[0] === 'LOCK' && w[1] === 'TABLES';
}

const savepointName = (t: SqlToken | undefined) => (t ? (t.kind === 'word' ? t.text.toLowerCase() : t.text) : '');

function savepointCommand(sql: string): { kind: 'set' | 'rollback-to' | 'release'; name: string } | null {
  const tokens = sqlTokens(sql);
  const w = words(tokens);
  if (w[0] === 'SAVEPOINT') return { kind: 'set', name: savepointName(tokens[1]) };
  if (w[0] === 'RELEASE') {
    const i = w[1] === 'SAVEPOINT' ? 2 : 1;
    return { kind: 'release', name: savepointName(tokens[i]) };
  }
  if (w[0] === 'ROLLBACK') {
    let i = 1;
    if (w[i] === 'WORK' || w[i] === 'TRANSACTION') i += 1;
    if (w[i] !== 'TO') return null;
    i += 1;
    if (w[i] === 'SAVEPOINT') i += 1;
    return { kind: 'rollback-to', name: savepointName(tokens[i]) };
  }
  return null;
}

const keep = (marks: SavepointMark[], upTo: number) => marks.slice(0, upTo);

// Fold one executed statement into the tally. Commit/Rollback produce an outcome
// carrying the rows the transaction had changed; ROLLBACK TO restores the
// tally taken at its SAVEPOINT; the engine's reported state decides whether a
// transaction is still open (it already reports 'idle' after MySQL DDL).
export function applyStatementToPending(
  tally: PendingTally,
  s: StatementOutcome,
  options: TallyOptions = {},
): { tally: PendingTally; outcome?: TransactionOutcome } {
  const mysql = options.driver === 'mysql';
  if (s.error) {
    // The server already committed (implicit commit) or rolled back (deadlock) the
    // pending work, even though this statement failed.
    if (mysql && (impliesMysqlCommit(s.sql) || isMysqlDeadlock(s.error))) return { tally: EMPTY_TALLY };
    return { tally };
  }
  const kind = transactionControlKind(s.sql);
  if (kind === 'commit' || kind === 'rollback') {
    const aborted = kind === 'commit' && options.driver === 'postgres' && options.transactionStateBefore === 'failed';
    const outcome: TransactionOutcome = { kind: aborted ? 'rollback' : kind, affected: tally.pending };
    if (tally.lowerBound) outcome.lowerBound = true;
    if (aborted) outcome.aborted = true;
    return { tally: EMPTY_TALLY, outcome };
  }

  const open = s.transactionStateAfter === 'active' || s.transactionStateAfter === 'failed';
  const sp = savepointCommand(s.sql);
  if (sp) {
    const marks = tally.savepoints;
    if (sp.kind === 'set') {
      const kept = mysql ? marks.filter((m) => m.name !== sp.name) : marks;
      return { tally: { ...tally, savepoints: [...kept, { name: sp.name, total: tally.pending }] } };
    }
    // RELEASE of SQLite's outermost savepoint commits: the engine then reports idle.
    if (!open) return { tally: EMPTY_TALLY };
    let index = -1;
    for (let i = marks.length - 1; i >= 0; i -= 1) if (marks[i].name === sp.name) { index = i; break; }
    if (index < 0) return { tally };
    if (sp.kind === 'rollback-to') {
      // The named savepoint stays; the ones set after it are gone.
      return { tally: { ...tally, pending: marks[index].total, savepoints: keep(marks, index + 1) } };
    }
    const remaining = mysql ? marks.filter((_, i) => i !== index) : keep(marks, index);
    return { tally: { ...tally, savepoints: remaining } };
  }

  if (!open) return { tally: EMPTY_TALLY };
  if (kind === 'begin') return { tally: mysql ? EMPTY_TALLY : tally };
  // Only DML counts: DDL/SET may repeat a stale changes() value (SQLite).
  if (!isRowChanging(s.sql)) return { tally };
  const next: PendingTally = { ...tally, pending: tally.pending + Math.max(0, s.rowsAffected ?? 0) };
  if (s.truncated) next.lowerBound = true;
  return { tally: next };
}

const rows = (n: number, lowerBound?: boolean) => `${n.toLocaleString('ko-KR')}행${lowerBound ? ' 이상' : ''}`;

export const commitNotice = (affected: number, lowerBound?: boolean): string => `커밋 완료 · 이 트랜잭션에서 ${rows(affected, lowerBound)} 반영`;
export const rollbackNotice = (affected: number, lowerBound?: boolean): string => `롤백 완료 · ${rows(affected, lowerBound)} 변경 취소`;
export const abortedCommitNotice = (affected: number, lowerBound?: boolean): string => `트랜잭션 오류 상태라 롤백됨 · ${rows(affected, lowerBound)} 변경 취소`;
export const pendingLabel = (affected: number, lowerBound?: boolean): string => `커밋 대기 변경 ${rows(affected, lowerBound)}`;

export function outcomeNotice(o: TransactionOutcome): string {
  if (o.aborted) return abortedCommitNotice(o.affected, o.lowerBound);
  return o.kind === 'commit' ? commitNotice(o.affected, o.lowerBound) : rollbackNotice(o.affected, o.lowerBound);
}
