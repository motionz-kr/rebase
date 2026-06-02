import React, { useState, useEffect } from 'react';
import { Star, Trash2 } from 'lucide-react';

interface SavedQuery {
  id: string;
  workspaceId: string;
  profileId: string;
  name: string;
  queryText: string;
  isFavorite: boolean;
  createdAt: string;
}

interface SavedQueriesProps {
  profileId: string;
  onSelectQuery: (queryText: string) => void;
  refreshTrigger: number;
  onRefresh: () => void;
}

export const SavedQueries: React.FC<SavedQueriesProps> = ({ profileId, onSelectQuery, refreshTrigger, onRefresh }) => {
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [filterFavorite, setFilterFavorite] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadQueries = async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI.listSavedQueries('default');
      if (res.success && res.data) {
        setQueries(res.data.filter((q: SavedQuery) => q.profileId === profileId));
      }
    } catch (e) {
      console.error('Failed to load saved queries:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadQueries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, refreshTrigger]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this saved query?')) return;
    try {
      const res = await window.electronAPI.deleteSavedQuery(id);
      if (res.success) {
        loadQueries();
        onRefresh();
      } else {
        alert(res.error || 'Failed to delete query');
      }
    } catch (err) {
      alert('Error deleting query: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleToggleFavorite = async (query: SavedQuery, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await window.electronAPI.saveQuery({ ...query, isFavorite: !query.isFavorite });
      if (res.success) {
        loadQueries();
        onRefresh();
      }
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
  };

  const displayed = filterFavorite ? queries.filter((q) => q.isFavorite) : queries;

  return (
    <div className="list-panel">
      <div className="panel-head">
        <h3>Saved queries</h3>
        <button
          className={`star ${filterFavorite ? 'on' : ''}`}
          onClick={() => setFilterFavorite(!filterFavorite)}
          title={filterFavorite ? 'Show all' : 'Show favorites'}
        >
          <Star size={14} fill={filterFavorite ? 'currentColor' : 'none'} />
        </button>
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : displayed.length > 0 ? (
        displayed.map((q) => (
          <div key={q.id} className="q-card" onClick={() => onSelectQuery(q.queryText)}>
            <div className="q-card-top">
              <span className="q-title" title={q.name}>
                {q.name}
              </span>
              <button className={`star ${q.isFavorite ? 'on' : ''}`} onClick={(e) => handleToggleFavorite(q, e)}>
                <Star size={13} fill={q.isFavorite ? 'currentColor' : 'none'} />
              </button>
            </div>
            <pre className="q-preview">{q.queryText}</pre>
            <div className="q-card-bottom">
              <span className="q-date">{new Date(q.createdAt).toLocaleDateString()}</span>
              <button className="icon-btn danger" onClick={(e) => handleDelete(q.id, e)} title="Delete">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))
      ) : (
        <div className="muted">{filterFavorite ? 'No favorites yet.' : 'No saved queries. Save SQL from the editor.'}</div>
      )}
    </div>
  );
};
