# 결과 그리드 Phase 1 (읽기측: 내보내기·복사·정렬·필터) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 쿼리 결과 그리드에 CSV/JSON 내보내기, TSV 복사, 클라이언트 정렬, 빠른 필터를 추가한다(읽기 전용).

**Architecture:** 순수 직렬화/정렬/필터 로직을 `gridExport.ts`·`gridView.ts`로 분리해 TDD하고, 새 `ResultGrid` 컴포넌트가 이를 사용해 툴바(필터·내보내기) + 정렬 가능한 헤더 + 셀/행 선택·복사 + 가상화를 제공한다. `QueryEditor`의 결과 영역이 `ResultGrid`를 쓰도록 교체. 백엔드 변경 없음.

**Tech Stack:** React 19 + TypeScript, vitest, lucide-react.

> 이제 git 저장소다. 각 Task의 Commit 스텝을 실제로 수행한다. 모든 bash 앞에 `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`. 테스트/빌드는 `apps/renderer`에서.

---

## File Structure

- **신규** `apps/renderer/src/lib/gridExport.ts` (+ `.test.ts`) — `toCsv`/`toJson`/`toTsv` 순수 직렬화.
- **신규** `apps/renderer/src/lib/gridView.ts` (+ `.test.ts`) — `sortRows`/`filterRows` 순수 변환.
- **신규** `apps/renderer/src/components/ResultGrid.tsx` — 툴바+정렬헤더+선택/복사+가상화 그리드.
- **수정** `apps/renderer/src/components/QueryEditor.tsx` — 결과 영역을 `ResultGrid`로 교체.
- **수정** `apps/renderer/src/App.css` — 툴바/내보내기 메뉴/선택 셀 스타일.
- 기존 `components/VirtualizedGrid.tsx` — `ResultGrid`가 대체. 다른 참조가 없으면 제거(Task 4에서 grep 확인).

---

## Task 1: gridExport — toCsv / toJson / toTsv (TDD)

**Files:**
- Create: `apps/renderer/src/lib/gridExport.ts`
- Test: `apps/renderer/src/lib/gridExport.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/renderer/src/lib/gridExport.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toCsv, toJson, toTsv } from './gridExport';

describe('toCsv', () => {
  it('joins columns and rows with commas and newlines', () => {
    expect(toCsv(['a', 'b'], [[1, 2], [3, 4]])).toBe('a,b\n1,2\n3,4');
  });
  it('quotes fields containing comma, quote, or newline and doubles quotes', () => {
    expect(toCsv(['x'], [['a,b'], ['he said "hi"'], ['line\nbreak']])).toBe(
      'x\n"a,b"\n"he said ""hi"""\n"line\nbreak"'
    );
  });
  it('renders null as empty and objects as JSON', () => {
    expect(toCsv(['a', 'b'], [[null, { k: 1 }]])).toBe('a,b\n,"{""k"":1}"');
  });
  it('returns just the header when there are no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });
});

describe('toJson', () => {
  it('maps rows to column-keyed objects', () => {
    expect(toJson(['id', 'name'], [[1, 'x'], [2, 'y']])).toBe(
      JSON.stringify([{ id: 1, name: 'x' }, { id: 2, name: 'y' }], null, 2)
    );
  });
  it('preserves null values', () => {
    expect(toJson(['a'], [[null]])).toBe(JSON.stringify([{ a: null }], null, 2));
  });
});

describe('toTsv', () => {
  it('joins a subgrid with tabs and newlines, null → empty', () => {
    expect(toTsv([[1, null], ['a', 'b']])).toBe('1\t\na\tb');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/gridExport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`apps/renderer/src/lib/gridExport.ts`:

```ts
// Pure serializers for exporting / copying grid data. No DOM dependency.

