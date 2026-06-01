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
