import { describe, it, expect } from 'vitest';
import { analyzeEditableQuery } from './editableQuery';

describe('analyzeEditableQuery', () => {
  it('plain single-table SELECT * is editable', () => {
    expect(analyzeEditableQuery('SELECT * FROM users')).toEqual({ table: 'users', orderBy: null });
  });
  it('captures single-column ORDER BY DESC + LIMIT', () => {
    expect(analyzeEditableQuery('SELECT * FROM users ORDER BY id DESC LIMIT 500')).toEqual({
      table: 'users',
      orderBy: { col: 'id', dir: 'desc' },
    });
  });
  it('defaults ORDER BY direction to asc', () => {
    expect(analyzeEditableQuery('SELECT * FROM users ORDER BY name')).toEqual({
      table: 'users',
      orderBy: { col: 'name', dir: 'asc' },
    });
  });
  it('is case-insensitive and tolerates a trailing semicolon/whitespace', () => {
    expect(analyzeEditableQuery('  select *  from users limit 10 ; ')).toEqual({ table: 'users', orderBy: null });
  });
  it('strips backticks / double quotes and schema qualifier', () => {
    expect(analyzeEditableQuery('SELECT * FROM `devdb`.`users`')).toEqual({ table: 'users', orderBy: null });
    expect(analyzeEditableQuery('SELECT * FROM "public"."users"')).toEqual({ table: 'users', orderBy: null });
    expect(analyzeEditableQuery('SELECT * FROM devdb.users')).toEqual({ table: 'users', orderBy: null });
  });

  it('rejects column lists (not SELECT *)', () => {
    expect(analyzeEditableQuery('SELECT id, name FROM users')).toBeNull();
  });
  it('rejects WHERE', () => {
    expect(analyzeEditableQuery('SELECT * FROM users WHERE id = 5')).toBeNull();
  });
  it('rejects JOIN', () => {
    expect(analyzeEditableQuery('SELECT * FROM users JOIN orders ON users.id = orders.uid')).toBeNull();
  });
  it('rejects comma joins', () => {
    expect(analyzeEditableQuery('SELECT * FROM users, orders')).toBeNull();
  });
  it('rejects GROUP BY', () => {
    expect(analyzeEditableQuery('SELECT * FROM users GROUP BY country')).toBeNull();
  });
  it('rejects non-select', () => {
    expect(analyzeEditableQuery('UPDATE users SET name = 1')).toBeNull();
    expect(analyzeEditableQuery('EXPLAIN SELECT * FROM users')).toBeNull();
  });
});
