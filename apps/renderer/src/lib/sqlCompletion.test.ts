import { describe, test, expect } from 'vitest';
import {
  parseTableRefs,
  dotPrefix,
  currentClause,
  getSuggestions,
  currentWord,
  filterByPrefix,
  shouldShowAutocomplete,
  type SchemaInfo,
  type SqlSuggestion,
} from './sqlCompletion';

const schema: SchemaInfo = {
  tables: [
    { name: 'users', columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar' }, { name: 'email', type: 'varchar' }] },
    { name: 'orders', columns: [{ name: 'id', type: 'int' }, { name: 'user_id', type: 'int' }, { name: 'total', type: 'numeric' }] },
  ],
};

const labels = (sql: string) => getSuggestions(schema, sql).map((s) => s.label);

describe('currentWord', () => {
  test('returns the partial identifier being typed', () => {
    expect(currentWord('SELECT * FROM us')).toBe('us');
    expect(currentWord('SELECT id, na')).toBe('na');
  });
  test('is empty right after a space, dot, or symbol', () => {
    expect(currentWord('SELECT * FROM ')).toBe('');
    expect(currentWord('SELECT u.')).toBe('');
    expect(currentWord('SELECT *')).toBe('');
  });
  test('after a dot, returns the partial column word (the part to replace)', () => {
    expect(currentWord('SELECT u.id')).toBe('id');
  });
});

describe('filterByPrefix', () => {
  const sugg: SqlSuggestion[] = [
    { label: 'users', kind: 'table', insertText: 'users' },
    { label: 'orders', kind: 'table', insertText: 'orders' },
    { label: 'user_id', kind: 'column', insertText: 'user_id' },
  ];

  test('empty prefix returns everything unchanged', () => {
    expect(filterByPrefix(sugg, '')).toEqual(sugg);
  });
  test('filters to labels starting with the prefix', () => {
    expect(filterByPrefix(sugg, 'or').map((s) => s.label)).toEqual(['orders']);
  });
  test('is case-insensitive', () => {
    expect(filterByPrefix(sugg, 'US').map((s) => s.label).sort()).toEqual(['user_id', 'users']);
  });
  test('returns empty when nothing matches', () => {
    expect(filterByPrefix(sugg, 'zzz')).toEqual([]);
  });
});

describe('parseTableRefs', () => {
  test('single table', () => {
    expect(parseTableRefs('SELECT * FROM users')).toEqual([{ table: 'users', alias: undefined }]);
  });
  test('table with alias', () => {
    expect(parseTableRefs('SELECT * FROM users u')).toEqual([{ table: 'users', alias: 'u' }]);
  });
  test('table with AS alias', () => {
    expect(parseTableRefs('select * from users as u')).toEqual([{ table: 'users', alias: 'u' }]);
  });
  test('join with aliases', () => {
    expect(parseTableRefs('FROM orders o JOIN users u ON o.user_id = u.id')).toEqual([
      { table: 'orders', alias: 'o' },
      { table: 'users', alias: 'u' },
    ]);
  });
  test('does not treat a following keyword as an alias', () => {
    expect(parseTableRefs('SELECT * FROM users WHERE id = 1')).toEqual([{ table: 'users', alias: undefined }]);
  });
  test('strips schema qualifier', () => {
    expect(parseTableRefs('SELECT * FROM public.orders o')).toEqual([{ table: 'orders', alias: 'o' }]);
  });
});

describe('dotPrefix', () => {
  test('returns the identifier before a trailing dot', () => {
    expect(dotPrefix('SELECT u.')).toBe('u');
  });
  test('returns identifier when typing a partial column after a dot', () => {
    expect(dotPrefix('SELECT u.id, o.to')).toBe('o');
  });
  test('returns null when not in a dot context', () => {
    expect(dotPrefix('SELECT id')).toBeNull();
    expect(dotPrefix('SELECT * FROM ')).toBeNull();
  });
});

describe('currentClause', () => {
  test('detects clauses by the nearest preceding keyword', () => {
    expect(currentClause('SELECT ')).toBe('select');
    expect(currentClause('SELECT * FROM ')).toBe('from');
    expect(currentClause('SELECT * FROM t WHERE ')).toBe('where');
    expect(currentClause('SELECT * FROM a JOIN ')).toBe('join');
    expect(currentClause('SELECT * FROM a JOIN b ON ')).toBe('on');
  });
});

describe('getSuggestions', () => {
  test('suggests table names in a FROM clause', () => {
    const out = labels('SELECT * FROM ');
    expect(out).toContain('users');
    expect(out).toContain('orders');
  });

  test('suggests table names after JOIN', () => {
    expect(labels('SELECT * FROM orders o JOIN ')).toContain('users');
  });

  test('dot completion suggests only the resolved table columns (via alias)', () => {
    const out = labels('SELECT * FROM users u WHERE u.');
    expect(out).toEqual(expect.arrayContaining(['id', 'name', 'email']));
    expect(out).not.toContain('total'); // orders column must not appear
  });

  test('dot completion resolves a bare table name too', () => {
    const out = labels('SELECT * FROM orders WHERE orders.');
    expect(out).toEqual(expect.arrayContaining(['user_id', 'total']));
    expect(out).not.toContain('email');
  });

  test('WHERE clause suggests columns of in-scope tables', () => {
    const out = labels('SELECT * FROM orders o WHERE ');
    expect(out).toContain('user_id');
    expect(out).toContain('total');
  });

  test('suggests SQL keywords (e.g. SELECT) when starting a statement', () => {
    expect(labels('')).toContain('SELECT');
  });

  test('column suggestions carry their table and type as detail', () => {
    const sug = getSuggestions(schema, 'SELECT * FROM users u WHERE u.').find((s) => s.label === 'email');
    expect(sug?.kind).toBe('column');
    expect(sug?.detail).toContain('users');
    expect(sug?.detail).toContain('varchar');
  });

  test('uses only the statement containing the cursor', () => {
    const out = labels('SELECT * FROM users; SELECT ');
    expect(out).toContain('SELECT');
    expect(out).toContain('orders');
    expect(out).not.toContain('email');
    expect(out).not.toContain('total');
  });

  test('does not split at a semicolon inside a string literal', () => {
    const out = labels("SELECT '; SELECT * FROM users' AS marker; SELECT ");
    expect(out).toContain('users');
    expect(out).toContain('orders');
    expect(out).not.toContain('email');
  });

  test('does not split at a semicolon inside a PostgreSQL dollar-quoted string', () => {
    const out = labels('SELECT $body$; SELECT * FROM users$body$ AS marker, ');
    expect(out).toContain('SELECT');
    expect(out).not.toContain('email');
  });

  test('does not split at a semicolon inside a block comment', () => {
    const out = labels('SELECT * FROM users /* ; SELECT * FROM orders */ WHERE ');
    expect(out).toContain('email');
    expect(out).not.toContain('total');
  });

  test('ignores table references inside string literals', () => {
    const out = labels("SELECT 'FROM orders o' AS note FROM users WHERE ");
    expect(out).toContain('email');
    expect(out).not.toContain('total');
  });

  test('ignores table references inside SQL comments', () => {
    const out = labels('SELECT * FROM users -- JOIN orders o\nWHERE ');
    expect(out).toContain('email');
    expect(out).not.toContain('total');
  });

  test('does not open autocomplete inside a string or comment', () => {
    expect(shouldShowAutocomplete("SELECT 'ord")).toBe(false);
    expect(shouldShowAutocomplete('SELECT $body$ord')).toBe(false);
    expect(shouldShowAutocomplete('SELECT * FROM users -- ord')).toBe(false);
    expect(shouldShowAutocomplete('SELECT * FROM users /* ord')).toBe(false);
  });
});

describe('shouldShowAutocomplete', () => {
  test('does not open after whitespace or statement terminators', () => {
    expect(shouldShowAutocomplete('SELECT * FROM ')).toBe(false);
    expect(shouldShowAutocomplete('SELECT * FROM users;')).toBe(false);
  });

  test('opens while typing a token or after dot completion', () => {
    expect(shouldShowAutocomplete('SELECT * FROM us')).toBe(true);
    expect(shouldShowAutocomplete('SELECT u.')).toBe(true);
    expect(shouldShowAutocomplete('SELECT u.na')).toBe(true);
  });
});
