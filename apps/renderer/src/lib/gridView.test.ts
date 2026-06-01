import { describe, it, expect } from 'vitest';
import { sortRows, filterRows } from './gridView';

describe('sortRows', () => {
  it('sorts numbers ascending and descending', () => {
    expect(sortRows([[3], [1], [2]], 0, 'asc')).toEqual([[1], [2], [3]]);
    expect(sortRows([[3], [1], [2]], 0, 'desc')).toEqual([[3], [2], [1]]);
  });
  it('sorts strings case-insensitively by locale', () => {
    expect(sortRows([['b'], ['A'], ['c']], 0, 'asc')).toEqual([['A'], ['b'], ['c']]);
  });
  it('places nulls last regardless of direction', () => {
    expect(sortRows([[2], [null], [1]], 0, 'asc')).toEqual([[1], [2], [null]]);
    expect(sortRows([[2], [null], [1]], 0, 'desc')).toEqual([[2], [1], [null]]);
  });
  it('is stable for equal keys', () => {
    const rows = [[1, 'a'], [1, 'b'], [1, 'c']];
    expect(sortRows(rows, 0, 'asc')).toEqual([[1, 'a'], [1, 'b'], [1, 'c']]);
  });
  it('does not mutate the input', () => {
    const rows = [[2], [1]];
    sortRows(rows, 0, 'asc');
    expect(rows).toEqual([[2], [1]]);
  });
});

describe('filterRows', () => {
  it('keeps rows where any cell contains the query (case-insensitive)', () => {
    expect(filterRows([['Apple'], ['banana'], ['cherry']], 'an')).toEqual([['banana']]);
  });
  it('returns all rows for an empty/whitespace query', () => {
    const rows = [['a'], ['b']];
    expect(filterRows(rows, '   ')).toEqual(rows);
  });
  it('ignores null cells and matches across columns', () => {
    expect(filterRows([[null, 'x'], [1, null]], 'x')).toEqual([[null, 'x']]);
  });
});
