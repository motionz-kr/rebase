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
