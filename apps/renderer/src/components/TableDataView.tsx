import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Download, AlertTriangle, ChevronLeft, ChevronRight, Search, Plus, Trash2, Save, Undo2, Pin, PinOff } from 'lucide-react';
import type { ColumnInfo } from '../global';
import type { Driver } from '../lib/ddlBuilder';
import { buildSelectPage, type ColFilter, type OrderBy } from '../lib/tableQuery';
import { runSelect } from '../lib/runSelect';
import { runBatch } from '../lib/runBatch';
import { toCsv, toJson, toTsv } from '../lib/gridExport';
import { cellText, tsTimestamp, download } from '../lib/gridFormat';
import { buildUpdate, buildInsert, buildDelete, type CellValue } from '../lib/dmlBuilder';
import { classifyColumnType, coerceCellValue } from '../lib/cellTypes';
import { nextCell } from '../lib/gridNav';
import { pinLayout, PIN_W, COL_W } from '../lib/pinLayout';

interface Props {
  profileId: string;
  driver: Driver;
  database: string;
  table: string;
  onClose?: () => void;
  initialFilter?: { col: string; value: string };
  initialOrderBy?: OrderBy;
  onOpenRelated?: (table: string, refColumn: string, value: string) => void;
  // Rendered inside the query result area (not the full-panel table browser);
  // hides the "back to query" affordance.
  embedded?: boolean;
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

export const TableDataView: React.FC<Props> = ({ profileId, driver, database, table, onClose, initialFilter, initialOrderBy, onOpenRelated, embedded }) => {
  const [columns, setColumns] = useState<string[]>([]);
  const [colTypes, setColTypes] = useState<string[]>([]);
  const [pkCols, setPkCols] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [orderBy, setOrderBy] = useState<OrderBy | null>(initialOrderBy ?? null);
  const [filters, setFilters] = useState<Record<string, string>>(initialFilter ? { [initialFilter.col]: initialFilter.value } : {});
  const [appliedFilters, setAppliedFilters] = useState<ColFilter[]>(initialFilter ? [{ col: initialFilter.col, value: initialFilter.value }] : []);
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
  const gridRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Keep the (overflow-hidden) header + filter rows aligned with the body's
  // horizontal scroll so columns stay lined up when scrolling wide tables.
  const onBodyScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (headRef.current) headRef.current.scrollLeft = el.scrollLeft;
    if (filterRef.current) filterRef.current.scrollLeft = el.scrollLeft;
  };

