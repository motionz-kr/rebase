# 결과 그리드 Phase 3 (인라인 데이터 편집) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 테이블 데이터 뷰에서 셀 수정·행 추가·행 삭제를 하고, PK 기반 UPDATE/INSERT/DELETE를 생성해 미리보기 후 저장한다(PK 있는 테이블만).

**Architecture:** 순수 `dmlBuilder.ts`(값 리터럴 방언별 이스케이프 + UPDATE/INSERT/DELETE, TDD)를 만들고, `TableDataView`에 보류(dirty) 편집 상태(셀 수정/삭제 표시/새 행)를 추가한다. 저장 시 보류 변경을 DML 문장 목록으로 변환→미리보기→기존 `runDdl`(allowWrite)로 순차 실행→현재 페이지 재조회. 백엔드 변경 없음.

**Tech Stack:** React 19 + TypeScript, vitest, lucide-react, 기존 `runDdl`.

> git 저장소(브랜치 `feat/grid-data-features`). 각 Task의 Commit 스텝 수행. bash 앞에 `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`. 테스트/빌드는 `apps/renderer`.

---

## File Structure

- **신규** `apps/renderer/src/lib/dmlBuilder.ts` (+test) — `sqlLiteral`/`buildUpdate`/`buildInsert`/`buildDelete`.
- **수정** `apps/renderer/src/components/TableDataView.tsx` — 편집 상태 + 셀 편집/삭제/추가 UI + 저장.
- **수정** `apps/renderer/src/App.css` — 편집 셀/삭제 행/새 행/미리보기 스타일.
- 재사용: `lib/ddlBuilder.ts`의 `quoteIdent`/`Driver`, `lib/runDdl.ts`.

## v1 편집 규칙 (결정 사항)

- **PK 있는 테이블만** 편집 가능(없으면 기존 "읽기 전용 (PK 없음)" 배지, 편집 비활성).
- 셀을 **비우면 NULL**, 값을 입력하면 문자열 리터럴(숫자/날짜 컬럼은 DB가 암시적 캐스트). v1에서 빈 문자열 `''`을 명시적으로 넣거나 리터럴 문자열 "NULL"을 넣는 것은 SQL 에디터로(인라인 편집 한계 — 문서화).
- **행 추가**: 빈 새 행을 하단에 추가, 비어 있는 셀은 INSERT에서 **생략**(DB 기본값/자동증가 적용).
- **행 삭제**: 행(`#`) 선택 후 "삭제 표시" 버튼 → 보류 DELETE.
- **보류 변경이 있으면** 정렬/필터/페이지 이동을 막는다(먼저 저장 또는 되돌리기). 안전을 위해.
- 저장 순서: DELETE → UPDATE → INSERT. 실패 시 어느 문장에서 실패했는지 + 엔진 에러 표시, 보류 유지.

---

## Task 1: dmlBuilder — sqlLiteral / update / insert / delete (TDD)

