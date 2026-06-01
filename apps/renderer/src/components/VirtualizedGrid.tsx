import React, { useState, useRef, useEffect } from 'react';

interface VirtualizedGridProps {
  columns: string[];
  rows: any[][];
  rowHeight?: number;
}

export const VirtualizedGrid: React.FC<VirtualizedGridProps> = ({ columns, rows, rowHeight = 32 }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(300);

  useEffect(() => {
    if (containerRef.current) {
      setContainerHeight(containerRef.current.clientHeight);
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerHeight(entry.contentRect.height);
        }
      });
      resizeObserver.observe(containerRef.current);
      return () => resizeObserver.disconnect();
    }
  }, []);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  const totalHeight = rows.length * rowHeight;
  const buffer = 6;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
  const endIndex = Math.min(rows.length, Math.ceil((scrollTop + containerHeight) / rowHeight) + buffer);
  const visibleRows = rows.slice(startIndex, endIndex);

  return (
    <div className="grid">
      <div className="grid-head">
        <div className="grid-idx">#</div>
        {columns.map((col, idx) => (
          <div key={idx} className="grid-cell" title={col}>
            {col}
          </div>
        ))}
      </div>

      <div className="grid-body" ref={containerRef} onScroll={handleScroll}>
        {rows.length === 0 ? (
          <div className="grid-empty">No rows.</div>
        ) : (
          <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
            {visibleRows.map((row, relativeIdx) => {
              const absoluteIdx = startIndex + relativeIdx;
              return (
                <div
                  key={absoluteIdx}
                  className={`grid-row ${absoluteIdx % 2 === 0 ? 'even' : 'odd'}`}
                  style={{
                    position: 'absolute',
                    top: `${absoluteIdx * rowHeight}px`,
                    height: `${rowHeight}px`,
                    left: 0,
                    right: 0,
                    display: 'flex',
                  }}
                >
                  <div className="grid-idx">{absoluteIdx + 1}</div>
                  {row.map((val, colIdx) => {
                    const isNull = val === null;
                    const displayValue = isNull
                      ? 'NULL'
                      : typeof val === 'object'
                      ? JSON.stringify(val)
                      : String(val);
                    return (
                      <div key={colIdx} className={`grid-cell ${isNull ? 'null' : ''}`} title={displayValue}>
                        {displayValue}
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
        <span>{rows.length} rows</span>
        {columns.length > 0 && <span>{columns.length} columns</span>}
      </div>
    </div>
  );
};
