# UI Conveniences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Add a resizable sidebar, per-table hide/show, and resizable + reorderable result-grid columns.

**Architecture:** Three independent units (A→B→C). Pure logic (clamp, visibility, column layout) lives in small TDD'd `lib/` modules; React components wire drag/dialog UI to them. Prefs persist to `localStorage` (AgentChat pattern).

**Tech Stack:** React 19, Vitest, lucide-react.

**Spec:** `docs/superpowers/specs/2026-06-04-ui-conveniences-design.md`

---

## File structure

- Create `apps/renderer/src/lib/uiPrefs.ts` (+ test) — `clampSidebarWidth`, `loadNum`/`saveNum` localStorage helpers.
- Create `apps/renderer/src/lib/tableVisibility.ts` (+ test) — hidden-set load/save/filter.
- Create `apps/renderer/src/components/TableVisibilityDialog.tsx` — checkbox dialog.
- Create `apps/renderer/src/lib/gridColumns.ts` (+ test) — column order/width math over `pinLayout`.
- Modify `App.tsx` / `App.css` (sidebar resizer), `SchemaExplorer.tsx` (hide menu + tree filter), `ResultGrid.tsx` (column resize/reorder).

Reuse: AgentChat localStorage pattern; `pinLayout`/`PIN_W`/`COL_W`/`IDX_W` from `lib/pinLayout.ts`.

---

# Unit A — Resizable sidebar

### Task A1: `clampSidebarWidth` + localStorage number helpers (TDD)

**Files:** Create `apps/renderer/src/lib/uiPrefs.ts`, `apps/renderer/src/lib/uiPrefs.test.ts`

