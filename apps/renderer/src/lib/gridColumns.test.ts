import { describe, it, expect } from 'vitest';
import { reorderUnpinned, columnWidth, resizedColumnWidth } from './gridColumns';

describe('reorderUnpinned', () => {
  it('moves an item within the array', () => {
    expect(reorderUnpinned([0, 1, 2, 3], 3, 1)).toEqual([0, 3, 1, 2]);
  });
  it('moves forward', () => {
    expect(reorderUnpinned([0, 1, 2, 3], 0, 2)).toEqual([1, 2, 0, 3]);
  });
  it('no-op when from === to', () => {
    expect(reorderUnpinned([0, 1, 2], 1, 1)).toEqual([0, 1, 2]);
  });
});

describe('columnWidth', () => {
  it('uses the stored width by column name', () => {
    expect(columnWidth('userId', { userId: 240 }, 200)).toBe(240);
  });
  it('falls back to the default when missing or invalid', () => {
    expect(columnWidth('x', {}, 200)).toBe(200);
    expect(columnWidth('x', { x: 0 }, 200)).toBe(200);
    expect(columnWidth('x', { x: -5 }, 200)).toBe(200);
  });
});

describe('resizedColumnWidth', () => {
  it('applies the pointer delta to the width the user started from', () => {
    expect(resizedColumnWidth(312, 12)).toBe(324);
    expect(resizedColumnWidth(312, -12)).toBe(300);
  });

  it('keeps the column at or above the minimum width', () => {
    expect(resizedColumnWidth(70, -20)).toBe(60);
  });
});
