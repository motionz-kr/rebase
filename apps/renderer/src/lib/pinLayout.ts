// Column-pinning layout for the data grids. Pinned columns are moved to the
// front (after the row-index column) and stick to the left on horizontal scroll;
// the rest keep their original order. Pure geometry so it can be unit-tested.

export const IDX_W = 56; // row-index column width (matches .grid-idx)
export const PIN_W = 180; // fixed width given to a pinned column

export interface PinLayout {
  order: number[]; // display order of original column indices
  stickyLeft: Record<number, number>; // original col index → sticky left offset (px)
  active: boolean; // any column actually pinned
}

export function pinLayout(numCols: number, pinned: Set<number>): PinLayout {
  const pinnedInOrder: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i < numCols; i++) {
    if (pinned.has(i)) pinnedInOrder.push(i);
    else rest.push(i);
  }
  const stickyLeft: Record<number, number> = {};
  pinnedInOrder.forEach((col, k) => {
    stickyLeft[col] = IDX_W + PIN_W * k;
  });
  return { order: [...pinnedInOrder, ...rest], stickyLeft, active: pinnedInOrder.length > 0 };
}
