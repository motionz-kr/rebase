import React, { useState, useEffect } from 'react';

interface QueryHistoryEntry {
  id: string;
  workspaceId: string;
  profileId: string;
  queryText: string;
  executedAt: string;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
  rowCount: number | null;
}

interface QueryHistoryProps {
  profileId: string;
  onSelectQuery: (queryText: string) => void;
  refreshTrigger: number;
}

export const QueryHistory: React.FC<QueryHistoryProps> = ({ profileId, onSelectQuery, refreshTrigger }) => {
  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI.listQueryHistory('default', profileId);
      if (res.success && res.data) {
        setHistory(res.data);
      }
    } catch (e) {
      console.error('Failed to load query history:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, refreshTrigger]);

  return (
    <div className="list-panel">
      <div className="panel-head">
        <h3>History</h3>
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : history.length > 0 ? (
        history.map((entry) => (
          <div
            key={entry.id}
            className={`hist-card ${entry.success ? 'ok' : 'fail'}`}
            onClick={() => onSelectQuery(entry.queryText)}
            title="Load into editor"
          >
            <div className="hist-top">
              <span className={`badge ${entry.success ? 'ok' : 'fail'}`}>{entry.success ? 'OK' : 'Failed'}</span>
              <span className="badge meta">{entry.durationMs}ms</span>
              {entry.rowCount !== null && <span className="badge meta">{entry.rowCount} rows</span>}
            </div>
            <pre className="hist-preview">{entry.queryText}</pre>
            {entry.errorMessage && <div className="hist-err">{entry.errorMessage}</div>}
            <div className="hist-time">{new Date(entry.executedAt).toLocaleString()}</div>
          </div>
        ))
      ) : (
        <div className="muted">No query history yet.</div>
      )}
    </div>
  );
};
