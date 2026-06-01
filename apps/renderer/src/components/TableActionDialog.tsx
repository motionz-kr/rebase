import React, { useMemo, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { buildRenameTable, buildTruncateTable, buildDropTable, type Driver } from '../lib/ddlBuilder';
import { runDdl } from '../lib/runDdl';

export type TableAction = 'rename' | 'truncate' | 'drop';

interface Props {
  profileId: string;
  driver: Driver;
  table: string;
  action: TableAction;
  onClose: () => void;
  onApplied: () => void;
}

const TITLE: Record<TableAction, string> = {
  rename: '테이블 이름 변경',
  truncate: '테이블 비우기 (TRUNCATE)',
  drop: '테이블 삭제 (DROP)',
};

export const TableActionDialog: React.FC<Props> = ({ profileId, driver, table, action, onClose, onApplied }) => {
  const [newName, setNewName] = useState(table);
  const [confirmText, setConfirmText] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statements = useMemo(() => {
    if (action === 'rename') {
      return newName.trim() && newName.trim() !== table ? buildRenameTable(driver, table, newName.trim()) : [];
    }
    if (action === 'truncate') return buildTruncateTable(driver, table);
    return buildDropTable(driver, table);
  }, [action, driver, table, newName]);

  const destructive = action === 'truncate' || action === 'drop';
  const confirmed = !destructive || confirmText.trim() === table;
  const canRun = statements.length > 0 && confirmed && !running;

  const apply = async () => {
    setRunning(true);
    setError(null);
    const res = await runDdl(profileId, statements);
    setRunning(false);
    if (res.ok) {
      onApplied();
      onClose();
    } else {
      setError(res.error || '실행 실패');
    }
  };

  const preview = statements.join(';\n') + (statements.length ? ';' : '');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{TITLE[action]} · <span className="mono">{table}</span></h3>
          <button className="icon-btn" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        {action === 'rename' && (
          <label className="form-row">
            <span className="form-label">새 이름</span>
            <input className="input" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
        )}

        <div className="ddl-preview">
          <div className="ddl-preview-head">생성될 SQL</div>
          <pre className="ddl-block">{preview || '— 변경 없음 —'}</pre>
        </div>

        {destructive && (
          <label className="form-row">
            <span className="form-label danger">
              되돌릴 수 없습니다. 진행하려면 테이블 이름 <b>{table}</b> 을(를) 입력하세요
            </span>
            <input className="input" autoFocus value={confirmText} placeholder={table}
              onChange={(e) => setConfirmText(e.target.value)} />
          </label>
        )}

        {error && (<div className="alert error"><AlertTriangle size={14} /><span>{error}</span></div>)}

        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
          <button className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`} onClick={apply} disabled={!canRun}>
            {running ? <span className="spinner" /> : null} {action === 'drop' ? '삭제' : action === 'truncate' ? '비우기' : '변경'}
          </button>
        </div>
      </div>
    </div>
  );
};
