import React, { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { MongoFieldInfo } from '../global';

interface Props {
  profileId: string;
  database: string;
  collection: string;
}

const SAMPLE_SIZE = 200;

export const MongoSchemaPanel: React.FC<Props> = ({ profileId, database, collection }) => {
  const [fields, setFields] = useState<MongoFieldInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.mongoSchema(profileId, database, collection, SAMPLE_SIZE);
      if (res.success && res.data) setFields(res.data.data);
      else setError(res.error || '스키마를 추론하지 못했습니다.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '스키마 추론 중 오류');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, database, collection]);

  return (
    <div className="mongo-pane mongo-panel-pad">
      <div className="mongo-panel-head">
        <h3>
          스키마 추론 · <span className="mono">{collection}</span>
          <span className="muted mongo-sample-note"> (샘플 {SAMPLE_SIZE}개)</span>
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

      <div className="mongo-result-body">
        {loading ? (
          <div className="load-center">
            <span className="spinner" /> 추론 중…
          </div>
        ) : fields.length === 0 ? (
          <div className="muted mongo-empty">필드가 없습니다.</div>
        ) : (
          <div className="mongo-grid-wrap">
            <table className="mongo-grid">
              <thead>
                <tr>
                  <th>path</th>
                  <th>types</th>
                  <th>presence</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.path}>
                    <td className="mono">{f.path}</td>
                    <td className="mono">{f.types.join(', ')}</td>
                    <td className="mono">{Math.round(f.presence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
