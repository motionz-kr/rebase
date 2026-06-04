# UI Conveniences — design spec

Three independent quality-of-life improvements to the renderer, built as
separate units (easiest → hardest: A → B → C). All preferences persist to
`localStorage` using the existing AgentChat pattern (load on mount, save in an
effect, wrapped in try/catch).

(A fourth requested item — preserving original column-name case — shipped
separately as a bug fix in v0.5.3 and is out of scope here.)

## Unit A — Resizable sidebar width

The connections sidebar (`.sidebar`) is a fixed 290px. Make its width
user-adjustable by dragging a handle between the sidebar and the main content.

- Add a thin drag handle (`.app-resizer`) between `.sidebar` and `.main` in
  `App.tsx`. `mousedown` on it starts a drag; `mousemove` updates the width;
  `mouseup` ends it. While dragging, set `cursor: col-resize` and disable text
  selection.
- Sidebar width is React state applied via inline `style={{ width }}` (replacing
  the fixed CSS width). Clamp to **min 200px / max 600px**. **Double-click** the
  handle resets to the 290px default.
- Persist: `localStorage["rebase.ui.sidebarWidth"]` (a number).
- Pure helper `clampSidebarWidth(px)` (TDD) for the clamp logic.

## Unit B — Choose which tables are shown (checkbox hide)

In the schema explorer, all tables under an expanded database are always shown.
Let the user hide tables they don't care about.

- Add a **"테이블 표시…"** item to the database context menu (`SchemaExplorer`).
  It opens a dialog listing every table in that database as a **checkbox list**,
  with a **search box** and **select-all / clear-all**. Checked = visible.
- Unchecked tables are **hidden from the tree**. A trailing row shows
  **"숨긴 테이블 N개"**; clicking it reopens the dialog.
- Persist the hidden set: `localStorage["rebase.ui.hiddenTables"]` shaped as
  `{ [profileId]: { [database]: string[] } }`.
- Pure helpers (`tableVisibility.ts`, TDD): `loadHidden()`, `saveHidden()`,
  `visibleTables(all, hidden)`, `hiddenCount(all, hidden)`.
- New component `TableVisibilityDialog.tsx` (checkbox list + search + actions).

## Unit C — Resizable & reorderable result-grid columns

`ResultGrid` models columns as a plain `string[]` with a `pinned: Set<number>`
and a geometry-only `pinLayout()`. Add per-column **width** (drag a divider on
the header-cell border) and **order** (drag a header cell to a new position),
integrated with the existing pin/freeze.

- **Width**: a resizer handle on each header cell's right border; dragging
  updates that column's width. Stored **by column name** so the same column
  keeps its width across queries: `localStorage["rebase.ui.colWidths"]` =
  `{ [colName]: number }`.
- **Order**: drag a header cell onto another to reorder. Pinned columns stay
  left-anchored (reordering happens within the pinned group and within the
  unpinned group, not across the pin boundary). Order is **session-scoped** (per
  current result set), not persisted — query results vary, so a name-keyed
  global order would surprise users. (Width is safe to persist by name; order is
  not.)
- Pure helpers (`gridColumns.ts`, TDD): a column model that combines
  `pinLayout`'s pinned/unpinned split with an order array and a width map, plus
  `reorder(order, from, to)` and `applyWidths(cols, widthMap)`.
- `ResultGrid.tsx` adds the resizer handles + drag-to-reorder UI on the header;
  the geometry/order math lives in `gridColumns.ts`.

## Out of scope

- Column-name case preservation (shipped in v0.5.3).
- Reordering across the pin boundary, or persisting column order.
- Resizable agent dock / main area (only the sidebar).

## Testing

- Pure helpers (`clampSidebarWidth`, `tableVisibility`, `gridColumns`) via Vitest (TDD).
- UI wiring verified live with CDP (drag sidebar, hide a table, resize/reorder a column) before release.
