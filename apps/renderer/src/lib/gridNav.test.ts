import { describe, it, expect } from 'vitest';
import { nextCell } from './gridNav';

const C = (r: number, c: number) => ({ r, c });

describe('nextCell', () => {
  // maxRow=9 (10 rows), maxCol=3 (4 cols), pageRows=5
  const args = [9, 3, 5] as const;

  it('returns null for non-navigation keys', () => {
    expect(nextCell(C(2, 2), 'a', false, ...args)).toBeNull();
    expect(nextCell(C(2, 2), 'Enter', false, ...args)).toBeNull();
  });

  it('moves with arrow keys', () => {
    expect(nextCell(C(2, 2), 'ArrowUp', false, ...args)).toEqual(C(1, 2));
    expect(nextCell(C(2, 2), 'ArrowDown', false, ...args)).toEqual(C(3, 2));
    expect(nextCell(C(2, 2), 'ArrowLeft', false, ...args)).toEqual(C(2, 1));
    expect(nextCell(C(2, 2), 'ArrowRight', false, ...args)).toEqual(C(2, 3));
  });

  it('clamps at grid edges', () => {
    expect(nextCell(C(0, 0), 'ArrowUp', false, ...args)).toEqual(C(0, 0));
    expect(nextCell(C(0, 0), 'ArrowLeft', false, ...args)).toEqual(C(0, 0));
    expect(nextCell(C(9, 3), 'ArrowDown', false, ...args)).toEqual(C(9, 3));
    expect(nextCell(C(9, 3), 'ArrowRight', false, ...args)).toEqual(C(9, 3));
  });

  it('Home/End move within the row', () => {
    expect(nextCell(C(4, 2), 'Home', false, ...args)).toEqual(C(4, 0));
    expect(nextCell(C(4, 1), 'End', false, ...args)).toEqual(C(4, 3));
  });

  it('PageUp/PageDown jump by pageRows and clamp', () => {
    expect(nextCell(C(8, 1), 'PageUp', false, ...args)).toEqual(C(3, 1));
    expect(nextCell(C(2, 1), 'PageUp', false, ...args)).toEqual(C(0, 1));
    expect(nextCell(C(1, 1), 'PageDown', false, ...args)).toEqual(C(6, 1));
    expect(nextCell(C(7, 1), 'PageDown', false, ...args)).toEqual(C(9, 1));
  });

  it('Tab moves right and wraps to next row', () => {
    expect(nextCell(C(2, 1), 'Tab', false, ...args)).toEqual(C(2, 2));
    expect(nextCell(C(2, 3), 'Tab', false, ...args)).toEqual(C(3, 0)); // wrap
    expect(nextCell(C(9, 3), 'Tab', false, ...args)).toEqual(C(9, 3)); // last cell stays
  });

  it('Shift+Tab moves left and wraps to previous row', () => {
    expect(nextCell(C(2, 1), 'Tab', true, ...args)).toEqual(C(2, 0));
    expect(nextCell(C(2, 0), 'Tab', true, ...args)).toEqual(C(1, 3)); // wrap back
    expect(nextCell(C(0, 0), 'Tab', true, ...args)).toEqual(C(0, 0)); // first cell stays
  });
});
