import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, AlertTriangle, RotateCcw } from 'lucide-react';
import { buildCreateTable, type CreateColumnSpec, type Driver } from '../lib/ddlBuilder';
import { runDdl } from '../lib/runDdl';

interface Props {
  profileId: string;
  driver: Driver;
  database: string;
  onClose: () => void;
  onApplied: () => void; // success → caller refreshes schema
}

interface Row {
  key: string;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  primaryKey: boolean;
  autoIncrement: boolean;
  unique: boolean;
}

let rowSeq = 0;
const newRow = (init?: Partial<Row>): Row => ({
  key: `cr${rowSeq++}`,
  name: '',
  type: '',
  nullable: true,
  defaultValue: '',
  primaryKey: false,
  autoIncrement: false,
  unique: false,
  ...init,
});

export const CreateTableDialog: React.FC<Props> = ({ profileId, driver, database, onClose, onApplied }) => {
  const [tableName, setTableName] = useState('');
  const [rows, setRows] = useState<Row[]>(() => [
    newRow({ name: 'id', type: 'BIGINT', nullable: false, primaryKey: true, autoIncrement: true }),
  ]);
  const [sql, setSql] = useState('');
  const [dirty, setDirty] = useState(false); // user manually edited the SQL
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (key: string, p: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));

  // The CREATE TABLE statement generated from the form (single statement).
  const generated = useMemo(() => {
    const cols: CreateColumnSpec[] = rows
      .filter((r) => r.name.trim() && r.type.trim())
      .map((r) => ({
        name: r.name.trim(),
        type: r.type.trim(),
        nullable: r.nullable,
        defaultValue: r.defaultValue.trim() || undefined,
        primaryKey: r.primaryKey,
        autoIncrement: r.autoIncrement,
        unique: r.unique,
      }));
    const stmts = tableName.trim() ? buildCreateTable(driver, tableName.trim(), cols) : [];
    return stmts[0] ?? '';
  }, [rows, tableName, driver]);

  // Keep the editable SQL in sync with the form until the user edits it directly.
  useEffect(() => {
    if (!dirty) setSql(generated);
  }, [generated, dirty]);

  const regenerate = () => {
    setDirty(false);
    setSql(generated);
  };

  const canRun = sql.trim() !== '' && !running;

  const apply = async () => {
    setRunning(true);
    setError(null);
    const res = await runDdl(profileId, [sql]);
    setRunning(false);
    if (res.ok) {
      onApplied();
      onClose();
    } else {
      setError(res.error || '실행 실패');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>테이블 추가 · <span className="mono">{database}</span></h3>
          <button className="icon-btn" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        <label className="form-row">
          <span className="form-label">테이블 이름</span>
          <input className="input" autoFocus value={tableName} placeholder="new_table"
            onChange={(e) => setTableName(e.target.value)} />
        </label>

        <div className="ddl-cols">
          <div className="ddl-col-head ddl-col-head-create">
            <span>이름</span><span>타입</span><span>NULL</span><span>기본값</span><span>PK</span><span>AI</span><span>UQ</span><span />
          </div>
          {rows.map((r) => (
            <div key={r.key} className="ddl-col-row ddl-col-row-create">
              <input className="input" value={r.name} placeholder="column" onChange={(e) => patch(r.key, { name: e.target.value })} />
              <input className="input" value={r.type} placeholder="INT / text…" onChange={(e) => patch(r.key, { type: e.target.value })} />
              <input type="checkbox" checked={r.nullable} title="NULL 허용" onChange={(e) => patch(r.key, { nullable: e.target.checked })} />
              <input className="input" value={r.defaultValue} placeholder="(none)" onChange={(e) => patch(r.key, { defaultValue: e.target.value })} />
              <input type="checkbox" checked={r.primaryKey} title="기본키 (PK)" onChange={(e) => patch(r.key, { primaryKey: e.target.checked })} />
              <input type="checkbox" checked={r.autoIncrement} title="자동증가 (AI)" onChange={(e) => patch(r.key, { autoIncrement: e.target.checked })} />
              <input type="checkbox" checked={r.unique} title="UNIQUE (UQ)" onChange={(e) => patch(r.key, { unique: e.target.checked })} />
              <button className="icon-btn" title="행 제거" onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button className="btn btn-secondary btn-xs" onClick={() => setRows((prev) => [...prev, newRow()])}>
            <Plus size={12} /> 컬럼 추가
          </button>
        </div>

        <div className="ddl-preview">
          <div className="ddl-preview-head">
            <span>생성될 SQL{dirty ? ' · 직접 편집됨' : ''}</span>
            <button className="btn btn-secondary btn-xs" onClick={regenerate} disabled={!dirty} title="폼 기준으로 다시 생성">
              <RotateCcw size={12} /> 폼 기준으로 다시 생성
            </button>
          </div>
          <textarea
            className="ddl-sql-edit mono"
            spellCheck={false}
            value={sql}
            onChange={(e) => { setSql(e.target.value); setDirty(true); }}
          />
        </div>

        {error && (
          <div className="alert error"><AlertTriangle size={14} /><span style={{ whiteSpace: 'pre-wrap' }}>{error}</span></div>
        )}

        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
          <button className="btn btn-primary" onClick={apply} disabled={!canRun}>
            {running ? <span className="spinner" /> : null} 실행
          </button>
        </div>
      </div>
    </div>
  );
};
