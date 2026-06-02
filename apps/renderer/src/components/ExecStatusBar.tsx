import React, { useState } from 'react';
import { CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, Clock } from 'lucide-react';

export interface ExecInfo {
  sql: string;
  durationMs: number;
  rowsAffected?: number | null; // writes / DML
  rowCount?: number | null; // SELECTs (rows returned)
  error?: string | null;
}

// A compact one-line "what just ran" bar shown under a result area: the executed
// SQL (single line), how long it took, and how many rows were returned/affected.
// Click to expand the full statement.
export const ExecStatusBar: React.FC<{ info: ExecInfo | null }> = ({ info }) => {
  const [open, setOpen] = useState(false);
  if (!info) return null;

  const oneLine = info.sql.replace(/\s+/g, ' ').trim();
  const ok = !info.error;
  const count =
    info.error != null
      ? '실패'
      : info.rowCount != null
      ? `${info.rowCount.toLocaleString()} rows`
      : info.rowsAffected != null
      ? `${info.rowsAffected.toLocaleString()}개 적용`
      : '완료';

  return (
    <div className={`exec-status ${ok ? 'ok' : 'err'} ${open ? 'open' : ''}`}>
      <button className="exec-line" onClick={() => setOpen((o) => !o)} title={open ? '접기' : '자세히 보기'}>
        <span className="exec-chevron">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="exec-icon">{ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}</span>
        <span className="exec-sql mono">{oneLine || '(빈 쿼리)'}</span>
        <span className="exec-meta">
          <Clock size={11} /> {info.durationMs.toLocaleString()} ms · {count}
        </span>
      </button>
      {open && (
        <div className="exec-detail">
          <pre className="exec-sql-full mono">{info.sql}</pre>
          {info.error && <div className="exec-err-msg">{info.error}</div>}
        </div>
      )}
    </div>
  );
};
