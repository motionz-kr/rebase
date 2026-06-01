import { describe, test, expect } from 'vitest';
import { formatSql, dialectFor } from './formatSql';

describe('dialectFor', () => {
  test('maps drivers to sql-formatter dialects', () => {
    expect(dialectFor('mysql')).toBe('mysql');
    expect(dialectFor('postgres')).toBe('postgresql');
  });

  test('falls back to standard sql for unknown drivers', () => {
    expect(dialectFor('redis')).toBe('sql');
    expect(dialectFor('whatever')).toBe('sql');
  });
});

describe('formatSql', () => {
  test('returns empty string for empty or whitespace input', () => {
    expect(formatSql('', 'mysql')).toBe('');
    expect(formatSql('   \n  ', 'mysql')).toBe('');
  });

  test('formats a messy query: uppercases keywords and breaks into lines', () => {
    const out = formatSql('select id,name from users where id=1', 'mysql');
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
    expect(out).toContain('\n'); // multi-line
    expect(out).not.toBe('select id,name from users where id=1'); // actually changed
  });

  test('is idempotent: formatting already-formatted SQL is stable', () => {
    const once = formatSql('select 1', 'mysql');
    expect(formatSql(once, 'mysql')).toBe(once);
  });

  test('returns the original text unchanged when SQL cannot be parsed', () => {
    const bad = "SELECT 'unterminated";
    expect(formatSql(bad, 'mysql')).toBe(bad);
  });

  test('never throws on malformed input', () => {
    expect(() => formatSql('((((', 'postgres')).not.toThrow();
    expect(() => formatSql('SELECT @@@', 'mysql')).not.toThrow();
  });
});