- [ ] **Step 1 — failing test** (`uiPrefs.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { clampSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from './uiPrefs';

describe('clampSidebarWidth', () => {
  it('clamps below min and above max', () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX);
  });
  it('passes through an in-range value, rounded', () => {
    expect(clampSidebarWidth(312.6)).toBe(313);
  });
  it('falls back to default for NaN', () => {
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT);
  });
});
```

- [ ] **Step 2 — run, expect FAIL** (`cd apps/renderer && pnpm exec vitest run src/lib/uiPrefs.test.ts`).

- [ ] **Step 3 — implement** (`uiPrefs.ts`):

```ts
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 600;
export const SIDEBAR_DEFAULT = 290;

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

// Read/write a single number under a key, swallowing storage errors.
export function loadNum(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}
export function saveNum(key: string, n: number): void {
  try {
    localStorage.setItem(key, String(n));
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(ui): clampSidebarWidth + localStorage number helpers (TDD)`.

### Task A2: Sidebar drag-resizer in App.tsx

**Files:** Modify `apps/renderer/src/App.tsx`, `apps/renderer/src/App.css`

- [ ] **Step 1 — state + handlers** in `App.tsx` (top of the component, near other `useState`):

```tsx
import { clampSidebarWidth, SIDEBAR_DEFAULT, loadNum, saveNum } from './lib/uiPrefs';
// ...
const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(loadNum('rebase.ui.sidebarWidth', SIDEBAR_DEFAULT)));
useEffect(() => saveNum('rebase.ui.sidebarWidth', sidebarWidth), [sidebarWidth]);
const startSidebarResize = (e: React.MouseEvent) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebarWidth;
  const onMove = (ev: MouseEvent) => setSidebarWidth(clampSidebarWidth(startW + (ev.clientX - startX)));
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
};
```

- [ ] **Step 2 — apply width + render handle.** Change `<aside className="sidebar">` (App.tsx:370) to `<aside className="sidebar" style={{ width: sidebarWidth, flexShrink: 0 }}>`. Immediately after the closing `</aside>` of the sidebar, add:

```tsx
<div
  className="app-resizer"
  onMouseDown={startSidebarResize}
  onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
  title="드래그하여 너비 조절 · 더블클릭으로 초기화"
/>
```

- [ ] **Step 3 — CSS.** In `App.css`, change `.sidebar` (line 134) to drop the fixed `width: 290px` (width now comes from inline style; keep `flex-shrink: 0`). Append:

```css
.app-resizer {
  width: 5px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
}
.app-resizer:hover {
  background: var(--accent);
  opacity: 0.4;
}
```

- [ ] **Step 4 — verify** `pnpm --filter renderer lint && pnpm --filter renderer build`. Expected: clean.
- [ ] **Step 5 — commit** `feat(ui): drag-resizable sidebar width (persisted)`.

---

# Unit B — Hide/show tables

### Task B1: `tableVisibility.ts` (TDD)

**Files:** Create `apps/renderer/src/lib/tableVisibility.ts`, `.test.ts`

- [ ] **Step 1 — failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { visibleTables, hiddenCount, withHidden } from './tableVisibility';

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
  it('withHidden sets the per-db hidden list immutably', () => {
    const store = { p1: { db1: ['a'] } };
    const next = withHidden(store, 'p1', 'db2', ['x']);
    expect(next).toEqual({ p1: { db1: ['a'], db2: ['x'] } });
    expect(store).toEqual({ p1: { db1: ['a'] } });
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement** (`tableVisibility.ts`):

```ts
export type HiddenStore = Record<string, Record<string, string[]>>;
const KEY = 'rebase.ui.hiddenTables';

export function loadHidden(): HiddenStore {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as HiddenStore) : {};
  } catch {
    return {};
  }
}
export function saveHidden(store: HiddenStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}
export function hiddenFor(store: HiddenStore, profileId: string, db: string): string[] {
  return store[profileId]?.[db] ?? [];
}
export function withHidden(store: HiddenStore, profileId: string, db: string, hidden: string[]): HiddenStore {
  return { ...store, [profileId]: { ...(store[profileId] ?? {}), [db]: hidden } };
}
export function visibleTables(all: string[], hidden: string[]): string[] {
  const h = new Set(hidden);
  return all.filter((t) => !h.has(t));
}
export function hiddenCount(all: string[], hidden: string[]): number {
  const h = new Set(hidden);
  return all.filter((t) => h.has(t)).length;
}
```

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(ui): tableVisibility helpers (TDD)`.

### Task B2: `TableVisibilityDialog.tsx`

**Files:** Create `apps/renderer/src/components/TableVisibilityDialog.tsx`

- [ ] **Step 1 — component.** Props: `{ tables: string[]; hidden: string[]; onApply: (hidden: string[]) => void; onClose: () => void }`. Local state = a `Set` of *visible* names (init `tables` minus `hidden`), plus a search string. Render a modal (reuse existing `.modal`/`.dialog` styles — grep `SchemaExplorer.tsx` / `CreateTableDialog.tsx` for the class names and copy the overlay markup) with: a search input filtering the list; a checkbox per table; "전체 선택" / "전체 해제" buttons; "적용" (calls `onApply([...tables].filter(t => !visible.has(t)))` then `onClose`) and "취소". Keep it focused (~90 lines).

- [ ] **Step 2 — verify build** `pnpm --filter renderer build`. Expected: compiles (not yet imported).
- [ ] **Step 3 — commit** `feat(ui): TableVisibilityDialog (checkbox table picker)`.

### Task B3: Wire into SchemaExplorer

**Files:** Modify `apps/renderer/src/components/SchemaExplorer.tsx`, `App.css`

- [ ] **Step 1 — state.** Add `const [hiddenStore, setHiddenStore] = useState<HiddenStore>(loadHidden);` and `const [visDialog, setVisDialog] = useState<{ db: string; tables: string[] } | null>(null);`. Import the helpers + dialog.

- [ ] **Step 2 — menu item.** In the database context menu (`dbMenu` block), add a button `테이블 표시…` that sets `setVisDialog({ db: dbMenu.db, tables: (db.tables ?? []).map(t => t.name) })` (resolve the loaded tables for that db) and closes the menu.

- [ ] **Step 3 — filter the tree.** Where the table rows render (`db.tables.map(...)`), wrap with `visibleTables(db.tables.map(t=>t.name), hiddenFor(hiddenStore, profileId, db.name))` to decide which `TableNode`s to render. After the table rows, if `hiddenCount(...) > 0`, render a muted row `숨긴 테이블 N개` whose onClick opens the dialog for that db.

- [ ] **Step 4 — apply.** Render `{visDialog && <TableVisibilityDialog tables={visDialog.tables} hidden={hiddenFor(hiddenStore, profileId, visDialog.db)} onClose={() => setVisDialog(null)} onApply={(hidden) => { const next = withHidden(hiddenStore, profileId, visDialog.db, hidden); setHiddenStore(next); saveHidden(next); }} />}`.

- [ ] **Step 5 — CSS.** Add a `.tree-hidden-row` muted style in `App.css` (small, `var(--text-3)`, italic, clickable).

- [ ] **Step 6 — verify** `pnpm --filter renderer lint && build`. Commit `feat(ui): hide/show tables from the schema explorer (persisted)`.

---

# Unit C — Resizable & reorderable columns

### Task C1: `gridColumns.ts` (TDD)

**Files:** Create `apps/renderer/src/lib/gridColumns.ts`, `.test.ts`

- [ ] **Step 1 — failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { reorderUnpinned, columnWidth } from './gridColumns';

describe('reorderUnpinned', () => {
  it('moves an item within the array', () => {
    expect(reorderUnpinned([0, 1, 2, 3], 3, 1)).toEqual([0, 3, 1, 2]);
  });
  it('no-op when from === to', () => {
    expect(reorderUnpinned([0, 1, 2], 1, 1)).toEqual([0, 1, 2]);
  });
});
describe('columnWidth', () => {
  it('uses the stored width by column name', () => {
    expect(columnWidth('userId', { userId: 240 }, 200)).toBe(240);
  });
  it('falls back to the default', () => {
    expect(columnWidth('x', {}, 200)).toBe(200);
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement** (`gridColumns.ts`):

```ts
// Move element from index `from` to index `to`, returning a new array.
export function reorderUnpinned(order: number[], from: number, to: number): number[] {
  if (from === to) return order.slice();
  const next = order.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// Width (px) for a column, by name, falling back to a default.
export function columnWidth(name: string, widths: Record<string, number>, fallback: number): number {
  const w = widths[name];
  return Number.isFinite(w) && w > 0 ? w : fallback;
}
```

- [ ] **Step 4 — run, expect PASS.** Commit `feat(grid): pure column reorder + width helpers (TDD)`.

### Task C2: Column width resizing in ResultGrid

**Files:** Modify `apps/renderer/src/components/ResultGrid.tsx`

- [ ] **Step 1 — width state.** Add `const [colWidths, setColWidths] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem('rebase.ui.colWidths') || '{}'); } catch { return {}; } });` and an effect persisting it: `useEffect(() => { try { localStorage.setItem('rebase.ui.colWidths', JSON.stringify(colWidths)); } catch {} }, [colWidths]);`. Import `columnWidth`.

- [ ] **Step 2 — apply width in `cellGeom`.** Replace the non-pinned width branches so a column's width comes from `columnWidth(columns[origC], colWidths, COL_W)` (fixed flex `0 0 <w>px`) instead of `COL_W`/flexible. (Pinned cells keep `PIN_W`.)

- [ ] **Step 3 — resizer handle.** In the header-cell render (`lay.order.map`), append a `<span className="col-resizer" onMouseDown={(e) => startColResize(e, columns[idx])} />` inside each `grid-head-cell`. `startColResize` mirrors the sidebar drag: capture startX + current width, on move `setColWidths(w => ({ ...w, [name]: Math.max(60, startW + dx) }))`, on up remove listeners. Double-click the resizer deletes the override (`setColWidths(w => { const n = {...w}; delete n[name]; return n; })`).

- [ ] **Step 4 — CSS** (`App.css`): `.col-resizer { position:absolute; right:0; top:0; height:100%; width:6px; cursor:col-resize; } .grid-head-cell { position: relative; }` and a hover affordance.

- [ ] **Step 5 — verify** lint+build. Commit `feat(grid): drag-resizable column widths (persisted by name)`.

### Task C3: Column reorder (drag header)

**Files:** Modify `apps/renderer/src/components/ResultGrid.tsx`

- [ ] **Step 1 — order state.** Add `const [userOrder, setUserOrder] = useState<number[] | null>(null);` reset on new columns (`useEffect(() => setUserOrder(null), [columns])`). Compute the displayed order: start from `lay.order` (pin layout), then if `userOrder` is set, apply it to the **unpinned** suffix only (pinned stay front). Helper inline or in `gridColumns.ts`.

- [ ] **Step 2 — drag handlers.** Make each `grid-head-cell` `draggable` (HTML5 DnD): `onDragStart` stores the dragged original index; `onDragOver` preventDefault; `onDrop` computes from/to positions within the unpinned group and `setUserOrder(reorderUnpinned(currentUnpinnedOrder, from, to))`. Pinned columns are not draggable.

- [ ] **Step 3 — render in computed order.** Replace `lay.order.map` with the computed display order from Step 1.

- [ ] **Step 4 — verify** lint+build. Commit `feat(grid): drag-to-reorder result columns (session-scoped)`.

### Task C4: Live verification + docs

- [ ] **Step 1 — CDP live check** (dev app, real MySQL): drag the sidebar (width changes + persists across reload); open the table picker, hide a table (gone from tree, "숨긴 1개" row), reopen + unhide; run a query, drag a column border (width changes), drag a header to reorder. Confirm no console errors.
- [ ] **Step 2 — README**: add a line under "Schema explorer"/"Result grid" features mentioning resizable sidebar, table hiding, and resizable/reorderable columns.
- [ ] **Step 3 — full regression** `pnpm --filter renderer test && lint && build`.
- [ ] **Step 4 — commit + PR** `feat(ui): resizable sidebar, table hide/show, column resize/reorder`. After CI, merge → release-please cuts v0.6.0 (feat).

---

## Notes for the implementer

- localStorage keys: `rebase.ui.sidebarWidth`, `rebase.ui.hiddenTables`, `rebase.ui.colWidths`.
- Column order is intentionally NOT persisted (spec); width IS, keyed by column name.
- Pinned columns stay left; reorder only affects the unpinned group.
- Co-author every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
