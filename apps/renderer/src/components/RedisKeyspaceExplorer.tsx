import React, { useState, useEffect } from 'react';
import { KeyRound, AlertTriangle, RefreshCw } from 'lucide-react';

interface RedisKeyspaceExplorerProps {
  profileId: string;
  onSelectKey: (key: string) => void;
  selectedKey: string | null;
  onDisconnect: () => void;
  /** Bumped by the parent to force a re-scan (e.g. after a key rename/delete). */
  refreshToken?: number;
}

export const RedisKeyspaceExplorer: React.FC<RedisKeyspaceExplorerProps> = ({ profileId, onSelectKey, selectedKey, refreshToken = 0 }) => {
  const [keys, setKeys] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [pattern, setPattern] = useState('*');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadInitialKeys('*');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  // Re-scan with the current filter when the parent bumps the refresh token.
  useEffect(() => {
    if (refreshToken === 0) return;
    loadInitialKeys(pattern);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

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

      <div className="redis-keys-bar">
        <span className="redis-keys-count">
          {keys.length}
          {cursor > 0 ? '+' : ''} {keys.length === 1 ? 'key' : 'keys'}
        </span>
        <button
          className="icon-btn"
          title="Re-scan keys"
          onClick={() => loadInitialKeys(pattern)}
          disabled={loading}
        >
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
        </button>
      </div>

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
