# 결과 그리드 Phase 2 (테이블 데이터 뷰 + 페이지네이션 + 서버측 정렬/필터) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스키마 트리에서 테이블을 더블클릭하면 메인 패널에 데이터 뷰가 열리고, 서버측 페이지네이션·정렬·필터로 테이블 데이터를 탐색한다(읽기 전용; 편집은 Phase 3).

**Architecture:** 순수 `tableQuery.ts`(LIMIT/OFFSET/ORDER BY/WHERE SQL 빌드, TDD)와 IO 헬퍼 `runSelect.ts`(SELECT 스트림 수집)를 기반으로, 새 `TableDataView` 컴포넌트가 페이지/정렬/필터 상태를 관리하며 페이지를 조회·표시한다. 표시·선택·복사·내보내기는 Phase 1의 `gridExport` + 공용 `gridFormat` 헬퍼를 재사용한다. 백엔드 변경 없음.

**Tech Stack:** React 19 + TypeScript, vitest, lucide-react, 기존 `window.electronAPI`.

> git 저장소(브랜치 `feat/grid-data-features`). 각 Task의 Commit 스텝을 실제 수행. 모든 bash 앞에 `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`. 테스트/빌드는 `apps/renderer`에서.

---

## File Structure

- **신규** `apps/renderer/src/lib/tableQuery.ts` (+test) — `buildWhere`/`buildSelectPage` 순수 SQL 빌더.
- **신규** `apps/renderer/src/lib/gridFormat.ts` (+test) — `cellText`/`tsTimestamp`/`download` 공용 헬퍼(Phase 1 `ResultGrid`의 인라인 헬퍼를 여기로 추출).
- **수정** `apps/renderer/src/components/ResultGrid.tsx` — 인라인 헬퍼 제거 후 `gridFormat`에서 import.
- **신규** `apps/renderer/src/lib/runSelect.ts` — SELECT를 실행해 `{columns, rows}`를 모으는 IO 헬퍼.
- **신규** `apps/renderer/src/components/TableDataView.tsx` — 데이터 뷰(페이지/정렬/필터 + 표시/선택/복사/내보내기).
- **수정** `apps/renderer/src/components/SchemaExplorer.tsx` — 테이블 행 더블클릭 → `onOpenTableData(db, table)`.
- **수정** `apps/renderer/src/App.tsx` — 연결별 `openTable` 상태 + 메인 패널 분기.
- **수정** `apps/renderer/src/App.css` — 데이터 뷰/페이지바/필터행 스타일.
- 재사용(변경 없음): `lib/ddlBuilder.ts`의 `quoteIdent`/`Driver`, `lib/gridExport.ts`.

기존 참조:
- `executeQueryStream(queryId, profileId, sql, opts?)` + `onQueryStreamChunk((id, chunk)=>...)`. 청크: `{type:'meta', columns}` / `{type:'row', data}` / `{type:'done', ...}` / `{type:'error', message}` / `{type:'policy', message}`.
- `describeTable(profileId, db, table)` → `{ columns: [{name, type, nullable, primaryKey}] }`.
- App 메인 패널: 연결별 `<QueryEditor .../>` (또는 redis는 `RedisValueInspector`). [App.tsx:547](apps/renderer/src/App.tsx#L547) 부근.
- SchemaExplorer 테이블 행: `onClick={() => toggleTable(db.name, table.name)}` `onContextMenu={(e) => openMenu(e, db.name, table.name)}`.

---

## Task 1: tableQuery — buildWhere / buildSelectPage (TDD)

**Files:**
- Create: `apps/renderer/src/lib/tableQuery.ts`
- Test: `apps/renderer/src/lib/tableQuery.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/renderer/src/lib/tableQuery.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildWhere, buildSelectPage } from './tableQuery';

describe('buildWhere', () => {
  it('returns empty string when no active filters', () => {
    expect(buildWhere('mysql', [])).toBe('');
    expect(buildWhere('mysql', [{ col: 'a', value: '   ' }])).toBe('');
  });
  it('builds a LIKE condition with backtick identifier (mysql)', () => {
    expect(buildWhere('mysql', [{ col: 'name', value: 'ab' }])).toBe(
      "WHERE `name` LIKE '%ab%' ESCAPE '\\'"
    );
  });
  it('builds a LIKE condition with double-quote identifier (postgres)', () => {
    expect(buildWhere('postgres', [{ col: 'name', value: 'ab' }])).toBe(
      `WHERE "name" LIKE '%ab%' ESCAPE '\\'`
    );
  });
  it('ANDs multiple active filters and skips blank ones', () => {
    expect(
      buildWhere('mysql', [{ col: 'a', value: 'x' }, { col: 'b', value: '' }, { col: 'c', value: 'y' }])
    ).toBe("WHERE `a` LIKE '%x%' ESCAPE '\\' AND `c` LIKE '%y%' ESCAPE '\\'");
  });
  it('escapes single quote and LIKE wildcards in the value', () => {
    expect(buildWhere('mysql', [{ col: 'x', value: "a'b%c_d" }])).toBe(
      String.raw`WHERE ` + '`x`' + String.raw` LIKE '%a''b\%c\_d%' ESCAPE '\'`
    );
  });
});

