import React, { useEffect, useState } from 'react';
import { X, Trash2, Plus, AlertTriangle, KeyRound } from 'lucide-react';
import type { IndexInfo } from '../global';
import type { Driver } from '../lib/ddlBuilder';
import { buildCreateIndex, buildDropIndex } from '../lib/indexDdl';
import { runBatch } from '../lib/runBatch';

interface Props {
  profileId: string;
  driver: Driver;
  database: string;
  table: string;
  onClose: () => void;
  onChanged?: () => void;
}

export const IndexManagerDialog: React.FC<Props> = ({ profileId, driver, database, table, onClose, onChanged }) => {
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // add-form state
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError(null);
    const [idxRes, descRes] = await Promise.all([
      window.electronAPI.listIndexes(profileId, database, table),
      window.electronAPI.describeTable(profileId, database, table),
    ]);
    if (idxRes.success && idxRes.data) setIndexes(idxRes.data);
    else setError(idxRes.error || '인덱스를 불러오지 못했습니다.');
    if (descRes.success && descRes.data) setColumns(descRes.data.columns.map((c) => c.name));
    setLoading(false);
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, database, table]);

  const togglePick = (col: string) =>
    setPicked((prev) => (prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]));

  const canCreate = name.trim().length > 0 && picked.length > 0 && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const sql = buildCreateIndex(driver, { table, name: name.trim(), columns: picked, unique });
    const res = await runBatch(profileId, [sql]);
    setBusy(false);
    if (!res.ok) {
      setError(res.error || '인덱스 생성 실패');
      return;
    }
    setName('');
    setPicked([]);
    setUnique(false);
    await reload();
    onChanged?.();
  };

  const drop = async (idx: IndexInfo) => {
    if (idx.primary) return;
    if (!window.confirm(`인덱스 "${idx.name}"를 삭제할까요?`)) return;
    setBusy(true);
    setError(null);
    const res = await runBatch(profileId, [buildDropIndex(driver, { table, name: idx.name })]);
    setBusy(false);
    if (!res.ok) {
      setError(res.error || '인덱스 삭제 실패');
      return;
    }
    await reload();
    onChanged?.();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            인덱스 관리 · <span className="mono">{table}</span>
          </h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        {error && (
          <div className="alert error">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        <div className="idx-list">
          {loading ? (
            <div className="idx-empty">로딩…</div>
          ) : indexes.length === 0 ? (
            <div className="idx-empty">인덱스가 없습니다.</div>
          ) : (
            indexes.map((idx) => (
              <div className="idx-row" key={idx.name}>
                <span className="idx-name mono">{idx.name}</span>
                <span className="idx-cols mono">({idx.columns.join(', ')})</span>
                {idx.primary && <span className="idx-badge pk">PK</span>}
                {idx.unique && !idx.primary && <span className="idx-badge uq">UNIQUE</span>}
                <span className="idx-spacer" />
                <button
                  className="btn btn-ghost btn-xs"
                  disabled={idx.primary || busy}
                  title={idx.primary ? 'PK는 테이블 편집에서 변경하세요' : '인덱스 삭제'}
                  onClick={() => drop(idx)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="idx-add">
          <div className="idx-add-head">
            <KeyRound size={13} /> 인덱스 추가
          </div>
          <div className="idx-add-row">
            <input
              className="input"
              placeholder="인덱스 이름 (예: idx_email)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label className="idx-unique">
              <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> UNIQUE
            </label>
          </div>
          <div className="idx-cols-pick">
            {columns.map((col) => (
              <label key={col} className={`idx-col-chip ${picked.includes(col) ? 'on' : ''}`}>
                <input type="checkbox" checked={picked.includes(col)} onChange={() => togglePick(col)} /> {col}
              </label>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>
            닫기
          </button>
          <button className="btn btn-primary" disabled={!canCreate} onClick={create}>
            <Plus size={13} /> 추가
          </button>
        </div>
      </div>
    </div>
  );
};
