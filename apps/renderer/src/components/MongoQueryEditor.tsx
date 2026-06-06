import React, { useState, useEffect } from 'react';
import { AlertTriangle, Play, LayoutGrid, Braces, Save } from 'lucide-react';
import { parseMongoCommand } from '../lib/mongoQuery';
import { MongoResultView } from './MongoResultView';

interface Props {
  profileId: string;
  /** Currently selected collection context (database used for execution). */
  view: { database: string; collection: string } | null;
  /** Bump the history panel after a query runs. */
  onRan?: () => void;
  /** Bump the saved-queries panel after a query is saved. */
  onSaved?: () => void;
  /** Load a command (from saved/history) into the editor. Does not auto-run. */
  loadRequest?: { text: string; nonce: number };
}

const PLACEHOLDER = 'db.collection.find({})';

export const MongoQueryEditor: React.FC<Props> = ({ profileId, view, onRan, onSaved, loadRequest }) => {
  const [text, setText] = useState('');
  const [documents, setDocuments] = useState<string[]>([]);
  const [countResult, setCountResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [display, setDisplay] = useState<'grid' | 'json'>('json');
  const [ran, setRan] = useState(false);

  // Load a command from the saved-queries / history sidebar into the editor
  // (without running it — the user presses run).
  useEffect(() => {
    if (!loadRequest) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(loadRequest.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRequest?.nonce]);

  // Record the raw command into the cross-driver query history (same shape as
  // the SQL editor) so the History panel renders mongo runs.
  const recordHistory = (raw: string, startTime: number, success: boolean, errorMessage: string | null, rowCount: number | null) => {
    window.electronAPI
      .addQueryHistory({
        workspaceId: 'default',
        profileId,
        queryText: raw,
        durationMs: Date.now() - startTime,
        success,
        errorMessage,
        rowCount,
      })
      .then(() => onRan?.())
      .catch((err) => console.error('Failed to log mongo history:', err));
  };

  const run = async () => {
    setError(null);
    setCountResult(null);
    if (!view) {
      setError('먼저 사이드바에서 컬렉션을 선택하세요.');
      return;
    }
    const raw = text;
    const parsed = parseMongoCommand(raw);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    const { database } = view;
    const collection = parsed.collection;
    setLoading(true);
    setRan(true);
    const startTime = Date.now();
    try {
      if (parsed.op === 'find') {
        const res = await window.electronAPI.mongoFind(profileId, database, collection, {
          filter: parsed.filter,
          projection: parsed.projection,
          sort: parsed.sort,
          skip: parsed.skip,
          limit: parsed.limit,
        });
        if (res.success && res.data) {
          setDocuments(res.data.documents);
          recordHistory(raw, startTime, true, null, res.data.documents.length);
        } else {
          setError(res.error || '실행 실패');
          recordHistory(raw, startTime, false, res.error || '실행 실패', null);
        }
      } else if (parsed.op === 'aggregate') {
        const res = await window.electronAPI.mongoAggregate(profileId, database, collection, parsed.pipeline, parsed.limit);
        if (res.success && res.data) {
          setDocuments(res.data.documents);
          recordHistory(raw, startTime, true, null, res.data.documents.length);
        } else {
          setError(res.error || '실행 실패');
          recordHistory(raw, startTime, false, res.error || '실행 실패', null);
        }
      } else {
        const res = await window.electronAPI.mongoCount(profileId, database, collection, parsed.filter);
        if (res.success && res.data) {
          setDocuments([]);
          setCountResult(res.data.count);
          recordHistory(raw, startTime, true, null, res.data.count);
        } else {
          setError(res.error || '실행 실패');
          recordHistory(raw, startTime, false, res.error || '실행 실패', null);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '실행 중 오류';
      setError(msg);
      recordHistory(raw, startTime, false, msg, null);
    } finally {
      setLoading(false);
    }
  };

  const saveCommand = async () => {
    const raw = text.trim();
    if (!raw) return;
    const name = window.prompt('저장할 이름', raw.slice(0, 40));
    if (!name || !name.trim()) return;
    try {
      const res = await window.electronAPI.saveQuery({
        workspaceId: 'default',
        profileId,
        name: name.trim(),
        queryText: raw,
        isFavorite: false,
      });
      if (res.success) onSaved?.();
      else alert('저장 실패: ' + (res.error || 'Unknown error'));
    } catch (err) {
      alert('저장 오류: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  return (
    <div className="mongo-pane">
      <div className="mongo-query-head">
        <textarea
          className="mono mongo-query-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void run();
            }
          }}
        />
        <div className="mongo-query-actions">
          <button className="btn btn-primary btn-sm" onClick={() => void run()} disabled={loading}>
            <Play size={13} /> 실행
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => void saveCommand()} disabled={!text.trim()}>
            <Save size={13} /> 저장
          </button>
          <span className="muted mongo-query-hint">{view ? `${view.database}` : '컬렉션 미선택'}</span>
          <span className="mongo-spacer" />
          <div className="seg-tabs mongo-display-toggle">
            <button className={`seg-tab ${display === 'grid' ? 'active' : ''}`} onClick={() => setDisplay('grid')} title="그리드">
              <LayoutGrid size={13} />
            </button>
            <button className={`seg-tab ${display === 'json' ? 'active' : ''}`} onClick={() => setDisplay('json')} title="JSON">
              <Braces size={13} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="alert error alert-inline">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="mongo-result-body">
        {loading ? (
          <div className="load-center">
            <span className="spinner" /> 실행 중…
          </div>
        ) : countResult !== null ? (
          <div className="mongo-count-result mono">count: {countResult}</div>
        ) : ran ? (
          <MongoResultView documents={documents} view={display} collectionName={view?.collection} />
        ) : (
          <div className="muted mongo-empty">mongosh 읽기 명령을 입력하고 실행하세요. 예: {PLACEHOLDER}</div>
        )}
      </div>
    </div>
  );
};
