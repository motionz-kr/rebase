import { describe, it, expect } from 'vitest';
import { visibleTables, hiddenCount, withHidden, hiddenFor } from './tableVisibility';

const all = ['users', 'orders', 'logs'];

describe('tableVisibility', () => {
  it('visibleTables drops hidden ones, keeps order', () => {
    expect(visibleTables(all, ['logs'])).toEqual(['users', 'orders']);
  });
  it('empty hidden → all visible', () => {
    expect(visibleTables(all, [])).toEqual(all);
  });
  it('hiddenCount counts only hidden that still exist', () => {
    expect(hiddenCount(all, ['logs', 'ghost'])).toBe(1);
  });
  it('hiddenFor returns the per-db list or empty', () => {
    const store = { p1: { db1: ['a'] } };
    expect(hiddenFor(store, 'p1', 'db1')).toEqual(['a']);
    expect(hiddenFor(store, 'p1', 'dbX')).toEqual([]);
    expect(hiddenFor(store, 'pX', 'db1')).toEqual([]);
  });
  it('withHidden sets the per-db hidden list immutably', () => {
    const store = { p1: { db1: ['a'] } };
    const next = withHidden(store, 'p1', 'db2', ['x']);
    expect(next).toEqual({ p1: { db1: ['a'], db2: ['x'] } });
    expect(store).toEqual({ p1: { db1: ['a'] } });
  });
});