function cell(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// RFC4180-style field: quote when it contains comma, quote, CR or LF.
function csvField(val: unknown): string {
  const s = cell(val);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const head = columns.map(csvField).join(',');
  const body = rows.map((r) => r.map(csvField).join(',')).join('\n');
  return body ? head + '\n' + body : head;
}

export function toJson(columns: string[], rows: unknown[][]): string {
  const objs = rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      o[c] = r[i] === undefined ? null : r[i];
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}

// Tab-separated values for clipboard (Excel/Sheets friendly). null → empty.
export function toTsv(grid: unknown[][]): string {
  return grid.map((row) => row.map(cell).join('\t')).join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/gridExport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/gridExport.ts apps/renderer/src/lib/gridExport.test.ts
git commit -m "feat(grid): add toCsv/toJson/toTsv serializers"
```

---

## Task 2: gridView — sortRows / filterRows (TDD)

**Files:**
- Create: `apps/renderer/src/lib/gridView.ts`
- Test: `apps/renderer/src/lib/gridView.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/renderer/src/lib/gridView.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/gridView.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`apps/renderer/src/lib/gridView.ts`:

```ts
// Pure client-side grid transforms. No DOM dependency.

export type SortDir = 'asc' | 'desc';

// Compare two cell values: numbers numerically, others by locale string. Nulls last.
function cmp(a: unknown, b: unknown): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

// Return a new array sorted by the given column and direction (stable).
export function sortRows(rows: unknown[][], colIndex: number, dir: SortDir): unknown[][] {
  return rows
    .map((r, i) => [r, i] as const)
    .sort(([a, ai], [b, bi]) => {
      const c = cmp(a[colIndex], b[colIndex]);
      if (c !== 0) return dir === 'asc' ? c : -c;
      return ai - bi;
    })
    .map(([r]) => r);
}

// Keep rows where any cell's string form contains the query (case-insensitive).
export function filterRows(rows: unknown[][], query: string): unknown[][] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    r.some((v) => {
      if (v === null || v === undefined) return false;
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return s.toLowerCase().includes(q);
    })
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/gridView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/gridView.ts apps/renderer/src/lib/gridView.test.ts
git commit -m "feat(grid): add sortRows/filterRows client transforms"
```

---

## Task 3: ResultGrid component

**Files:**
- Create: `apps/renderer/src/components/ResultGrid.tsx`

- [ ] **Step 1: Implement**

`apps/renderer/src/components/ResultGrid.tsx`:

```tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { toCsv, toJson, toTsv } from '../lib/gridExport';
import { sortRows, filterRows, type SortDir } from '../lib/gridView';

interface Props {
  columns: string[];
  rows: unknown[][];
  rowHeight?: number;
}

interface Sel {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

function tsTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function cellText(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

export const ResultGrid: React.FC<Props> = ({ columns, rows, rowHeight = 32 }) => {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(300);

  const display = useMemo(() => {
    const f = filterRows(rows, filter);
    return sort ? sortRows(f, sort.col, sort.dir) : f;
  }, [rows, filter, sort]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerHeight(e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Clear selection when the data/derivation changes.
  useEffect(() => {
    setSel(null);
  }, [rows, filter, sort]);

  const totalHeight = display.length * rowHeight;
  const buffer = 6;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
  const end = Math.min(display.length, Math.ceil((scrollTop + containerHeight) / rowHeight) + buffer);
  const visible = display.slice(start, end);

  const toggleSort = (col: number) => {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' };
      if (prev.dir === 'asc') return { col, dir: 'desc' };
      return null; // third click clears sort
    });
  };

  const selectCell = (r: number, c: number, shift: boolean) =>
    setSel((prev) => (shift && prev ? { ...prev, r2: r, c2: c } : { r1: r, c1: c, r2: r, c2: c }));
  const selectRow = (r: number, shift: boolean) => {
    const last = columns.length - 1;
    setSel((prev) => (shift && prev ? { r1: prev.r1, c1: 0, r2: r, c2: last } : { r1: r, c1: 0, r2: r, c2: last }));
  };

  const bounds = (s: Sel) => ({
    r0: Math.min(s.r1, s.r2),
    r1: Math.max(s.r1, s.r2),
    c0: Math.min(s.c1, s.c2),
    c1: Math.max(s.c1, s.c2),
  });

  const inSel = (r: number, c: number) => {
    if (!sel) return false;
    const b = bounds(sel);
    return r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;
  };

  const copySelection = () => {
    if (!sel) return;
    const b = bounds(sel);
    const grid: unknown[][] = [];
    for (let r = b.r0; r <= b.r1; r++) {
      const row: unknown[] = [];
      for (let c = b.c0; c <= b.c1; c++) row.push(display[r]?.[c]);
      grid.push(row);
    }
    void navigator.clipboard.writeText(toTsv(grid));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      copySelection();
    }
  };

  return (
    <div className="grid" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="grid-toolbar">
        <div className="grid-filter">
          <Search size={13} />
          <input className="input" placeholder="필터… (로드된 행)" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="grid-export">
          <button className="btn btn-secondary btn-xs" disabled={display.length === 0} onClick={() => setMenuOpen((o) => !o)}>
            <Download size={12} /> 내보내기 ▾
          </button>
          {menuOpen && (
            <div className="grid-export-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button onClick={() => { download(`result-${tsTimestamp()}.csv`, toCsv(columns, display), 'text/csv'); setMenuOpen(false); }}>CSV</button>
              <button onClick={() => { download(`result-${tsTimestamp()}.json`, toJson(columns, display), 'application/json'); setMenuOpen(false); }}>JSON</button>
            </div>
          )}
        </div>
      </div>

      <div className="grid-head">
        <div className="grid-idx">#</div>
        {columns.map((col, idx) => (
          <div key={idx} className="grid-cell grid-head-cell" title={col} onClick={() => toggleSort(idx)}>
            {col}
            {sort && sort.col === idx ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
          </div>
        ))}
      </div>

      <div className="grid-body" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {display.length === 0 ? (
          <div className="grid-empty">No rows.</div>
        ) : (
          <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
            {visible.map((row, ri) => {
              const r = start + ri;
              return (
                <div
                  key={r}
                  className={`grid-row ${r % 2 === 0 ? 'even' : 'odd'}`}
                  style={{ position: 'absolute', top: `${r * rowHeight}px`, height: `${rowHeight}px`, left: 0, right: 0, display: 'flex' }}
                >
                  <div className="grid-idx" onMouseDown={(e) => selectRow(r, e.shiftKey)}>{r + 1}</div>
                  {row.map((val, c) => {
                    const isNull = val === null || val === undefined;
                    const text = cellText(val);
                    return (
                      <div
                        key={c}
                        className={`grid-cell ${isNull ? 'null' : ''} ${inSel(r, c) ? 'sel' : ''}`}
                        title={text}
                        onMouseDown={(e) => selectCell(r, c, e.shiftKey)}
                      >
                        {text}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid-foot">
        <span>
          {display.length.toLocaleString()} rows{filter ? ` (필터됨 · 전체 ${rows.length.toLocaleString()})` : ''}
        </span>
        {columns.length > 0 && <span>{columns.length} columns</span>}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/renderer/src/components/ResultGrid.tsx
git commit -m "feat(grid): add ResultGrid (toolbar, sort, filter, selection+copy)"
```

---

## Task 4: Wire ResultGrid into QueryEditor + CSS

**Files:**
- Modify: `apps/renderer/src/components/QueryEditor.tsx`
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: Replace the grid in QueryEditor**

READ `QueryEditor.tsx`. It imports `VirtualizedGrid` and renders `<VirtualizedGrid columns={activeTab.columns} rows={activeTab.rows} />` (in the results area). Change:
- the import `import { VirtualizedGrid } from './VirtualizedGrid';` → `import { ResultGrid } from './ResultGrid';`
- the JSX `<VirtualizedGrid columns={activeTab.columns} rows={activeTab.rows} />` → `<ResultGrid columns={activeTab.columns} rows={activeTab.rows} />`

- [ ] **Step 2: Remove VirtualizedGrid if now unused**

Run: `cd apps/renderer && grep -rn "VirtualizedGrid" src` — if the only remaining matches are the file itself, delete it: `rm src/components/VirtualizedGrid.tsx`. If anything else imports it, leave it.

- [ ] **Step 3: Append CSS** to `App.css`:

```css
/* Result grid toolbar / export / selection */
.grid-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.grid-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  flex: 1;
  max-width: 320px;
}
.grid-filter .input {
  height: 26px;
  font-size: 12px;
}
.grid-export {
  position: relative;
}
.grid-export-menu {
  position: absolute;
  right: 0;
  top: 100%;
  margin-top: 4px;
  z-index: 20;
  background: var(--bg-panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  min-width: 100px;
  overflow: hidden;
}
.grid-export-menu button {
  text-align: left;
  padding: 7px 12px;
  font-size: 12px;
  color: var(--text);
  background: transparent;
  border: none;
  cursor: pointer;
}
.grid-export-menu button:hover {
  background: var(--bg-hover);
}
.grid-head-cell {
  cursor: pointer;
  user-select: none;
}
.grid-head-cell:hover {
  color: var(--text);
}
.grid-cell.sel {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-border);
}
```

> 변수(`--border`, `--text-3`, `--text`, `--bg-panel-2`, `--bg-hover`, `--radius`, `--accent-soft`, `--accent-border`)가 App.css에 있는지 grep으로 확인하고, 없는 것은 가장 가까운 기존 토큰으로 대체한다(보고).

- [ ] **Step 4: Typecheck & build**

Run: `cd apps/renderer && npx tsc --noEmit && npm run build`
Expected: no errors, build success.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/components/QueryEditor.tsx apps/renderer/src/App.css
# include the VirtualizedGrid deletion if it was removed:
git add -A apps/renderer/src/components/
git commit -m "feat(grid): use ResultGrid for query results (export/copy/sort/filter)"
```

---

## Task 5: 전체 테스트 + 빌드 + CDP 검증

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: Unit tests + typecheck + build**

```bash
cd apps/renderer
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run        # gridExport + gridView 포함 전체 green
npx tsc --noEmit
npm run build
```

- [ ] **Step 2: CDP 실제 검증** (`--remote-debugging-port=9222` 인스턴스, mysql 연결)

1. `SELECT * FROM demo_users` 실행 → 결과 그리드 표시.
2. **정렬**: `name` 헤더 클릭 → ▲(오름차순) 정렬 확인, 다시 클릭 → ▼, 한 번 더 → 원본. DOM의 첫 데이터 행 값으로 확인.
3. **필터**: 필터 입력에 특정 값 입력 → 행 수가 줄고 푸터에 "필터됨 · 전체 N" 표시 확인.
4. **선택+복사**: 셀 클릭 → `.grid-cell.sel` 하이라이트 확인. Shift+클릭으로 범위 확장 확인. (클립보드 내용은 단위 테스트 `toTsv`로 보장; 복사 시 예외 없음만 확인.)
5. **내보내기**: "내보내기 ▾" 클릭 → CSV/JSON 메뉴 노출 확인, CSV 클릭 시 예외 없이 동작(다운로드 트리거). 내용 정확성은 `toCsv`/`toJson` 단위 테스트로 보장.
6. `/tmp/*.mjs` 정리.

- [ ] **Step 3: Commit (검증 메모 불필요 — 코드 변경 없음)**

---

## Self-Review (작성자 체크리스트 — 완료)

- **스펙 커버리지(Phase 1):** 내보내기 CSV/JSON(Task 1,3,4), 복사 TSV(Task 1,3), 클라이언트 정렬(Task 2,3), 빠른 필터(Task 2,3), 그리드 통합(Task 4) — 모두 매핑.
- **플레이스홀더:** 없음. (Task 4 CSS 블록의 잘못된 마지막 줄 표기는 주석으로 명시적 경고함.)
- **타입 일관성:** `toCsv/toJson/toTsv`, `sortRows/filterRows`, `SortDir`, `ResultGrid` props가 태스크 간 일치. `ResultGrid`는 `display`(필터→정렬 결과)를 내보내기/복사/표시에 일관되게 사용.
