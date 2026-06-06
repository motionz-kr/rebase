import React, { useEffect, useState } from 'react';
import { AlertTriangle, Plus, Trash2, KeyRound, RefreshCw } from 'lucide-react';
import type { MongoIndexInfo } from '../global';

interface Props {
  profileId: string;
  database: string;
  collection: string;
}

export const MongoIndexManager: React.FC<Props> = ({ profileId, database, collection }) => {
  const [indexes, setIndexes] = useState<MongoIndexInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // create-form state
  const [keys, setKeys] = useState('{ "field": 1 }');
  const [unique, setUnique] = useState(false);
  const [name, setName] = useState('');

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.mongoIndexes(profileId, database, collection);
      if (res.success && res.data) setIndexes(res.data.data);
      else setError(res.error || '인덱스를 불러오지 못했습니다.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '인덱스 조회 중 오류');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, database, collection]);

  const create = async () => {
    // Validate keys JSON.
    try {
      JSON.parse(keys);
    } catch (e) {
      setError(`잘못된 keys JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await window.electronAPI.mongoCreateIndex(
        profileId,
        database,
        collection,
        keys,
        unique,
        name.trim() || undefined
      );
      if (res.success) {
        setName('');
        setUnique(false);
        await reload();
      } else {
        setError(res.error || '인덱스 생성 실패');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '인덱스 생성 중 오류');
    } finally {
      setBusy(false);
    }
  };

  const drop = async (idx: MongoIndexInfo) => {
    if (idx.name === '_id_') return;
    if (!window.confirm(`인덱스 "${idx.name}"를 삭제할까요?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.electronAPI.mongoDropIndex(profileId, database, collection, idx.name);
      if (res.success) await reload();
      else setError(res.error || '인덱스 삭제 실패');
    } catch (e) {
      setError(e instanceof Error ? e.message : '인덱스 삭제 중 오류');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mongo-pane mongo-panel-pad">
      <div className="mongo-panel-head">
        <h3>
          인덱스 · <span className="mono">{collection}</span>
        </h3>
        <button className="icon-btn" title="새로고침" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="alert error alert-inline">
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
              <span className="idx-cols mono">{idx.keys}</span>
              {idx.name === '_id_' && <span className="idx-badge pk">ID</span>}
              {idx.unique && idx.name !== '_id_' && <span className="idx-badge uq">UNIQUE</span>}
              <span className="idx-spacer" />
              <button
                className="btn btn-ghost btn-xs"
                disabled={idx.name === '_id_' || busy}
                title={idx.name === '_id_' ? '_id 인덱스는 삭제할 수 없습니다' : '인덱스 삭제'}
                onClick={() => void drop(idx)}
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
            className="input mono"
            placeholder='keys (예: { "email": 1 })'
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
          />
        </div>
        <div className="idx-add-row">
          <input
            className="input"
            placeholder="인덱스 이름 (선택)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="idx-unique">
            <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> UNIQUE
          </label>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void create()}>
            <Plus size={13} /> 추가
          </button>
        </div>
      </div>
    </div>
  );
};
