// Pure keyboard-navigation logic for the data grids. Given the current active
// cell and a key, returns the next active cell (clamped to the grid), or null if
// the key is not a navigation key. Selection-extension (shift) and scroll-into-
// view are handled by the caller; this only computes coordinates.
export interface Cell {
  r: number;
  c: number;
}

const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));

export function nextCell(
  cur: Cell,
  key: string,
  shiftKey: boolean,
  maxRow: number,
  maxCol: number,
  pageRows: number
): Cell | null {
  switch (key) {
    case 'ArrowUp':
      return { r: clamp(cur.r - 1, maxRow), c: cur.c };
    case 'ArrowDown':
      return { r: clamp(cur.r + 1, maxRow), c: cur.c };
    case 'ArrowLeft':
      return { r: cur.r, c: clamp(cur.c - 1, maxCol) };
    case 'ArrowRight':
      return { r: cur.r, c: clamp(cur.c + 1, maxCol) };
    case 'Home':
      return { r: cur.r, c: 0 };
    case 'End':
      return { r: cur.r, c: maxCol };
    case 'PageUp':
      return { r: clamp(cur.r - pageRows, maxRow), c: cur.c };
    case 'PageDown':
      return { r: clamp(cur.r + pageRows, maxRow), c: cur.c };
    case 'Tab': {
      if (shiftKey) {
        if (cur.c > 0) return { r: cur.r, c: cur.c - 1 };
        if (cur.r > 0) return { r: cur.r - 1, c: maxCol }; // wrap to previous row end
        return { r: 0, c: 0 };
      }
      if (cur.c < maxCol) return { r: cur.r, c: cur.c + 1 };
      if (cur.r < maxRow) return { r: cur.r + 1, c: 0 }; // wrap to next row start
      return { r: maxRow, c: maxCol };
    }
    default:
      return null;
  }
}
