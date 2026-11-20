import { describe, it, expect } from 'vitest';
import { splitStatements, splitStatementRanges } from './splitStatements';

describe('splitStatements', () => {
  it('returns single statement unchanged (no semicolon)', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });
  it('splits two statements', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('ignores trailing semicolon and whitespace', () => {
    expect(splitStatements('SELECT 1;  ')).toEqual(['SELECT 1']);
  });
  it('drops empty statements between semicolons', () => {
    expect(splitStatements('SELECT 1;;SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('ignores semicolons inside single-quoted strings', () => {
    expect(splitStatements("SELECT ';' AS x; SELECT 2")).toEqual(["SELECT ';' AS x", 'SELECT 2']);
  });
  it('handles doubled-quote escape inside string', () => {
    expect(splitStatements("SELECT 'a''b;c'; SELECT 2")).toEqual(["SELECT 'a''b;c'", 'SELECT 2']);
  });
  it('handles backslash escape inside string', () => {
    expect(splitStatements("SELECT 'a\\';b'; SELECT 2")).toEqual(["SELECT 'a\\';b'", 'SELECT 2']);
  });
  it('ignores semicolons inside double-quoted identifiers', () => {
    expect(splitStatements('SELECT "a;b" FROM t; SELECT 2')).toEqual(['SELECT "a;b" FROM t', 'SELECT 2']);
  });
  it('ignores semicolons inside backtick identifiers', () => {
    expect(splitStatements('SELECT `a;b` FROM t; SELECT 2')).toEqual(['SELECT `a;b` FROM t', 'SELECT 2']);
  });
  it('ignores semicolons inside line comments', () => {
    expect(splitStatements('SELECT 1 -- a;b\n; SELECT 2')).toEqual(['SELECT 1 -- a;b', 'SELECT 2']);
  });
  it('ignores semicolons inside hash line comments', () => {
    expect(splitStatements('SELECT 1 # a;b\n; SELECT 2')).toEqual(['SELECT 1 # a;b', 'SELECT 2']);
  });
  it('ignores semicolons inside block comments', () => {
    expect(splitStatements('SELECT 1 /* a;b */; SELECT 2')).toEqual(['SELECT 1 /* a;b */', 'SELECT 2']);
  });
  it('ignores semicolons inside dollar-quoted bodies', () => {
    expect(splitStatements('SELECT $$a;b$$; SELECT 2')).toEqual(['SELECT $$a;b$$', 'SELECT 2']);
  });
  it('ignores semicolons inside tagged dollar-quoted bodies', () => {
    expect(splitStatements('SELECT $tag$a;b$tag$; SELECT 2')).toEqual(['SELECT $tag$a;b$tag$', 'SELECT 2']);
  });
  it('returns empty array for blank / comment-only input', () => {
    expect(splitStatements('   ;  ')).toEqual([]);
    expect(splitStatements('')).toEqual([]);
  });
});

describe('splitStatementRanges', () => {
  it('returns trimmed source offsets for each statement', () => {
    const sql = '  SELECT 1;\n\n UPDATE users SET active = 1;';

    expect(splitStatementRanges(sql)).toEqual([
      { statement: 'SELECT 1', start: 2, end: 10 },
      { statement: 'UPDATE users SET active = 1', start: 14, end: 41 },
    ]);
  });

  it('keeps semicolons inside quoted text out of the ranges', () => {
    const sql = "SELECT ';' AS value; SELECT 2";

    expect(splitStatementRanges(sql)).toEqual([
      { statement: "SELECT ';' AS value", start: 0, end: 19 },
      { statement: 'SELECT 2', start: 21, end: 29 },
    ]);
  });
});

describe('comment-only segments', () => {
  it('drops a trailing comment-only segment (user history 16:58 case)', () => {
    const sql = '-- note\nSTART TRANSACTION;\nUPDATE t SET a = 1;\nSELECT ROW_COUNT();\n-- 116 expected\n-- COMMIT;\n-- ROLLBACK;';
    expect(splitStatements(sql)).toEqual([
      '-- note\nSTART TRANSACTION',
      'UPDATE t SET a = 1',
      'SELECT ROW_COUNT()',
    ]);
  });
  it('drops block-comment-only and line-comment-only segments between statements', () => {
    expect(splitStatements('SELECT 1; /* nothing */; # hash\n; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('keeps MySQL executable comments and optimizer hints', () => {
    expect(splitStatements('/*!40101 SET NAMES utf8 */; /*+ hint */; SELECT 1')).toEqual([
      '/*!40101 SET NAMES utf8 */',
      '/*+ hint */',
      'SELECT 1',
    ]);
  });
  it('keeps a statement whose comment is only a prefix', () => {
    expect(splitStatements('/* a */ SELECT 1')).toEqual(['/* a */ SELECT 1']);
  });
});
