import { describe, expect, it } from 'vitest';
import {
  chipLabel,
  formatExecCount,
  formatRunSummary,
  isRowChanging,
  isTransactionControl,
  pickDefaultResultIndex,
  statementVerb,
  summarizeResults,
  zeroAffectedHint,
  type SummarySource,
} from './resultSummary';

const write = (statement: string, rowsAffected: number): SummarySource => ({ statement, columns: [], rows: [], rowsAffected, error: null });
const select = (statement: string, n: number): SummarySource => ({ statement, columns: ['a'], rows: Array.from({ length: n }, (_, i) => [i]), rowsAffected: n, error: null });
const failed = (statement: string): SummarySource => ({ statement, columns: [], rows: [], rowsAffected: null, error: 'boom' });

// The 2026-11-20 16:58 run: START TRANSACTION, UPDATE (116), SELECT ROW_COUNT().
const userRun = [
  write('-- note\nSTART TRANSACTION', 0),
  write('UPDATE t SET a = 1 WHERE b = 2', 116),
  select('SELECT ROW_COUNT() AS changed_rows', 1),
];

describe('statementVerb', () => {
  it('skips comments and returns the upper-cased verb', () => {
    expect(statementVerb('-- c\n  /* x */ update t set a=1')).toBe('UPDATE');
    expect(statementVerb('SELECT 1')).toBe('SELECT');
  });
  it('joins multi-word transaction verbs', () => {
    expect(statementVerb('-- note\nSTART TRANSACTION')).toBe('START TRANSACTION');
    expect(statementVerb('begin')).toBe('BEGIN');
    expect(statementVerb('/*! SET x=1 */')).toBe('SET');
  });
  it('treats WITH ... UPDATE as the data-changing verb', () => {
    expect(statementVerb('WITH x AS (SELECT 1) UPDATE t SET a = 1')).toBe('UPDATE');
    expect(statementVerb('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('SELECT');
  });
  it('finds the verb after the CTE list, skipping comments, strings and nested parentheses', () => {
    expect(statementVerb('WITH ids AS (SELECT 1) /* note */ UPDATE t SET a = 1')).toBe('UPDATE');
    expect(statementVerb("WITH ids AS (SELECT 'a)(' FROM x), y AS (SELECT (1)) -- c\n DELETE FROM t")).toBe('DELETE');
    expect(statementVerb('WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT n+1 FROM r) INSERT INTO t SELECT * FROM r')).toBe('INSERT');
    expect(statementVerb('WITH a AS (UPDATE t SET x=1 RETURNING *) SELECT * FROM a')).toBe('SELECT');
    expect(statementVerb('(SELECT 1) UNION (SELECT 2)')).toBe('SELECT');
  });
  it('treats [bracketed] identifiers and $$ dollar-quoted bodies as opaque', () => {
    expect(statementVerb('WITH [update] AS (SELECT 1 AS n) SELECT * FROM [update]')).toBe('SELECT');
    expect(statementVerb('WITH x AS (SELECT $$) SELECT $$) UPDATE t SET v=1')).toBe('UPDATE');
    expect(statementVerb('WITH x AS (SELECT $tag$ ) $tag$) UPDATE t SET v=1')).toBe('UPDATE');
    expect(statementVerb('WITH "delete" AS (SELECT 1) SELECT * FROM "delete"')).toBe('SELECT');
    expect(statementVerb('WITH `update` AS (SELECT 1) SELECT 1')).toBe('SELECT');
    expect(statementVerb('SELECT $1')).toBe('SELECT');
  });
  it('returns empty string for blank input', () => {
    expect(statementVerb('  ')).toBe('');
  });
});

describe('isTransactionControl', () => {
  it.each(['START TRANSACTION', 'begin', 'BEGIN TRANSACTION', 'COMMIT', 'commit work', 'ROLLBACK', 'ROLLBACK TO SAVEPOINT a', 'SAVEPOINT a', 'RELEASE SAVEPOINT a', 'END', 'ABORT'])('%s', (sql) => {
    expect(isTransactionControl(sql)).toBe(true);
  });
  it.each(['SELECT 1', 'UPDATE t SET a = 1', 'SET autocommit = 0'])('not: %s', (sql) => {
    expect(isTransactionControl(sql)).toBe(false);
  });
});

describe('summarizeResults', () => {
  it('sums changed rows from write statements and selected rows from queries', () => {
    expect(summarizeResults(userRun)).toEqual({ statements: 3, changedRows: 116, selectedRows: 1, errors: 0, hasWrite: true, hasQuery: true, changedLowerBound: false });
  });
  it('ignores rowsAffected of transaction control and counts errors', () => {
    expect(summarizeResults([write('COMMIT', 5), failed('UPDATE x')])).toEqual({ statements: 2, changedRows: 0, selectedRows: 0, errors: 1, hasWrite: false, hasQuery: false, changedLowerBound: false });
  });
});

describe('formatRunSummary', () => {
  it('shows statement count, changed and selected rows', () => {
    expect(formatRunSummary(summarizeResults(userRun))).toBe('3개 문장 · 변경 116행 · 조회 1행');
  });
  it('omits parts that did not occur and shows failures', () => {
    expect(formatRunSummary(summarizeResults([write('UPDATE t SET a=1', 2), write('DELETE FROM t', 3)]))).toBe('2개 문장 · 변경 5행');
    expect(formatRunSummary(summarizeResults([select('SELECT 1', 1), failed('X')]))).toBe('2개 문장 · 조회 1행 · 실패 1건');
  });
});

describe('pickDefaultResultIndex', () => {
  it('prefers the first error', () => {
    expect(pickDefaultResultIndex([write('UPDATE a', 1), failed('UPDATE b'), select('SELECT 1', 1)])).toBe(1);
  });
  it('otherwise picks the last result that is not transaction control', () => {
    expect(pickDefaultResultIndex(userRun)).toBe(2);
    expect(pickDefaultResultIndex([write('UPDATE t SET a=1', 3), write('COMMIT', 0)])).toBe(0);
  });
  it('falls back to the last result when everything is transaction control, and 0 for none', () => {
    expect(pickDefaultResultIndex([write('START TRANSACTION', 0), write('COMMIT', 0)])).toBe(1);
    expect(pickDefaultResultIndex([])).toBe(0);
  });
});

describe('chipLabel', () => {
  it('labels with number, verb and outcome', () => {
    expect(chipLabel(0, userRun[0])).toBe('1 START TRANSACTION');
    expect(chipLabel(1, userRun[1])).toBe('2 UPDATE · 116행 변경');
    expect(chipLabel(2, userRun[2])).toBe('3 SELECT · 1행');
    expect(chipLabel(3, failed('DELETE FROM t'))).toBe('4 DELETE · 실패');
  });
  it('falls back to the number alone when there is no verb', () => {
    expect(chipLabel(0, write('', 0))).toBe('1');
  });
});

describe('formatExecCount', () => {
  it('shows both queried and changed rows', () => {
    expect(formatExecCount({ rowCount: 1, rowsAffected: 116 })).toBe('1 rows · 변경 116행');
    expect(formatExecCount({ rowCount: 5, rowsAffected: null })).toBe('5 rows');
    expect(formatExecCount({ rowCount: null, rowsAffected: 3 })).toBe('변경 3행');
    expect(formatExecCount({ rowCount: null, rowsAffected: 0 })).toBe('변경 0행');
    expect(formatExecCount({})).toBe('완료');
    expect(formatExecCount({ error: 'x' })).toBe('실패');
  });
});

describe('zeroAffectedHint', () => {
  it('explains that MySQL only counts rows whose value actually changed', () => {
    expect(zeroAffectedHint('mysql', 'UPDATE t SET a = 1', 0)).toContain('값이 실제로 바뀐 행만');
  });
  it('is silent for other drivers, verbs and non-zero counts', () => {
    expect(zeroAffectedHint('postgres', 'UPDATE t SET a = 1', 0)).toBeNull();
    expect(zeroAffectedHint('mysql', 'DELETE FROM t', 0)).toBeNull();
    expect(zeroAffectedHint('mysql', 'UPDATE t SET a = 1', 3)).toBeNull();
    expect(zeroAffectedHint('mysql', 'UPDATE t SET a = 1', null)).toBeNull();
  });
});

describe('non-DML statements', () => {
  it('are not counted as changed rows (SQLite repeats the previous changes())', () => {
    expect(isRowChanging('INSERT INTO t VALUES (1)')).toBe(true);
    expect(isRowChanging('WITH x AS (SELECT 1) DELETE FROM t')).toBe(true);
    expect(isRowChanging('CREATE TABLE t (a int)')).toBe(false);
    expect(isRowChanging('RELEASE SAVEPOINT a')).toBe(false);
    expect(summarizeResults([write('CREATE TABLE t (a int)', 7)])).toMatchObject({ changedRows: 0, hasWrite: false });
    expect(chipLabel(0, write('CREATE TABLE t (a int)', 7))).toBe('1 CREATE · 완료');
  });
});

describe('writes that return rows', () => {
  const returning: SummarySource = { statement: 'UPDATE t SET a = 1 RETURNING id', columns: ['id'], rows: [[1], [2]], rowsAffected: 2, error: null };
  it('are counted as changed rows, not as a query', () => {
    expect(summarizeResults([returning])).toEqual({ statements: 1, changedRows: 2, selectedRows: 0, errors: 0, hasWrite: true, hasQuery: false, changedLowerBound: false });
    expect(chipLabel(0, returning)).toBe('1 UPDATE · 2행 변경');
  });
  it('falls back to the streamed row count when rowsAffected is missing', () => {
    expect(summarizeResults([{ ...returning, rowsAffected: null }]).changedRows).toBe(2);
  });
});

describe('truncated RETURNING writes', () => {
  const capped: SummarySource = { statement: 'UPDATE t SET a = 1 RETURNING id', columns: ['id'], rows: Array.from({ length: 1000 }, (_, i) => [i]), rowsAffected: 1000, error: null, truncated: true };
  it('are shown as a lower bound, not an exact count', () => {
    const summary = summarizeResults([capped]);
    expect(summary).toMatchObject({ changedRows: 1000, changedLowerBound: true });
    expect(formatRunSummary(summary)).toBe('1개 문장 · 변경 1,000행 이상');
    expect(chipLabel(0, capped)).toBe('1 UPDATE · 1,000행 이상 변경');
  });
});
