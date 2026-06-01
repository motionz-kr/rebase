import { describe, it, expect } from 'vitest';
import { sqlLiteral, buildUpdate, buildInsert, buildDelete } from './dmlBuilder';

describe('sqlLiteral', () => {
  it('renders null as NULL', () => {
    expect(sqlLiteral('mysql', null)).toBe('NULL');
  });
  it('renders numbers literally', () => {
    expect(sqlLiteral('mysql', 42)).toBe('42');
    expect(sqlLiteral('postgres', -3.5)).toBe('-3.5');
  });
  it('renders booleans per dialect', () => {
    expect(sqlLiteral('mysql', true)).toBe('1');
    expect(sqlLiteral('mysql', false)).toBe('0');
    expect(sqlLiteral('postgres', true)).toBe('TRUE');
    expect(sqlLiteral('postgres', false)).toBe('FALSE');
  });
  it('single-quotes strings and doubles embedded quotes', () => {
    expect(sqlLiteral('postgres', "a'b")).toBe("'a''b'");
  });
  it('escapes backslash for mysql but not postgres', () => {
    expect(sqlLiteral('mysql', 'a\\b')).toBe("'a\\\\b'");
    expect(sqlLiteral('postgres', 'a\\b')).toBe("'a\\b'");
  });
});

describe('buildUpdate', () => {
  it('builds an UPDATE with SET and PK WHERE (mysql)', () => {
    expect(
      buildUpdate('mysql', 'users', [{ col: 'id', value: 5 }], [{ col: 'name', value: 'Al' }, { col: 'age', value: null }])
    ).toBe("UPDATE `users` SET `name` = 'Al', `age` = NULL WHERE `id` = 5");
  });
  it('supports composite PK (postgres)', () => {
    expect(
      buildUpdate('postgres', 't', [{ col: 'a', value: 1 }, { col: 'b', value: 2 }], [{ col: 'v', value: 'x' }])
    ).toBe(`UPDATE "t" SET "v" = 'x' WHERE "a" = 1 AND "b" = 2`);
  });
});

describe('buildInsert', () => {
  it('builds an INSERT with only the provided columns', () => {
    expect(
      buildInsert('mysql', 'users', [{ col: 'name', value: 'Al' }, { col: 'active', value: true }])
    ).toBe("INSERT INTO `users` (`name`, `active`) VALUES ('Al', 1)");
  });
});

describe('buildDelete', () => {
  it('builds a DELETE by PK (postgres, composite)', () => {
    expect(
      buildDelete('postgres', 't', [{ col: 'a', value: 1 }, { col: 'b', value: "x'y" }])
    ).toBe(`DELETE FROM "t" WHERE "a" = 1 AND "b" = 'x''y'`);
  });
});
