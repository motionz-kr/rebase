// Move the element at index `from` to index `to`, returning a new array.
// Used to reorder the unpinned result-grid columns by header drag.
export function reorderUnpinned(order: number[], from: number, to: number): number[] {
  if (from === to) return order.slice();
  const next = order.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// Width (px) for a column, looked up by name, falling back to a default when
// there's no stored override (or it's non-positive).
export function columnWidth(name: string, widths: Record<string, number>, fallback: number): number {
  const w = widths[name];
  return Number.isFinite(w) && w > 0 ? w : fallback;
}
