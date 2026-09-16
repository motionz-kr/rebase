import { describe, it, expect } from 'vitest';
import {
  buildWhere,
  buildSelectPage,
  defaultFilterOperator,
  filterOperatorsForType,
  type FilterOperator,
} from './tableQuery';

describe('buildWhere', () => {
  it('returns empty string when no active filters', () => {
    expect(buildWhere('mysql', [])).toBe('');
    expect(buildWhere('mysql', [{ col: 'a', value: '   ' }])).toBe('');
  });
  it('builds a LIKE condition with backtick identifier (mysql)', () => {
    expect(buildWhere('mysql', [{ col: 'name', value: 'ab' }])).toBe(
      "WHERE `name` LIKE '%ab%' ESCAPE '!'"
    );
  });
  it('builds a LIKE condition with double-quote identifier (postgres)', () => {
    expect(buildWhere('postgres', [{ col: 'name', value: 'ab' }])).toBe(
      `WHERE "name" LIKE '%ab%' ESCAPE '!'`
    );
  });
  it('ANDs multiple active filters and skips blank ones', () => {
    expect(
      buildWhere('mysql', [{ col: 'a', value: 'x' }, { col: 'b', value: '' }, { col: 'c', value: 'y' }])
    ).toBe("WHERE `a` LIKE '%x%' ESCAPE '!' AND `c` LIKE '%y%' ESCAPE '!'");
  });
  it('escapes single quote and LIKE wildcards in the value with the ! escape char', () => {
    expect(buildWhere('mysql', [{ col: 'x', value: "a'b%c_d" }])).toBe(
      "WHERE `x` LIKE '%a''b!%c!_d%' ESCAPE '!'"
    );
  });
  it('escapes a literal ! in the value', () => {
    expect(buildWhere('mysql', [{ col: 'x', value: 'a!b' }])).toBe(
      "WHERE `x` LIKE '%a!!b%' ESCAPE '!'"
    );
  });

  it('builds equality and inequality operators with quoted values', () => {
    expect(buildWhere('postgres', [
      { col: 'name', operator: 'equals', value: "O'Neil" },
      { col: 'status', operator: 'not-equals', value: 'archived' },
    ])).toBe(`WHERE "name" = 'O''Neil' AND "status" <> 'archived'`);
  });

  it('builds starts-with and ends-with patterns with escaped wildcards', () => {
    expect(buildWhere('mysql', [
      { col: 'code', operator: 'starts-with', value: 'a_%' },
      { col: 'code', operator: 'ends-with', value: 'x!' },
    ])).toBe("WHERE `code` LIKE 'a!_!%%' ESCAPE '!' AND `code` LIKE '%x!!' ESCAPE '!'");
  });

  it('builds numeric/date comparisons and NULL checks without a value', () => {
    expect(buildWhere('sqlite', [
      { col: 'age', operator: 'greater-or-equal', value: '18' },
      { col: 'deleted_at', operator: 'is-null', value: '' },
      { col: 'created_at', operator: 'less-than', value: '2026-01-01' },
    ])).toBe(`WHERE "age" >= '18' AND "deleted_at" IS NULL AND "created_at" < '2026-01-01'`);
  });

  it('keeps NULL checks active even though they have no value', () => {
    expect(buildWhere('mysql', [{ col: 'active', operator: 'is-not-null', value: '' }])).toBe(
      'WHERE `active` IS NOT NULL'
    );
  });
});

describe('filterOperatorsForType', () => {
  it('offers text matching operators for text columns', () => {
    expect(filterOperatorsForType('varchar(255)')).toEqual([
      'contains', 'equals', 'not-equals', 'starts-with', 'ends-with', 'is-null', 'is-not-null',
    ] satisfies FilterOperator[]);
  });

  it('offers numeric and range operators for number and date columns', () => {
    expect(filterOperatorsForType('decimal(10,2)')).toContain('greater-than');
    expect(filterOperatorsForType('timestamp without time zone')).toContain('less-or-equal');
    expect(filterOperatorsForType('boolean')).not.toContain('contains');
  });

  it('defaults text columns to contains and scalar columns to equals', () => {
    expect(defaultFilterOperator('text')).toBe('contains');
    expect(defaultFilterOperator('integer')).toBe('equals');
  });
});

describe('buildSelectPage', () => {
  it('builds a basic page query', () => {
    expect(buildSelectPage('mysql', 'users', { limit: 50, offset: 0 })).toBe(
      'SELECT * FROM `users` LIMIT 50 OFFSET 0'
    );
  });
  it('adds ORDER BY when given', () => {
    expect(buildSelectPage('postgres', 'users', { orderBy: { col: 'id', dir: 'desc' }, limit: 50, offset: 100 })).toBe(
      'SELECT * FROM "users" ORDER BY "id" DESC LIMIT 50 OFFSET 100'
    );
  });
  it('combines WHERE and ORDER BY', () => {
    expect(
      buildSelectPage('mysql', 'users', { filters: [{ col: 'name', value: 'ab' }], orderBy: { col: 'name', dir: 'asc' }, limit: 10, offset: 0 })
    ).toBe("SELECT * FROM `users` WHERE `name` LIKE '%ab%' ESCAPE '!' ORDER BY `name` ASC LIMIT 10 OFFSET 0");
  });
  it('buildSelectPage sqlserver uses OFFSET/FETCH with an ORDER BY', () => {
    const sql = buildSelectPage('sqlserver', 't', { limit: 10, offset: 20 });
    expect(sql).toContain('OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY');
    expect(sql).toMatch(/ORDER BY/);
    expect(sql).not.toContain('LIMIT');
  });
});
