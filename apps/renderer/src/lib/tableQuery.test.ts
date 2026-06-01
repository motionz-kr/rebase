import { describe, it, expect } from 'vitest';
import { buildWhere, buildSelectPage } from './tableQuery';

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
});