describe('buildSelectPage', () => {
  it('builds a basic page query', () => {
    expect(buildSelectPage('mysql', 'users', { limit: 50, offset: 0 })).toBe(
      'SELECT * FROM `users` LIMIT 50 OFFSET 0'
    );
  });
  it('adds ORDER BY when given', () => {
    expect(buildSelectPage('postgres', 'users', { orderBy: { col: 'id', dir: 'desc' }, limit: 50, offset: 100 })).toBe(
      'SELECT * FROM "users" ORDER BY "id" DESC LIMIT 50 OFFSET 100'
    );
  });
  it('combines WHERE and ORDER BY', () => {
    expect(
      buildSelectPage('mysql', 'users', { filters: [{ col: 'name', value: 'ab' }], orderBy: { col: 'name', dir: 'asc' }, limit: 10, offset: 0 })
    ).toBe("SELECT * FROM `users` WHERE `name` LIKE '%ab%' ESCAPE '\\' ORDER BY `name` ASC LIMIT 10 OFFSET 0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/tableQuery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`apps/renderer/src/lib/tableQuery.ts`:

```ts
import { quoteIdent, type Driver } from './ddlBuilder';

export interface ColFilter {
  col: string;
  value: string;
}
export interface OrderBy {
  col: string;
  dir: 'asc' | 'desc';
}
export interface PageQuery {
  filters?: ColFilter[];
  orderBy?: OrderBy | null;
  limit: number;
  offset: number;
}

// Build a single-quoted LIKE pattern `'%value%'`, escaping the string-literal
// quote and the LIKE wildcards (% _ and the escape char \) so the value is
// matched literally as a substring. Pair with `ESCAPE '\'`.
function likeLiteral(value: string): string {
  const esc = value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/'/g, "''");
  return `'%${esc}%'`;
}

export function buildWhere(driver: Driver, filters: ColFilter[]): string {
  const active = filters.filter((f) => f.value.trim() !== '');
  if (active.length === 0) return '';
  const conds = active.map(
    (f) => `${quoteIdent(driver, f.col)} LIKE ${likeLiteral(f.value.trim())} ESCAPE '\\'`
  );
  return 'WHERE ' + conds.join(' AND ');
}

export function buildSelectPage(driver: Driver, table: string, q: PageQuery): string {
  const parts = [`SELECT * FROM ${quoteIdent(driver, table)}`];
  const where = buildWhere(driver, q.filters ?? []);
  if (where) parts.push(where);
  if (q.orderBy) {
    parts.push(`ORDER BY ${quoteIdent(driver, q.orderBy.col)} ${q.orderBy.dir === 'asc' ? 'ASC' : 'DESC'}`);
  }
  parts.push(`LIMIT ${q.limit} OFFSET ${q.offset}`);
  return parts.join(' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/tableQuery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/tableQuery.ts apps/renderer/src/lib/tableQuery.test.ts
git commit -m "feat(grid): add tableQuery (buildWhere/buildSelectPage)"
```

---

## Task 2: gridFormat — 공용 헬퍼 추출 + ResultGrid 리팩터

**Files:**
- Create: `apps/renderer/src/lib/gridFormat.ts` (+ `.test.ts`)
- Modify: `apps/renderer/src/components/ResultGrid.tsx`

- [ ] **Step 1: Write the failing test**

`apps/renderer/src/lib/gridFormat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { cellText, tsTimestamp } from './gridFormat';

describe('cellText', () => {
  it('renders null/undefined as NULL', () => {
    expect(cellText(null)).toBe('NULL');
    expect(cellText(undefined)).toBe('NULL');
  });
  it('stringifies objects as JSON and primitives directly', () => {
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText(42)).toBe('42');
    expect(cellText('hi')).toBe('hi');
  });
});

describe('tsTimestamp', () => {
  it('formats a fixed date as YYYYMMDD-HHMMSS', () => {
    expect(tsTimestamp(new Date(2026, 5, 1, 9, 7, 3))).toBe('20260601-090703');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/gridFormat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`apps/renderer/src/lib/gridFormat.ts`:

```ts
// Shared grid display/export helpers used by ResultGrid and TableDataView.

// How a cell value is shown in the grid (NULL for empty, JSON for objects).
export function cellText(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// Timestamp for export filenames: YYYYMMDD-HHMMSS. Date is injectable for tests.
export function tsTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Trigger a browser download of `text` as `filename`.
export function download(filename: string, text: string, mime: string): void {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/gridFormat.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor ResultGrid to use gridFormat**

READ `apps/renderer/src/components/ResultGrid.tsx`. It defines local `tsTimestamp`, `download`, and `cellText` functions near the top. Remove those three local function definitions and instead import them:

Add to the imports at the top:
```tsx
import { cellText, tsTimestamp, download } from '../lib/gridFormat';
```
Delete the local `function tsTimestamp() {...}`, `function download(...) {...}`, and `function cellText(...) {...}` definitions. The rest of the component (which calls `tsTimestamp()`, `download(...)`, `cellText(...)`) stays unchanged — the imported versions have compatible signatures (`tsTimestamp()` uses the default `new Date()`).

- [ ] **Step 6: Typecheck**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: no errors. (If "tsTimestamp declared but never used" or duplicate-identifier errors appear, you left a local copy — remove it.)

- [ ] **Step 7: Commit**

```bash
git add apps/renderer/src/lib/gridFormat.ts apps/renderer/src/lib/gridFormat.test.ts apps/renderer/src/components/ResultGrid.tsx
git commit -m "refactor(grid): extract cellText/tsTimestamp/download to gridFormat"
```

---

## Task 3: runSelect — SELECT 스트림 수집 헬퍼

**Files:**
- Create: `apps/renderer/src/lib/runSelect.ts`

> IO 어댑터 — 단위 테스트 없이 구현하고 Task 6 CDP로 검증.

- [ ] **Step 1: Implement**

`apps/renderer/src/lib/runSelect.ts`:

```ts
// Runs a read-only query and collects its full streamed result into memory.
// Mirrors the renderer's existing stream handling but for one-shot SELECTs
// (e.g. a single page of table data). UI-only adapter.

export interface SelectResult {
  ok: boolean;
  columns: string[];
  rows: unknown[][];
  error?: string;
}

export function runSelect(profileId: string, sql: string): Promise<SelectResult> {
  return new Promise((resolve) => {
    const queryId = `sel-${crypto.randomUUID()}`;
    let settled = false;
    let columns: string[] = [];
    const rows: unknown[][] = [];

    let cleanup: () => void = () => undefined;
    const finish = (r: SelectResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    cleanup = window.electronAPI.onQueryStreamChunk((id, chunk: any) => {
      if (id !== queryId || settled) return;
      if (chunk.type === 'meta') {
        columns = chunk.columns ?? [];
      } else if (chunk.type === 'row') {
        rows.push(chunk.data);
      } else if (chunk.type === 'done') {
        finish({ ok: true, columns, rows });
      } else if (chunk.type === 'error') {
        finish({ ok: false, columns, rows, error: chunk.message || 'Query error' });
      } else if (chunk.type === 'policy') {
        finish({ ok: false, columns, rows, error: chunk.message || 'Blocked by policy' });
      }
    });

    window.electronAPI
      .executeQueryStream(queryId, profileId, sql)
      .then((res) => {
        if (!res.success) finish({ ok: false, columns, rows, error: res.error || 'Failed to start query' });
      })
      .catch((e: any) => finish({ ok: false, columns, rows, error: e?.message || 'Request failed' }));
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/renderer/src/lib/runSelect.ts
git commit -m "feat(grid): add runSelect stream-collecting helper"
```

---

## Task 4: TableDataView 컴포넌트

**Files:**
- Create: `apps/renderer/src/components/TableDataView.tsx`

- [ ] **Step 1: Implement**

`apps/renderer/src/components/TableDataView.tsx`:

```tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Download, AlertTriangle, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { ColumnInfo } from '../global';
import type { Driver } from '../lib/ddlBuilder';
import { buildSelectPage, type ColFilter, type OrderBy } from '../lib/tableQuery';
import { runSelect } from '../lib/runSelect';
import { toCsv, toJson, toTsv } from '../lib/gridExport';
import { cellText, tsTimestamp, download } from '../lib/gridFormat';

interface Props {
  profileId: string;
  driver: Driver;
  database: string;
  table: string;
  onClose: () => void;
}

interface Sel {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

const PAGE_SIZE = 200;
const ROW_HEIGHT = 32;

export const TableDataView: React.FC<Props> = ({ profileId, driver, database, table, onClose }) => {
  const [columns, setColumns] = useState<string[]>([]);
  const [pkCols, setPkCols] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [orderBy, setOrderBy] = useState<OrderBy | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [appliedFilters, setAppliedFilters] = useState<ColFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sel, setSel] = useState<Sel | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(300);

  // Load column metadata (and PK info, used by Phase 3 editing) once.
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await window.electronAPI.describeTable(profileId, database, table);
        if (ignore) return;
        const cols: ColumnInfo[] = res.success && res.data ? res.data.columns : [];
        setColumns(cols.map((c) => c.name));
        setPkCols(cols.filter((c) => c.primaryKey).map((c) => c.name));
      } catch (e: any) {
        if (!ignore) setError(e?.message || 'Failed to describe table');
      }
    })();
    return () => {
      ignore = true;
    };
  }, [profileId, database, table]);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sql = buildSelectPage(driver, table, {
      filters: appliedFilters,
      orderBy,
      limit: PAGE_SIZE + 1, // one extra row to detect a next page
      offset: page * PAGE_SIZE,
    });
    const res = await runSelect(profileId, sql);
    setLoading(false);
    if (!res.ok) {
      setError(res.error || 'Query failed');
      return;
    }
    if (res.columns.length > 0) setColumns(res.columns);
    setHasNext(res.rows.length > PAGE_SIZE);
    setRows(res.rows.slice(0, PAGE_SIZE));
    setSel(null);
  }, [profileId, driver, table, appliedFilters, orderBy, page]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

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

  const totalHeight = rows.length * ROW_HEIGHT;
  const buffer = 6;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - buffer);
  const end = Math.min(rows.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + buffer);
  const visible = rows.slice(start, end);

  const toggleSort = (colName: string) => {
    setPage(0);
    setOrderBy((prev) => {
      if (!prev || prev.col !== colName) return { col: colName, dir: 'asc' };
      if (prev.dir === 'asc') return { col: colName, dir: 'desc' };
      return null;
    });
  };

  const applyFilters = () => {
    setPage(0);
    setAppliedFilters(columns.map((c) => ({ col: c, value: filters[c] ?? '' })).filter((f) => f.value.trim() !== ''));
  };

  // selection + copy
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
  const selectCell = (r: number, c: number, shift: boolean) =>
    setSel((prev) => (shift && prev ? { ...prev, r2: r, c2: c } : { r1: r, c1: c, r2: r, c2: c }));
  const selectRow = (r: number, shift: boolean) => {
    const last = columns.length - 1;
    setSel((prev) => (shift && prev ? { r1: prev.r1, c1: 0, r2: r, c2: last } : { r1: r, c1: 0, r2: r, c2: last }));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      if (!sel) return;
      const b = bounds(sel);
      const grid: unknown[][] = [];
      for (let r = b.r0; r <= b.r1; r++) {
        const row: unknown[] = [];
        for (let c = b.c0; c <= b.c1; c++) row.push(rows[r]?.[c]);
        grid.push(row);
      }
      void navigator.clipboard.writeText(toTsv(grid));
    }
  };

  const noPk = useMemo(() => pkCols.length === 0, [pkCols]);

  return (
    <div className="tdv">
      <div className="tdv-head">
        <div className="tdv-title">
          데이터 · <span className="mono">{table}</span>
          {noPk && <span className="tdv-badge" title="고유 키가 없어 편집할 수 없습니다">읽기 전용 (PK 없음)</span>}
        </div>
        <div className="tdv-head-actions">
          <button className="icon-btn" title="새로고침" onClick={() => void fetchPage()}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
          <div className="grid-export">
            <button className="btn btn-secondary btn-xs" disabled={rows.length === 0} onClick={() => setMenuOpen((o) => !o)}>
              <Download size={12} /> 내보내기 ▾
            </button>
            {menuOpen && (
              <div className="grid-export-menu" onMouseLeave={() => setMenuOpen(false)}>
                <button onClick={() => { download(`${table}-${tsTimestamp()}.csv`, toCsv(columns, rows), 'text/csv'); setMenuOpen(false); }}>CSV</button>
                <button onClick={() => { download(`${table}-${tsTimestamp()}.json`, toJson(columns, rows), 'application/json'); setMenuOpen(false); }}>JSON</button>
              </div>
            )}
          </div>
          <button className="btn btn-secondary btn-xs" onClick={onClose}><X size={13} /> 쿼리로 돌아가기</button>
        </div>
      </div>

      {error && (
        <div className="alert error"><AlertTriangle size={14} /><span>{error}</span></div>
      )}

      <div className="grid" tabIndex={0} onKeyDown={onKeyDown}>
        <div className="grid-head">
          <div className="grid-idx">#</div>
          {columns.map((col, idx) => (
            <div key={idx} className="grid-cell grid-head-cell" title={col} onClick={() => toggleSort(col)}>
              {col}
              {orderBy && orderBy.col === col ? (orderBy.dir === 'asc' ? ' ▲' : ' ▼') : ''}
            </div>
          ))}
        </div>

        <div className="grid-filter-row">
          <div className="grid-idx"><Search size={12} /></div>
          {columns.map((col, idx) => (
            <div key={idx} className="grid-cell">
              <input
                className="input tdv-filter-input"
                value={filters[col] ?? ''}
                placeholder="필터…"
                onChange={(e) => setFilters((f) => ({ ...f, [col]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
                onBlur={applyFilters}
              />
            </div>
          ))}
        </div>

        <div className="grid-body" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          {rows.length === 0 ? (
            <div className="grid-empty">{loading ? '로딩…' : 'No rows.'}</div>
          ) : (
            <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
              {visible.map((row, ri) => {
                const r = start + ri;
                return (
                  <div
                    key={r}
                    className={`grid-row ${r % 2 === 0 ? 'even' : 'odd'}`}
                    style={{ position: 'absolute', top: `${r * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px`, left: 0, right: 0, display: 'flex' }}
                  >
                    <div className="grid-idx" onMouseDown={(e) => selectRow(r, e.shiftKey)}>{page * PAGE_SIZE + r + 1}</div>
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
          <div className="tdv-pager">
            <button className="icon-btn" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft size={14} /></button>
            <span>페이지 {page + 1}</span>
            <button className="icon-btn" disabled={!hasNext || loading} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></button>
          </div>
          <span>{rows.length.toLocaleString()} rows · {columns.length} columns</span>
        </div>
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
git add apps/renderer/src/components/TableDataView.tsx
git commit -m "feat(grid): add TableDataView (paginated server-side sort/filter, read-only)"
```

---

## Task 5: SchemaExplorer 더블클릭 + App 배선 + CSS

**Files:**
- Modify: `apps/renderer/src/components/SchemaExplorer.tsx`
- Modify: `apps/renderer/src/App.tsx`
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: SchemaExplorer — onOpenTableData prop + 테이블 더블클릭**

READ the file. Add `onOpenTableData?: (db: string, table: string) => void;` to `SchemaExplorerProps`, and add it to the destructured props in the component signature (alongside `onSchemaChanged`).

Find the table row element (the one with `onClick={() => toggleTable(db.name, table.name)}` and `onContextMenu={(e) => openMenu(e, db.name, table.name)}`) and add a double-click handler:
```tsx
                      onDoubleClick={() => onOpenTableData?.(db.name, table.name)}
```
(Keep the existing `onClick` and `onContextMenu`.)

- [ ] **Step 2: App — openTable state + pass onOpenTableData + render branch**

READ `App.tsx`. Add the import near the other component imports:
```tsx
import { TableDataView } from './components/TableDataView';
```
Add state near the other top-level App `useState`s (e.g. by `schemaVersion`):
```tsx
  const [openTable, setOpenTable] = useState<Record<string, { db: string; table: string } | null>>({});
```
On the `<SchemaExplorer .../>` element (the one with `profileId={p.id!}`), add:
```tsx
                            onOpenTableData={(db, table) => setOpenTable((prev) => ({ ...prev, [p.id!]: { db, table } }))}
```
In the main-panel render (the per-connection block at [App.tsx:547](apps/renderer/src/App.tsx#L547)), change the SQL branch so an open table shows the data view. Replace:
```tsx
                  {profile.driver === 'redis' ? (
                    <RedisValueInspector profileId={id} redisKey={redisKeys[id] ?? null} />
                  ) : (
                    <QueryEditor
                      profileId={id}
                      driver={profile.driver}
                      database={profile.database}
                      connectionName={profile.name}
                      onQueryExecuted={() => setHistoryTrigger((n) => n + 1)}
                      loadTriggerQuery={focused ? selectedQueryText : ''}
                      schemaVersion={schemaVersion}
                    />
                  )}
```
with:
```tsx
                  {profile.driver === 'redis' ? (
                    <RedisValueInspector profileId={id} redisKey={redisKeys[id] ?? null} />
                  ) : openTable[id] ? (
                    <TableDataView
                      profileId={id}
                      driver={profile.driver as 'mysql' | 'postgres'}
                      database={openTable[id]!.db}
                      table={openTable[id]!.table}
                      onClose={() => setOpenTable((prev) => ({ ...prev, [id]: null }))}
                    />
                  ) : (
                    <QueryEditor
                      profileId={id}
                      driver={profile.driver}
                      database={profile.database}
                      connectionName={profile.name}
                      onQueryExecuted={() => setHistoryTrigger((n) => n + 1)}
                      loadTriggerQuery={focused ? selectedQueryText : ''}
                      schemaVersion={schemaVersion}
                    />
                  )}
```

- [ ] **Step 3: CSS** — append to `App.css`:

```css
/* Table data view */
.tdv {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.tdv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tdv-title {
  font-size: 13px;
  font-weight: 600;
}
.tdv-badge {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--amber);
  background: var(--amber-soft);
  padding: 2px 7px;
  border-radius: 999px;
}
.tdv-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.grid-filter-row {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.grid-filter-row .grid-cell {
  padding: 2px 4px;
}
.tdv-filter-input {
  width: 100%;
  height: 22px;
  font-size: 11px;
  padding: 0 6px;
}
.tdv-pager {
  display: flex;
  align-items: center;
  gap: 8px;
}
```
> 변수(`--border`, `--amber`, `--amber-soft`, `--bg-panel`)가 App.css에 있는지 grep으로 확인하고 없으면 가까운 토큰으로 대체(보고).

- [ ] **Step 4: Typecheck & build**

Run: `cd apps/renderer && npx tsc --noEmit && npm run build`
Expected: no errors, build success.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/components/SchemaExplorer.tsx apps/renderer/src/App.tsx apps/renderer/src/App.css
git commit -m "feat(grid): open table data view on double-click (paginated read-only)"
```

---

## Task 6: 전체 테스트 + 빌드 + CDP 검증

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: Unit tests + typecheck + build**

```bash
cd apps/renderer
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run        # tableQuery + gridFormat 포함 전체 green
npx tsc --noEmit
npm run build
```

- [ ] **Step 2: 라이브 DB 확인** — `docker ps`로 `dev-mysql` 확인. (dev-mysql `devdb.demo_users` 3행 사용; 읽기 전용이라 데이터 변동 없음.)

- [ ] **Step 3: CDP 실제 검증** (`--remote-debugging-port=9222`, mysql 연결, 스키마 트리에서 devdb 펼침)

1. `demo_users` 행 **더블클릭** → 메인 패널이 데이터 뷰로 전환, 헤더/행 표시 확인.
2. **정렬**: `name` 헤더 클릭 → ▲(서버 ORDER BY ASC, offset 0) 결과 확인, 다시 클릭 → ▼, 한 번 더 → 해제.
3. **필터**: `name` 컬럼 필터 입력에 한 글자 입력 후 Enter → 행 수 감소 확인.
4. **페이지네이션**: PAGE_SIZE보다 적은 데이터라 "다음" 비활성. (선택) 임시로 PAGE_SIZE를 2로 낮춰 빌드 후 다음/이전 동작 확인 — 확인 후 200으로 되돌리고 커밋하지 않음. 또는 행이 많은 테이블에서 확인.
5. **복사/선택/내보내기**: 셀 클릭 → `.grid-cell.sel`, 내보내기 메뉴 CSV/JSON 노출.
6. **돌아가기**: "쿼리로 돌아가기" → QueryEditor로 복귀 확인.
7. **PK 없는 테이블**: (verify-pg 또는 임시 PK 없는 테이블) → "읽기 전용 (PK 없음)" 배지 표시 확인.
8. `/tmp/*.mjs` 정리. (읽기 전용이라 DB 원상복구 불필요.)

---

## Self-Review (작성자 체크리스트 — 완료)

- **스펙 커버리지(Phase 2):** 테이블 더블클릭→데이터 뷰(Task 5), 서버 페이지네이션(Task 1,4), 서버 정렬(Task 1,4), 서버 필터(Task 1,4), 표시/선택/복사/내보내기 재사용(Task 2,4), PK 감지+읽기전용 배지(Task 4, Phase 3 편집 준비), 백엔드 무변경 — 모두 매핑.
- **플레이스홀더:** 없음.
- **타입 일관성:** `buildWhere`/`buildSelectPage`/`ColFilter`/`OrderBy`/`PageQuery`, `runSelect`/`SelectResult`, `cellText`/`tsTimestamp`/`download`, `TableDataView` props, `onOpenTableData`, `openTable` 상태가 태스크 간 일치. `quoteIdent`/`Driver`는 기존 `ddlBuilder`에서 재사용.
