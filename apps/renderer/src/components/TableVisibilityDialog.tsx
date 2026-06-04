import React, { useMemo, useState } from 'react';
import { X, Search } from 'lucide-react';

interface Props {
  db: string;
  tables: string[];
  hidden: string[];
  onApply: (hidden: string[]) => void;
  onClose: () => void;
}

// Pick which tables are visible in the schema tree. Checked = visible; the
// returned `hidden` list is everything left unchecked.
export const TableVisibilityDialog: React.FC<Props> = ({ db, tables, hidden, onApply, onClose }) => {
  const [visible, setVisible] = useState<Set<string>>(() => new Set(tables.filter((t) => !hidden.includes(t))));
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tables.filter((t) => t.toLowerCase().includes(q)) : tables;
  }, [tables, query]);

  const toggle = (t: string) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const apply = () => {
    onApply(tables.filter((t) => !visible.has(t)));
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            테이블 표시 — <span className="mono">{db}</span>
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            <X size={15} />
          </button>
        </div>

        <div className="tv-toolbar">
          <div className="tv-search">
            <Search size={13} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="테이블 검색…" autoFocus />
          </div>
          <span className="tv-count">
            {visible.size}/{tables.length} 표시
          </span>
          <button className="btn btn-secondary btn-xs" onClick={() => setVisible(new Set(tables))}>
            전체 선택
          </button>
          <button className="btn btn-secondary btn-xs" onClick={() => setVisible(new Set())}>
            전체 해제
          </button>
        </div>

        <div className="tv-list">
          {shown.length === 0 ? (
            <div className="tv-empty">일치하는 테이블이 없습니다.</div>
          ) : (
            shown.map((t) => (
              <label className="tv-item" key={t}>
                <input type="checkbox" checked={visible.has(t)} onChange={() => toggle(t)} />
                <span>{t}</span>
              </label>
            ))
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>
            취소
          </button>
          <button className="btn btn-primary" onClick={apply}>
            적용
          </button>
        </div>
      </div>
    </div>
  );
};