**Files:**
- Create: `apps/renderer/src/lib/dmlBuilder.ts`
- Test: `apps/renderer/src/lib/dmlBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/renderer/src/lib/dmlBuilder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sqlLiteral, buildUpdate, buildInsert, buildDelete } from './dmlBuilder';

describe('sqlLiteral', () => {
  it('renders null as NULL', () => {
    expect(sqlLiteral('mysql', null)).toBe('NULL');
  });
  it('renders numbers literally', () => {
    expect(sqlLiteral('mysql', 42)).toBe('42');
    expect(sqlLiteral('postgres', -3.5)).toBe('-3.5');
  });
  it('renders booleans per dialect', () => {
    expect(sqlLiteral('mysql', true)).toBe('1');
    expect(sqlLiteral('mysql', false)).toBe('0');
    expect(sqlLiteral('postgres', true)).toBe('TRUE');
    expect(sqlLiteral('postgres', false)).toBe('FALSE');
  });
  it('single-quotes strings and doubles embedded quotes', () => {
    expect(sqlLiteral('postgres', "a'b")).toBe("'a''b'");
  });
  it('escapes backslash for mysql but not postgres', () => {
    expect(sqlLiteral('mysql', 'a\\b')).toBe("'a\\\\b'");
    expect(sqlLiteral('postgres', 'a\\b')).toBe("'a\\b'");
  });
});

describe('buildUpdate', () => {
  it('builds an UPDATE with SET and PK WHERE (mysql)', () => {
    expect(
      buildUpdate('mysql', 'users', [{ col: 'id', value: 5 }], [{ col: 'name', value: 'Al' }, { col: 'age', value: null }])
    ).toBe("UPDATE `users` SET `name` = 'Al', `age` = NULL WHERE `id` = 5");
  });
  it('supports composite PK (postgres)', () => {
    expect(
      buildUpdate('postgres', 't', [{ col: 'a', value: 1 }, { col: 'b', value: 2 }], [{ col: 'v', value: 'x' }])
    ).toBe(`UPDATE "t" SET "v" = 'x' WHERE "a" = 1 AND "b" = 2`);
  });
});

describe('buildInsert', () => {
  it('builds an INSERT with only the provided columns', () => {
    expect(
      buildInsert('mysql', 'users', [{ col: 'name', value: 'Al' }, { col: 'active', value: true }])
    ).toBe("INSERT INTO `users` (`name`, `active`) VALUES ('Al', 1)");
  });
});

describe('buildDelete', () => {
  it('builds a DELETE by PK (postgres, composite)', () => {
    expect(
      buildDelete('postgres', 't', [{ col: 'a', value: 1 }, { col: 'b', value: "x'y" }])
    ).toBe(`DELETE FROM "t" WHERE "a" = 1 AND "b" = 'x''y'`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/dmlBuilder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`apps/renderer/src/lib/dmlBuilder.ts`:

```ts
import { quoteIdent, type Driver } from './ddlBuilder';

export type CellValue = string | number | boolean | null;

export interface ColValue {
  col: string;
  value: CellValue;
}

