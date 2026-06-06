import React, { useEffect, useState } from 'react';
import { AlertTriangle, Search, Plus, ChevronLeft, ChevronRight, LayoutGrid, Braces } from 'lucide-react';
import { MongoResultView } from './MongoResultView';
import { MongoDocEditor } from './MongoDocEditor';
import { extractId } from '../lib/mongoDoc';

interface Props {
  profileId: string;
  database: string;
  collection: string;
}

const DEFAULT_LIMIT = 20;

export const MongoDocumentView: React.FC<Props> = ({ profileId, database, collection }) => {
  const [filter, setFilter] = useState('{}');
  const [skip, setSkip] = useState(0);
  const [limit] = useState(DEFAULT_LIMIT);
  const [documents, setDocuments] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [display, setDisplay] = useState<'grid' | 'json'>('grid');
  const [editor, setEditor] = useState<
    | { mode: 'insert'; initialJson: string }
    | { mode: 'replace'; initialJson: string; replaceId: string }
    | null
  >(null);

  const runFind = async (atSkip: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.mongoFind(profileId, database, collection, {
        filter,
        skip: atSkip,
        limit,
      });
      if (res.success && res.data) {
        setDocuments(res.data.documents);
        setTotal(res.data.total);
        setSkip(atSkip);
      } else {
        setError(res.error || '조회 실패');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '조회 중 오류');
    } finally {
      setLoading(false);
    }
  };

  // Initial / collection-change load. runFind owns its own loading/result state.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setFilter('{}');
    setSkip(0);
    void runFind(0);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, database, collection]);

  const refresh = () => void runFind(skip);

  const onDelete = async (doc: string) => {
    const id = extractId(doc);
    if (!id) {
      setError('이 문서의 _id를 추출할 수 없어 삭제할 수 없습니다.');
      return;
    }
    if (!window.confirm('이 문서를 삭제할까요?')) return;
    setError(null);
    try {
      const res = await window.electronAPI.mongoDelete(profileId, database, collection, id);
      if (res.success) refresh();
      else setError(res.error || '삭제 실패');
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 중 오류');
    }
  };

  const onEdit = (doc: string) => {
    const id = extractId(doc);
    if (!id) {
      setError('이 문서의 _id를 추출할 수 없어 편집할 수 없습니다.');
      return;
    }
    // Pretty-print for editing.
    let pretty = doc;
    try {
      pretty = JSON.stringify(JSON.parse(doc), null, 2);
    } catch {
      /* keep raw */
    }
    setEditor({ mode: 'replace', initialJson: pretty, replaceId: id });
  };

  const canPrev = skip > 0;
  const canNext = total >= 0 && skip + limit < total;
  const pageEnd = Math.min(skip + documents.length, total >= 0 ? total : skip + documents.length);

  return (
    <div className="mongo-pane">
      <div className="mongo-toolbar">
        <input
          className="input mono mongo-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="{ } — 필터 (JSON)"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runFind(0);
          }}
        />
        <button className="btn btn-primary btn-sm" onClick={() => void runFind(0)} disabled={loading}>
          <Search size={13} /> 조회
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setEditor({ mode: 'insert', initialJson: '{\n  \n}' })}>
          <Plus size={13} /> 문서 추가
        </button>
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

      {error && (
        <div className="alert error alert-inline">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="mongo-result-body">
        {loading ? (
          <div className="load-center">
            <span className="spinner" /> 조회 중…
          </div>
        ) : (
          <MongoResultView documents={documents} view={display} collectionName={collection} onEdit={onEdit} onDelete={onDelete} />
        )}
      </div>

      <div className="mongo-pager">
        <span className="muted">
          {total >= 0 ? `${total === 0 ? 0 : skip + 1}–${pageEnd} / ${total}` : `${skip + 1}–${pageEnd}`}
        </span>
        <span className="mongo-spacer" />
        <button className="btn btn-ghost btn-xs" disabled={!canPrev || loading} onClick={() => void runFind(Math.max(0, skip - limit))}>
          <ChevronLeft size={13} /> 이전
        </button>
        <button className="btn btn-ghost btn-xs" disabled={!canNext || loading} onClick={() => void runFind(skip + limit)}>
          다음 <ChevronRight size={13} />
        </button>
      </div>

      {editor && (
        <MongoDocEditor
          profileId={profileId}
          database={database}
          collection={collection}
          mode={editor.mode}
          initialJson={editor.initialJson}
          replaceId={editor.mode === 'replace' ? editor.replaceId : undefined}
          onClose={() => setEditor(null)}
          onApplied={refresh}
        />
      )}
    </div>
  );
};
