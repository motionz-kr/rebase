import { describe, it, expect } from 'vitest';
import { pinLayout, IDX_W, PIN_W } from './pinLayout';

describe('pinLayout', () => {
  it('no pins: natural order, inactive', () => {
    expect(pinLayout(4, new Set())).toEqual({ order: [0, 1, 2, 3], stickyLeft: {}, active: false });
  });

  it('one pinned column moves to the front and sticks after the index column', () => {
    expect(pinLayout(4, new Set([2]))).toEqual({
      order: [2, 0, 1, 3],
      stickyLeft: { 2: IDX_W },
      active: true,
    });
  });

  it('multiple pins keep original order among themselves and stack offsets', () => {
    expect(pinLayout(4, new Set([2, 0]))).toEqual({
      order: [0, 2, 1, 3],
      stickyLeft: { 0: IDX_W, 2: IDX_W + PIN_W },
      active: true,
    });
  });

  it('ignores out-of-range pinned indices', () => {
    expect(pinLayout(3, new Set([5]))).toEqual({ order: [0, 1, 2], stickyLeft: {}, active: false });
  });
});
