import React, { useState } from 'react';
import { AlertTriangle, Play, LayoutGrid, Braces } from 'lucide-react';
import { parseMongoCommand } from '../lib/mongoQuery';
import { MongoResultView } from './MongoResultView';

interface Props {
  profileId: string;
  /** Currently selected collection context (database used for execution). */
  view: { database: string; collection: string } | null;
}

const PLACEHOLDER = 'db.collection.find({})';

export const MongoQueryEditor: React.FC<Props> = ({ profileId, view }) => {
  const [text, setText] = useState('');
  const [documents, setDocuments] = useState<string[]>([]);
  const [countResult, setCountResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [display, setDisplay] = useState<'grid' | 'json'>('json');
  const [ran, setRan] = useState(false);

  const run = async () => {
    setError(null);
    setCountResult(null);
    if (!view) {
      setError('먼저 사이드바에서 컬렉션을 선택하세요.');
      return;
    }
    const parsed = parseMongoCommand(text);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    const { database } = view;
    const collection = parsed.collection;
    setLoading(true);
    setRan(true);
    try {
      if (parsed.op === 'find') {
        const res = await window.electronAPI.mongoFind(profileId, database, collection, {
          filter: parsed.filter,
          projection: parsed.projection,
          sort: parsed.sort,
          skip: parsed.skip,
          limit: parsed.limit,
        });
        if (res.success && res.data) setDocuments(res.data.documents);
        else setError(res.error || '실행 실패');
      } else if (parsed.op === 'aggregate') {
        const res = await window.electronAPI.mongoAggregate(profileId, database, collection, parsed.pipeline, parsed.limit);
        if (res.success && res.data) setDocuments(res.data.documents);
        else setError(res.error || '실행 실패');
      } else {
        const res = await window.electronAPI.mongoCount(profileId, database, collection, parsed.filter);
        if (res.success && res.data) {
          setDocuments([]);
          setCountResult(res.data.count);
        } else {
          setError(res.error || '실행 실패');
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '실행 중 오류');
    } finally {
      setLoading(false);
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
          <MongoResultView documents={documents} view={display} />
        ) : (
          <div className="muted mongo-empty">mongosh 읽기 명령을 입력하고 실행하세요. 예: {PLACEHOLDER}</div>
        )}
      </div>
    </div>
  );
};
