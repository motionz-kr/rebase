import React, { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { fallbackQueryTitle } from '../lib/queryTitle';
import { filterQueryHistory, type QueryHistoryStatusFilter } from '../lib/queryHistory';

interface QueryHistoryEntry {
  id: string;
  workspaceId: string;
  profileId: string;
  name?: string;
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<QueryHistoryStatusFilter>('all');

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, refreshTrigger]);

  const displayedHistory = filterQueryHistory(history, search, statusFilter);

  return (
    <div className="list-panel">
      <div className="panel-head">
        <div>
          <h3>History</h3>
          <p>{displayedHistory.length} of {history.length} recent executions</p>
        </div>
      </div>

      <div className="history-controls">
        <label className="history-search">
          <Search size={14} aria-hidden="true" />
          <input
            className="input"
            type="search"
            aria-label="Search query history"
            placeholder="Search title or SQL"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          className="input history-status-filter"
          aria-label="Filter query history by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as QueryHistoryStatusFilter)}
        >
          <option value="all">All results</option>
          <option value="success">Successful</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : displayedHistory.length > 0 ? (
        displayedHistory.map((entry) => (
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
            <div className="hist-title">{entry.name?.trim() || fallbackQueryTitle(entry.queryText)}</div>
            <pre className="hist-preview">{entry.queryText}</pre>
            {entry.errorMessage && <div className="hist-err">{entry.errorMessage}</div>}
            <div className="hist-time">{new Date(entry.executedAt).toLocaleString()}</div>
          </div>
        ))
      ) : (
        <div className="muted history-empty">
          {history.length === 0 ? 'No query history yet.' : 'No executions match these filters.'}
        </div>
      )}
    </div>
  );
};