  // Column pinning: pinned columns move to the front and stick to the left.
  const [pinned, setPinned] = useState<Set<number>>(new Set());
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; col: number } | null>(null);
  const lay = useMemo(() => pinLayout(columns.length, pinned), [columns.length, pinned]);
  // While pinning is active every column gets a fixed width so the (absolute) row
  // spans the full content width — required for pinned cells to stay sticky across
  // the whole horizontal scroll.
  const cellGeom = (origC: number, bg: string, selected = false): React.CSSProperties => {
    if (lay.stickyLeft[origC] !== undefined) {
      return { position: 'sticky', left: lay.stickyLeft[origC], zIndex: 2, flex: '0 0 auto', width: PIN_W, minWidth: PIN_W, maxWidth: PIN_W, background: selected ? undefined : bg };
    }
    if (lay.active) return { flex: `0 0 ${COL_W}px`, width: COL_W, minWidth: COL_W, maxWidth: COL_W };
    return {};
  };
  const idxStyle = (bg: string): React.CSSProperties =>
    lay.active ? { position: 'sticky', left: 0, zIndex: 3, background: bg } : {};
  const rowSpan: React.CSSProperties = lay.active ? { width: 'max-content', minWidth: '100%' } : { right: 0 };
  const togglePin = (col: number) =>
    setPinned((prev) => {
      const next = new Set(prev);
      next.has(col) ? next.delete(col) : next.add(col);
      return next;
    });
  // Reset pins only when the actual column set changes (not on page/refresh).
  const colKey = columns.join('');
  useEffect(() => {
    setPinned(new Set());
  }, [colKey]);
  useEffect(() => {
    if (!headerMenu) return;
    const close = () => setHeaderMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHeaderMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [headerMenu]);
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
        setColTypes(cols.map((c) => c.type));
        setPkCols(cols.filter((c) => c.primaryKey).map((c) => c.name));
      } catch (e: any) {
        if (!ignore) setError(e?.message || 'Failed to describe table');
      }
    })();
    return () => {
      ignore = true;
    };
  }, [profileId, database, table]);

  const [fks, setFks] = useState<Record<string, { refTable: string; refColumn: string }>>({});
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await window.electronAPI.listForeignKeys(profileId, database, table);
        if (!ignore && res.success && res.data) {
          const m: Record<string, { refTable: string; refColumn: string }> = {};
          for (const fk of res.data) m[fk.column] = { refTable: fk.refTable, refColumn: fk.refColumn };
          setFks(m);
        }
      } catch { /* ignore — FK links are optional */ }
    })();
    return () => { ignore = true; };
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
  // Scroll the body so the given (virtualized) row is fully visible.
  const ensureVisible = (r: number) => {
    const el = bodyRef.current;
    if (!el) return;
    const top = r * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Let inputs (filter row, new-row cells, cell editor) handle their own keys —
    // don't hijack Tab/arrows for grid-cell navigation while typing in a field.
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (editing) return; // the cell input handles its own keys while editing
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
      return;
    }
    if (rows.length === 0 || columns.length === 0) return;
    // Enter starts editing the active cell.
    if (e.key === 'Enter' && sel) {
      e.preventDefault();
      startEdit(sel.r2, sel.c2);
      return;
    }
    if (!sel) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'].includes(e.key)) {
        e.preventDefault();
        setSel({ r1: 0, c1: 0, r2: 0, c2: 0 });
        ensureVisible(0);
      }
      return;
    }
    const pageRows = Math.max(1, Math.floor(containerHeight / ROW_HEIGHT) - 1);
    const nc = nextCell({ r: sel.r2, c: sel.c2 }, e.key, e.shiftKey, rows.length - 1, columns.length - 1, pageRows);
    if (!nc) return;
    e.preventDefault();
    const extend = e.shiftKey && e.key !== 'Tab';
    setSel((prev) => (extend && prev ? { ...prev, r2: nc.r, c2: nc.c } : { r1: nc.r, c1: nc.c, r2: nc.r, c2: nc.c }));
    ensureVisible(nc.r);
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
    // Coerce the typed text to the column's value category (number/boolean →
    // unquoted literal). Empty text is an empty string, NOT null — use the NULL
    // button to set null explicitly.
    const value: CellValue = coerceCellValue(classifyColumnType(colTypes[c] ?? ''), editText);
    setEdits((prev) => ({ ...prev, [r]: { ...(prev[r] ?? {}), [c]: value } }));
    setEditing(null);
  };
  // Commit the current edit, then advance the selection (Enter → down, Tab →
  // right/left) and return focus to the grid so navigation continues.
  const commitAndMove = (key: 'Enter' | 'Tab', shiftKey: boolean) => {
    if (!editing) return;
    const { r, c } = editing;
    commitEdit();
    const pageRows = Math.max(1, Math.floor(containerHeight / ROW_HEIGHT) - 1);
    const nc = nextCell({ r, c }, key === 'Enter' ? 'ArrowDown' : 'Tab', shiftKey, rows.length - 1, columns.length - 1, pageRows);
    if (nc) {
      setSel({ r1: nc.r, c1: nc.c, r2: nc.r, c2: nc.c });
      ensureVisible(nc.r);
    }
    requestAnimationFrame(() => gridRef.current?.focus());
  };
  const commitNull = () => {
    if (!editing) return;
    const { r, c } = editing;
    setEdits((prev) => ({ ...prev, [r]: { ...(prev[r] ?? {}), [c]: null } }));
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
        .map((cStr) => {
          const c = Number(cStr);
          return { col: columns[c], value: coerceCellValue(classifyColumnType(colTypes[c] ?? ''), nr[c]) };
        });
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
    const res = await runBatch(profileId, stmts);
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
          {!embedded && onClose && (
            <button className="btn btn-secondary btn-xs" onClick={onClose}><X size={13} /> 쿼리로 돌아가기</button>
          )}
        </div>
      </div>

      {error && (
        <div className="alert error"><AlertTriangle size={14} /><span style={{ whiteSpace: 'pre-wrap' }}>{error}</span></div>
      )}

      <div className="grid" tabIndex={0} ref={gridRef} onKeyDown={onKeyDown}>
        <div className="grid-head" ref={headRef}>
          <div className="grid-idx" style={idxStyle('var(--bg-panel-2)')}>#</div>
          {lay.order.map((idx) => {
            const col = columns[idx];
            return (
              <div
                key={idx}
                className={`grid-cell grid-head-cell ${pinned.has(idx) ? 'pinned' : ''}`}
                style={cellGeom(idx, 'var(--bg-panel-2)')}
                title={hasPending ? '저장 또는 되돌리기 후 정렬' : col}
                onClick={() => toggleSort(col)}
                onContextMenu={(e) => { e.preventDefault(); setHeaderMenu({ x: e.clientX, y: e.clientY, col: idx }); }}
              >
                {pinned.has(idx) && <Pin size={11} className="pin-mark" />}
                {col}
                {orderBy && orderBy.col === col ? (orderBy.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </div>
            );
          })}
        </div>

        <div className="grid-filter-row" ref={filterRef}>
          <div className="grid-idx" style={idxStyle('var(--bg-panel)')}><Search size={12} /></div>
          {lay.order.map((idx) => {
            const col = columns[idx];
            return (
              <div key={idx} className={`grid-cell ${pinned.has(idx) ? 'pinned' : ''}`} style={cellGeom(idx, 'var(--bg-panel)')}>
                <input
                  className="input tdv-filter-input"
                  value={filters[col] ?? ''}
                  placeholder="필터…"
                  onChange={(e) => setFilters((f) => ({ ...f, [col]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
                  onBlur={applyFilters}
                />
              </div>
            );
          })}
        </div>

        <div className="grid-body" ref={bodyRef} onScroll={onBodyScroll}>
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
                    style={{ position: 'absolute', top: `${r * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px`, left: 0, display: 'flex', ...rowSpan }}
                  >
                    <div className="grid-idx" style={idxStyle('var(--bg)')} onMouseDown={(e) => selectRow(r, e.shiftKey)}>{page * PAGE_SIZE + r + 1}</div>
                    {lay.order.map((c) => {
                      if (editing && editing.r === r && editing.c === c) {
                        return (
                          <div key={c} className={`grid-cell editing ${pinned.has(c) ? 'pinned' : ''}`} style={cellGeom(c, 'var(--bg)')}>
                            <input
                              className="input tdv-edit-input"
                              autoFocus
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); commitAndMove('Enter', e.shiftKey); }
                                else if (e.key === 'Tab') { e.preventDefault(); commitAndMove('Tab', e.shiftKey); }
                                else if (e.key === 'Escape') { setEditing(null); requestAnimationFrame(() => gridRef.current?.focus()); }
                              }}
                              onBlur={commitEdit}
                            />
                            <button
                              className="tdv-null-btn"
                              title="NULL로 설정"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                commitNull();
                              }}
                            >
                              ∅
                            </button>
                          </div>
                        );
                      }
                      const val = displayValue(r, c);
                      const isNull = val === null || val === undefined;
                      const text = cellText(val);
                      const selected = inSel(r, c);
                      return (
                        <div
                          key={c}
                          className={`grid-cell ${isNull ? 'null' : ''} ${selected ? 'sel' : ''} ${isDirty(r, c) ? 'dirty' : ''} ${pinned.has(c) ? 'pinned' : ''}`}
                          style={cellGeom(c, 'var(--bg)', selected)}
                          title={text}
                          onMouseDown={(e) => selectCell(r, c, e.shiftKey)}
                          onDoubleClick={() => startEdit(r, c)}
                        >
                          {text}
                          {fks[columns[c]] && !isNull && onOpenRelated && (
                            <button
                              className="fk-link"
                              title={`${fks[columns[c]].refTable} 행 열기`}
                              onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                              onClick={(e) => { e.stopPropagation(); onOpenRelated(fks[columns[c]].refTable, fks[columns[c]].refColumn, String(displayValue(r, c))); }}
                            >↗</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}

          {/* New rows flow directly below the data rows (inside the scroll body),
              flush with the table and styled like grid rows. */}
          {newRows.length > 0 && (
            <div className="tdv-newrows">
              {newRows.map((nr, i) => (
                <div key={i} className="grid-row new-row" style={{ display: 'flex', height: `${ROW_HEIGHT}px`, ...rowSpan }}>
                  <div className="grid-idx" style={idxStyle('var(--bg)')} title="새 행 제거" onClick={() => removeNewRow(i)}><Plus size={12} /></div>
                  {lay.order.map((c) => (
                    <div key={c} className={`grid-cell ${pinned.has(c) ? 'pinned' : ''}`} style={cellGeom(c, 'var(--bg)')}>
                      <input
                        className="tdv-new-input"
                        value={nr[c] ?? ''}
                        placeholder={columns[c]}
                        onChange={(e) => patchNewRow(i, c, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid-foot">
          <div className="tdv-pager">
            <button className="icon-btn" disabled={page === 0 || loading || hasPending} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft size={14} /></button>
            <span>페이지 {page + 1}</span>
            <button className="icon-btn" disabled={!hasNext || loading || hasPending} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></button>
          </div>
          <span>{rows.length.toLocaleString()} rows · {columns.length} columns</span>
        </div>
      </div>

      {headerMenu && (
        <div className="ctx-menu" style={{ top: headerMenu.y, left: headerMenu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { togglePin(headerMenu.col); setHeaderMenu(null); }}>
            {pinned.has(headerMenu.col) ? <><PinOff size={13} /> 열 고정 해제</> : <><Pin size={13} /> 열 고정</>}
          </button>
        </div>
      )}

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