// Render a value as a SQL literal, dialect-aware. Strings are single-quoted with
// the quote doubled; MySQL also escapes backslash (it treats \ as a string-literal
// escape), Postgres (standard_conforming_strings) does not.
export function sqlLiteral(driver: Driver, value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return driver === 'mysql' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  let s = value.replace(/'/g, "''");
  if (driver === 'mysql') s = s.replace(/\\/g, '\\\\');
  return `'${s}'`;
}

export function buildUpdate(driver: Driver, table: string, pk: ColValue[], changes: ColValue[]): string {
  const set = changes.map((c) => `${quoteIdent(driver, c.col)} = ${sqlLiteral(driver, c.value)}`).join(', ');
  const where = pk.map((c) => `${quoteIdent(driver, c.col)} = ${sqlLiteral(driver, c.value)}`).join(' AND ');
  return `UPDATE ${quoteIdent(driver, table)} SET ${set} WHERE ${where}`;
}

export function buildInsert(driver: Driver, table: string, cols: ColValue[]): string {
  const names = cols.map((c) => quoteIdent(driver, c.col)).join(', ');
  const vals = cols.map((c) => sqlLiteral(driver, c.value)).join(', ');
  return `INSERT INTO ${quoteIdent(driver, table)} (${names}) VALUES (${vals})`;
}

export function buildDelete(driver: Driver, table: string, pk: ColValue[]): string {
  const where = pk.map((c) => `${quoteIdent(driver, c.col)} = ${sqlLiteral(driver, c.value)}`).join(' AND ');
  return `DELETE FROM ${quoteIdent(driver, table)} WHERE ${where}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/dmlBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/dmlBuilder.ts apps/renderer/src/lib/dmlBuilder.test.ts
git commit -m "feat(grid): add dmlBuilder (sqlLiteral + update/insert/delete)"
```

---

## Task 2: TableDataView 인라인 편집

**Files:**
- Modify: `apps/renderer/src/components/TableDataView.tsx` (full replacement)

- [ ] **Step 1: Replace the file** with the editing-enabled version

Replace the entire contents of `apps/renderer/src/components/TableDataView.tsx` with:

```tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Download, AlertTriangle, ChevronLeft, ChevronRight, Search, Plus, Trash2, Save, Undo2 } from 'lucide-react';
import type { ColumnInfo } from '../global';
import type { Driver } from '../lib/ddlBuilder';
import { buildSelectPage, type ColFilter, type OrderBy } from '../lib/tableQuery';
import { runSelect } from '../lib/runSelect';
import { runDdl } from '../lib/runDdl';
import { toCsv, toJson, toTsv } from '../lib/gridExport';
import { cellText, tsTimestamp, download } from '../lib/gridFormat';
import { buildUpdate, buildInsert, buildDelete, type CellValue } from '../lib/dmlBuilder';

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

// Coerce an arbitrary cell value from the DB into a SQL-literal-able CellValue.
function asCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

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

  // editing state
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [editText, setEditText] = useState('');
  const [edits, setEdits] = useState<Record<number, Record<number, CellValue>>>({});
  const [deletes, setDeletes] = useState<Set<number>>(new Set());
  const [newRows, setNewRows] = useState<Array<Record<number, string>>>([]);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(300);
  const reqRef = useRef(0);

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

  const clearPending = () => {
    setEdits({});
    setDeletes(new Set());
    setNewRows([]);
    setEditing(null);
  };

  const fetchPage = useCallback(async () => {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    const sql = buildSelectPage(driver, table, {
      filters: appliedFilters,
      orderBy,
      limit: PAGE_SIZE + 1,
      offset: page * PAGE_SIZE,
    });
    const res = await runSelect(profileId, sql);
    if (myReq !== reqRef.current) return;
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

  const noPk = useMemo(() => pkCols.length === 0, [pkCols]);
  const editable = !noPk;
  const pendingCount = useMemo(
    () => Object.values(edits).reduce((n, r) => n + Object.keys(r).length, 0) + deletes.size + newRows.length,
    [edits, deletes, newRows]
  );
  const hasPending = pendingCount > 0;

  const totalHeight = rows.length * ROW_HEIGHT;
  const buffer = 6;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - buffer);
  const end = Math.min(rows.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + buffer);
  const visible = rows.slice(start, end);

  const toggleSort = (colName: string) => {
    if (hasPending) return;
    setPage(0);
    setOrderBy((prev) => {
      if (!prev || prev.col !== colName) return { col: colName, dir: 'asc' };
      if (prev.dir === 'asc') return { col: colName, dir: 'desc' };
      return null;
    });
  };

  const applyFilters = () => {
    if (hasPending) return;
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
        for (let c = b.c0; c <= b.c1; c++) row.push(displayValue(r, c));
        grid.push(row);
      }
      void navigator.clipboard.writeText(toTsv(grid));
    }
  };

  // ---- editing ----
  const displayValue = (r: number, c: number): unknown => {
    const e = edits[r];
    if (e && c in e) return e[c];
    return rows[r]?.[c];
  };
  const isDirty = (r: number, c: number) => !!edits[r] && c in edits[r];

  const startEdit = (r: number, c: number) => {
    if (!editable || deletes.has(r)) return;
    const v = displayValue(r, c);
    setEditText(v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    setEditing({ r, c });
  };
  const commitEdit = () => {
    if (!editing) return;
    const { r, c } = editing;
    const value: CellValue = editText === '' ? null : editText;
    setEdits((prev) => ({ ...prev, [r]: { ...(prev[r] ?? {}), [c]: value } }));
    setEditing(null);
  };

  const markDelete = () => {
    if (!sel) return;
    const b = bounds(sel);
    setDeletes((prev) => {
      const next = new Set(prev);
      for (let r = b.r0; r <= b.r1; r++) next.add(r);
      return next;
    });
  };
  const addRow = () => setNewRows((prev) => [...prev, {}]);
  const removeNewRow = (i: number) => setNewRows((prev) => prev.filter((_, idx) => idx !== i));
  const patchNewRow = (i: number, c: number, text: string) =>
    setNewRows((prev) => prev.map((nr, idx) => (idx === i ? { ...nr, [c]: text } : nr)));

  const pendingStatements = (): string[] => {
    const stmts: string[] = [];
    const pkOf = (r: number) => pkCols.map((col) => ({ col, value: asCell(rows[r][columns.indexOf(col)]) }));
    for (const r of deletes) stmts.push(buildDelete(driver, table, pkOf(r)));
    for (const rStr of Object.keys(edits)) {
      const r = Number(rStr);
      if (deletes.has(r)) continue;
      const rowEdits = edits[r];
      const changes = Object.keys(rowEdits).map((cStr) => ({ col: columns[Number(cStr)], value: rowEdits[Number(cStr)] }));
      if (changes.length === 0) continue;
      stmts.push(buildUpdate(driver, table, pkOf(r), changes));
    }
    for (const nr of newRows) {
      const cols = Object.keys(nr)
        .filter((cStr) => nr[Number(cStr)] !== '')
        .map((cStr) => ({ col: columns[Number(cStr)], value: nr[Number(cStr)] as CellValue }));
      if (cols.length === 0) continue;
      stmts.push(buildInsert(driver, table, cols));
    }
    return stmts;
  };

  const save = async () => {
    const stmts = pendingStatements();
    if (stmts.length === 0) return;
    setSaving(true);
    setError(null);
    const res = await runDdl(profileId, stmts);
    setSaving(false);
    if (res.ok) {
      setPreview(null);
      clearPending();
      void fetchPage();
    } else {
      setError(`저장 실패: ${res.error}\n문장: ${res.failedStatement ?? ''}`);
      setPreview(null);
    }
  };

  return (
    <div className="tdv">
      <div className="tdv-head">
        <div className="tdv-title">
          데이터 · <span className="mono">{table}</span>
          {noPk && <span className="tdv-badge" title="고유 키가 없어 편집할 수 없습니다">읽기 전용 (PK 없음)</span>}
          {hasPending && <span className="tdv-badge pending">보류 변경 {pendingCount}</span>}
        </div>
        <div className="tdv-head-actions">
          {editable && (
            <>
              <button className="btn btn-secondary btn-xs" onClick={addRow}><Plus size={12} /> 행 추가</button>
              <button className="btn btn-secondary btn-xs" disabled={!sel} onClick={markDelete}><Trash2 size={12} /> 삭제 표시</button>
              <button className="btn btn-secondary btn-xs" disabled={!hasPending || saving} onClick={clearPending}><Undo2 size={12} /> 되돌리기</button>
              <button className="btn btn-primary btn-xs" disabled={!hasPending || saving} onClick={() => setPreview(pendingStatements())}><Save size={12} /> 저장</button>
            </>
          )}
          <button className="icon-btn" title="새로고침" disabled={hasPending} onClick={() => void fetchPage()}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
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
        <div className="alert error"><AlertTriangle size={14} /><span style={{ whiteSpace: 'pre-wrap' }}>{error}</span></div>
      )}

      <div className="grid" tabIndex={0} onKeyDown={onKeyDown}>
        <div className="grid-head">
          <div className="grid-idx">#</div>
          {columns.map((col, idx) => (
            <div key={idx} className="grid-cell grid-head-cell" title={hasPending ? '저장 또는 되돌리기 후 정렬' : col} onClick={() => toggleSort(col)}>
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
              {visible.map((_, ri) => {
                const r = start + ri;
                const del = deletes.has(r);
                return (
                  <div
                    key={r}
                    className={`grid-row ${r % 2 === 0 ? 'even' : 'odd'} ${del ? 'row-del' : ''}`}
                    style={{ position: 'absolute', top: `${r * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px`, left: 0, right: 0, display: 'flex' }}
                  >
                    <div className="grid-idx" onMouseDown={(e) => selectRow(r, e.shiftKey)}>{page * PAGE_SIZE + r + 1}</div>
                    {columns.map((_, c) => {
                      if (editing && editing.r === r && editing.c === c) {
                        return (
                          <div key={c} className="grid-cell editing">
                            <input
                              className="input tdv-edit-input"
                              autoFocus
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitEdit();
                                else if (e.key === 'Escape') setEditing(null);
                              }}
                              onBlur={commitEdit}
                            />
                          </div>
                        );
                      }
                      const val = displayValue(r, c);
                      const isNull = val === null || val === undefined;
                      const text = cellText(val);
                      return (
                        <div
                          key={c}
                          className={`grid-cell ${isNull ? 'null' : ''} ${inSel(r, c) ? 'sel' : ''} ${isDirty(r, c) ? 'dirty' : ''}`}
                          title={text}
                          onMouseDown={(e) => selectCell(r, c, e.shiftKey)}
                          onDoubleClick={() => startEdit(r, c)}
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

        {newRows.length > 0 && (
          <div className="tdv-newrows">
            {newRows.map((nr, i) => (
              <div key={i} className="grid-row new-row" style={{ display: 'flex' }}>
                <div className="grid-idx" title="새 행" onClick={() => removeNewRow(i)}><Plus size={12} /></div>
                {columns.map((col, c) => (
                  <div key={c} className="grid-cell">
                    <input
                      className="input tdv-edit-input"
                      value={nr[c] ?? ''}
                      placeholder={col}
                      onChange={(e) => patchNewRow(i, c, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="grid-foot">
          <div className="tdv-pager">
            <button className="icon-btn" disabled={page === 0 || loading || hasPending} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft size={14} /></button>
            <span>페이지 {page + 1}</span>
            <button className="icon-btn" disabled={!hasNext || loading || hasPending} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></button>
          </div>
          <span>{rows.length.toLocaleString()} rows · {columns.length} columns</span>
        </div>
      </div>

      {preview && (
        <div className="modal-overlay" onClick={() => setPreview(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>변경 사항 저장</h3>
              <button className="icon-btn" onClick={() => setPreview(null)} title="Close"><X size={15} /></button>
            </div>
            <pre className="ddl-block">{preview.join(';\n') + (preview.length ? ';' : '')}</pre>
            <div className="modal-foot">
              <button className="btn btn-secondary" onClick={() => setPreview(null)}>취소</button>
              <button className="btn btn-primary" disabled={saving} onClick={save}>
                {saving ? <span className="spinner" /> : null} 실행
              </button>
            </div>
          </div>
        </div>
      )}
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
git commit -m "feat(grid): inline cell edit, row add/delete, save via DML in TableDataView"
```

---

## Task 3: CSS

**Files:**
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: Append** to `App.css`:

```css
/* Table data view — editing */
.tdv-badge.pending {
  color: var(--accent);
  background: var(--accent-soft);
}
.grid-cell.dirty {
  background: color-mix(in srgb, var(--amber) 22%, transparent);
  box-shadow: inset 0 0 0 1px var(--amber);
}
.grid-row.row-del .grid-cell {
  text-decoration: line-through;
  opacity: 0.5;
}
.grid-cell.editing {
  padding: 0;
}
.tdv-edit-input {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
  background: var(--bg-panel-2);
  box-shadow: inset 0 0 0 2px var(--accent-border);
  font-size: 12px;
  padding: 0 8px;
}
.tdv-newrows {
  border-top: 2px solid var(--accent-border);
  background: var(--accent-soft);
}
.tdv-newrows .grid-cell {
  padding: 2px 4px;
}
.tdv-newrows .grid-idx {
  cursor: pointer;
  color: var(--accent);
}
```
> 변수(`--accent`, `--accent-soft`, `--accent-border`, `--amber`, `--bg-panel-2`)가 App.css에 있는지 grep으로 확인하고 없으면 가까운 토큰으로 대체(보고). `color-mix`는 코드베이스에서 이미 사용 중(예: `.driver-chip`).

- [ ] **Step 2: Typecheck & build**

Run: `cd apps/renderer && npx tsc --noEmit && npm run build`
Expected: no errors, build success.

- [ ] **Step 3: Commit**

```bash
git add apps/renderer/src/App.css
git commit -m "style(grid): editing cell/row/new-row styles for TableDataView"
```

---

## Task 4: 전체 테스트 + 빌드 + CDP 검증

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: Unit tests + typecheck + build**

```bash
cd apps/renderer
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run        # dmlBuilder 포함 전체 green
npx tsc --noEmit
npm run build
```

- [ ] **Step 2: CDP 실제 검증** — **편집 검증은 데이터 변경이므로, 검증 후 반드시 원상복구한다.**

`dev-mysql`의 `demo_users`(id PK, name, email, active; 3행)로:
1. `demo_users` 더블클릭 → 데이터 뷰. 편집 버튼들(행 추가/삭제 표시/저장) 노출 확인(PK 있으므로).
2. **셀 수정**: `name` 셀 더블클릭 → 입력으로 'Alice2' 입력 → Enter → 셀이 dirty(노란 하이라이트), "보류 변경 1" 배지. "저장" → 미리보기에 ``UPDATE `demo_users` SET `name` = 'Alice2' WHERE `id` = ...`` 확인 → 실행 → DB에서 해당 행 name='Alice2' 확인. **그 후 원복**(name 되돌리기).
3. **행 추가**: "행 추가" → 새 행에 name='Zed', email='z@x.com' 입력 → 저장 → 미리보기 INSERT 확인 → 실행 → 행 추가 확인. **그 후 DELETE로 원복**.
4. **행 삭제**: 방금 추가한(또는 임시) 행을 `#` 클릭 선택 → "삭제 표시"(취소선) → 저장 → DELETE 실행 → 사라짐 확인.
5. **되돌리기**: 셀 수정 후 "되돌리기" → 보류 0, 하이라이트 사라짐 확인(DB 미변경).
6. **보류 가드**: 보류 변경이 있을 때 정렬 헤더 클릭/페이지 버튼이 막히는지 확인.
7. **검증 종료 시 `demo_users`를 원래의 3행(Alice/Bob/Carol, 원래 값)으로 복구**. 필요시 직접 `docker exec dev-mysql mysql ...`로 정리.
8. `/tmp/*.mjs` 정리.

- [ ] **Step 3: 사용자 DB 원상복구 최종 확인**

```bash
docker exec dev-mysql mysql -uroot -ppassword1! -e "SELECT * FROM devdb.demo_users ORDER BY id;" 2>/dev/null
# 원래의 3행이 원래 값으로 있어야 한다.
```

---

## Self-Review (작성자 체크리스트 — 완료)

- **스펙 커버리지(Phase 3):** 셀 편집(Task 1,2), 행 추가 INSERT(Task 1,2), 행 삭제 DELETE(Task 1,2), PK 기반 DML(Task 1), 값 리터럴 이스케이프(Task 1), 보류 미리보기+저장 via runDdl(Task 2), PK 없으면 읽기전용(Task 2, 기존 배지), 백엔드 무변경 — 모두 매핑.
- **플레이스홀더:** 없음.
- **타입 일관성:** `CellValue`/`ColValue`/`sqlLiteral`/`buildUpdate`/`buildInsert`/`buildDelete`, `runDdl`, `asCell`, 편집 상태(`edits`/`deletes`/`newRows`/`editing`)가 일관. 복사(`onKeyDown`)도 `displayValue`를 사용해 편집 반영. PK WHERE는 **원본** `rows[r]` 값 사용(편집 전 값)으로 정확한 행 지목.
