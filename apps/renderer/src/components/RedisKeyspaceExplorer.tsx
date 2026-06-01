import React, { useState, useEffect } from 'react';
import { KeyRound, AlertTriangle } from 'lucide-react';

interface RedisKeyspaceExplorerProps {
  profileId: string;
  onSelectKey: (key: string) => void;
  selectedKey: string | null;
  onDisconnect: () => void;
}

export const RedisKeyspaceExplorer: React.FC<RedisKeyspaceExplorerProps> = ({ profileId, onSelectKey, selectedKey }) => {
  const [keys, setKeys] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [pattern, setPattern] = useState('*');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadInitialKeys('*');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const loadInitialKeys = async (searchPattern: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.redisScan(profileId, searchPattern, 0, 100);
      if (res.success && res.data) {
        setKeys(res.data.keys);
        setCursor(res.data.cursor);
      } else {
        setError(res.error || 'Failed to scan keys');
      }
    } catch (e: any) {
      setError(e.message || 'Error occurred scanning keys');
    } finally {
      setLoading(false);
    }
  };

  const loadMoreKeys = async () => {
    if (cursor === 0 || loading) return;
    setLoading(true);
    try {
      const res = await window.electronAPI.redisScan(profileId, pattern, cursor, 100);
      if (res.success && res.data) {
        setKeys((prev) => Array.from(new Set([...prev, ...res.data!.keys])));
        setCursor(res.data.cursor);
      } else {
        setError(res.error || 'Failed to scan more keys');
      }
    } catch (e: any) {
      setError(e.message || 'Error occurred scanning keys');
    } finally {
      setLoading(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadInitialKeys(pattern);
  };

  return (
    <>
      <form className="redis-search" onSubmit={handleSearchSubmit}>
        <input type="text" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="Filter (e.g. user:*)" />
        <button type="submit" className="btn btn-secondary btn-sm">
          Scan
        </button>
      </form>

      {error && (
        <div className="alert error alert-inline">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {keys.length === 0 && !loading && !error && <div className="muted">No keys found.</div>}

      <div className="key-list">
        {keys.map((key) => (
          <div
            key={key}
            className={`key-row ${selectedKey === key ? 'active' : ''}`}
            onClick={() => onSelectKey(key)}
            title={key}
          >
            <span className="tree-icon">
              <KeyRound size={13} />
            </span>
            <span className="key-name">{key}</span>
          </div>
        ))}
      </div>

      {loading && (
        <div className="load-center">
          <span className="spinner" /> Scanning…
        </div>
      )}

      {cursor > 0 && !loading && (
        <button className="btn btn-secondary btn-sm load-more" onClick={loadMoreKeys}>
          Load more
        </button>
      )}
    </>
  );
};
