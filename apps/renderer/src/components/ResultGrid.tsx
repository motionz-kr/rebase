import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Search, Pin, PinOff } from 'lucide-react';
import { toCsv, toJson, toTsv } from '../lib/gridExport';
import { sortRows, filterRows, type SortDir } from '../lib/gridView';
import { cellText, tsTimestamp, download } from '../lib/gridFormat';
import { nextCell } from '../lib/gridNav';
import { pinLayout, PIN_W, COL_W } from '../lib/pinLayout';

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


export const ResultGrid: React.FC<Props> = ({ columns, rows, rowHeight = 32 }) => {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pinned, setPinned] = useState<Set<number>>(new Set());
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; col: number } | null>(null);

  const lay = useMemo(() => pinLayout(columns.length, pinned), [columns.length, pinned]);
  // Cell geometry. While pinning is active every column gets a fixed width so the
  // row spans the full content width — that's what lets pinned cells stay sticky
  // across the whole horizontal scroll (not just the viewport width). Pinned cells
  // stick to the left; `bg` keeps them opaque unless selected (then .sel shows).
  const cellGeom = (origC: number, bg: string, selected = false): React.CSSProperties => {
    if (lay.stickyLeft[origC] !== undefined) {
      return { position: 'sticky', left: lay.stickyLeft[origC], zIndex: 2, flex: '0 0 auto', width: PIN_W, minWidth: PIN_W, maxWidth: PIN_W, background: selected ? undefined : bg };
    }
    if (lay.active) return { flex: `0 0 ${COL_W}px`, width: COL_W, minWidth: COL_W, maxWidth: COL_W };
    return {};
  };
  const idxStyle = (bg: string): React.CSSProperties =>
    lay.active ? { position: 'sticky', left: 0, zIndex: 3, background: bg } : {};
  // When pinning is active the row spans full content width so sticky has room;
  // otherwise it fills the viewport (flexible columns, original behaviour).
  const rowSpan: React.CSSProperties = lay.active ? { width: 'max-content', minWidth: '100%' } : { right: 0 };
  const togglePin = (col: number) =>
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });

  const bodyRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Keep the (overflow-hidden) header aligned with the body's horizontal scroll.
  const onBodyScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (headRef.current) headRef.current.scrollLeft = el.scrollLeft;
  };
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSel(null);
  }, [rows, filter, sort]);

  // Reset pinned columns when the column set changes (e.g. a new query).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPinned(new Set());
  }, [columns]);

  // Close the header context menu on any outside click or Escape.
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

  // Close the export menu on any outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

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

  // Scroll the body so the given (virtualized) row is fully visible.
  const ensureVisible = (r: number) => {
    const el = bodyRef.current;
    if (!el) return;
    const top = r * rowHeight;
    const bottom = top + rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Let inputs (e.g. the filter box) handle their own keys instead of hijacking
    // Tab/arrows for grid-cell navigation.
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      copySelection();
      return;
    }
    if (display.length === 0 || columns.length === 0) return;
    // First navigation key just anchors the selection at the top-left.
    if (!sel) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'].includes(e.key)) {
        e.preventDefault();
        setSel({ r1: 0, c1: 0, r2: 0, c2: 0 });
        ensureVisible(0);
      }
      return;
    }
    const pageRows = Math.max(1, Math.floor(containerHeight / rowHeight) - 1);
    const nc = nextCell({ r: sel.r2, c: sel.c2 }, e.key, e.shiftKey, display.length - 1, columns.length - 1, pageRows);
    if (!nc) return;
    e.preventDefault();
    const extend = e.shiftKey && e.key !== 'Tab'; // Tab always collapses; arrows extend with shift
    setSel((prev) => (extend && prev ? { ...prev, r2: nc.r, c2: nc.c } : { r1: nc.r, c1: nc.c, r2: nc.r, c2: nc.c }));
    ensureVisible(nc.r);
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

      <div className="grid-head" ref={headRef}>
        <div className="grid-idx" style={idxStyle('var(--bg-panel-2)')}>#</div>
        {lay.order.map((idx) => (
          <div
            key={idx}
            className={`grid-cell grid-head-cell ${pinned.has(idx) ? 'pinned' : ''}`}
            style={cellGeom(idx, 'var(--bg-panel-2)')}
            title={columns[idx]}
            onClick={() => toggleSort(idx)}
            onContextMenu={(e) => { e.preventDefault(); setHeaderMenu({ x: e.clientX, y: e.clientY, col: idx }); }}
          >
            {pinned.has(idx) && <Pin size={11} className="pin-mark" />}
            {columns[idx]}
            {sort && sort.col === idx ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
          </div>
        ))}
      </div>

      <div className="grid-body" ref={bodyRef} onScroll={onBodyScroll}>
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
                  style={{ position: 'absolute', top: `${r * rowHeight}px`, height: `${rowHeight}px`, left: 0, display: 'flex', ...rowSpan }}
                >
                  <div className="grid-idx" style={idxStyle('var(--bg)')} onMouseDown={(e) => selectRow(r, e.shiftKey)}>{r + 1}</div>
                  {lay.order.map((c) => {
                    const val = row[c];
                    const isNull = val === null || val === undefined;
                    const text = cellText(val);
                    const selected = inSel(r, c);
                    return (
                      <div
                        key={c}
                        className={`grid-cell ${isNull ? 'null' : ''} ${selected ? 'sel' : ''} ${pinned.has(c) ? 'pinned' : ''}`}
                        style={cellGeom(c, 'var(--bg)', selected)}
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

      {headerMenu && (
        <div className="ctx-menu" style={{ top: headerMenu.y, left: headerMenu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { togglePin(headerMenu.col); setHeaderMenu(null); }}>
            {pinned.has(headerMenu.col) ? <><PinOff size={13} /> 열 고정 해제</> : <><Pin size={13} /> 열 고정</>}
          </button>
        </div>
      )}
    </div>
  );
};
