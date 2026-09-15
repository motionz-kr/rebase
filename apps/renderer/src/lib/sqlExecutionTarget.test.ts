import { describe, expect, it } from 'vitest';
import { resolveSqlExecutionTarget } from './sqlExecutionTarget';

describe('resolveSqlExecutionTarget', () => {
  const sql = 'UPDATE a SET value = 1;\nUPDATE b SET value = 2;\nUPDATE c SET value = 3;';

  it('targets only the statement containing the caret and keeps its source offsets', () => {
    const start = sql.indexOf('UPDATE b');
    const end = sql.indexOf(';', start);

    expect(resolveSqlExecutionTarget(sql, { cursorOffset: start + 12 })).toEqual({
      sql: 'UPDATE b SET value = 2',
      ranges: [{ statement: 'UPDATE b SET value = 2', start, end }],
    });
  });

  it('uses the selected SQL instead of the caret statement', () => {
    const start = sql.indexOf('UPDATE b');
    const end = sql.indexOf(';', start) + 1;
    const selected = sql.slice(start, end);

    expect(resolveSqlExecutionTarget(sql, { cursorOffset: 0, selectionStart: start, selectionEnd: end })).toEqual({
      sql: selected,
      ranges: [{ statement: 'UPDATE b SET value = 2', start, end: end - 1 }],
    });
  });

  it('maps each selected statement back to its original editor offsets', () => {
    const start = sql.indexOf('UPDATE b');
    const end = sql.length;
    const thirdStart = sql.indexOf('UPDATE c');
    const selected = sql.slice(start, end);

    expect(resolveSqlExecutionTarget(sql, { cursorOffset: 0, selectionStart: start, selectionEnd: end })?.ranges).toEqual([
      { statement: 'UPDATE b SET value = 2', start, end: sql.indexOf(';', start) },
      { statement: 'UPDATE c SET value = 3', start: thirdStart, end: sql.indexOf(';', thirdStart) },
    ]);
    expect(resolveSqlExecutionTarget(sql, { cursorOffset: 0, selectionStart: start, selectionEnd: end })?.sql).toBe(selected);
  });

  it('does not fall back to the whole script when the caret is between statements', () => {
    const gap = sql.indexOf(';') + 1;

    expect(resolveSqlExecutionTarget(sql, { cursorOffset: gap })).toBeNull();
  });

  it('targets the preceding statement when the caret is at its end', () => {
    const end = sql.indexOf(';');

    expect(resolveSqlExecutionTarget(sql, { cursorOffset: end })).toEqual({
      sql: 'UPDATE a SET value = 1',
      ranges: [{ statement: 'UPDATE a SET value = 1', start: 0, end }],
    });
  });

  it('returns null for empty input and treats a zero-width selection as a caret', () => {
    expect(resolveSqlExecutionTarget('   ;  ', { cursorOffset: 2 })).toBeNull();
    expect(resolveSqlExecutionTarget(sql, { cursorOffset: 0, selectionStart: 2, selectionEnd: 2 })).toEqual({
      sql: 'UPDATE a SET value = 1',
      ranges: [{ statement: 'UPDATE a SET value = 1', start: 0, end: sql.indexOf(';') }],
    });
  });
});
