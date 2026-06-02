import { describe, it, expect } from 'vitest';
import { splitStatements } from './splitStatements';

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
