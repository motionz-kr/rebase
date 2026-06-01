import React, { useState, useEffect } from 'react';
import { KeyRound, RefreshCw, AlertTriangle, ShieldCheck, Database } from 'lucide-react';
import type { RedisValueInfo } from '../global';

interface RedisValueInspectorProps {
  profileId: string;
  redisKey: string | null;
}

export const RedisValueInspector: React.FC<RedisValueInspectorProps> = ({ profileId, redisKey }) => {
  const [info, setInfo] = useState<RedisValueInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    if (redisKey) {
      loadValue(() => ignore);
    } else {
      setInfo(null);
    }
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, redisKey]);

  const loadValue = async (isStale?: () => boolean) => {
    if (!redisKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.redisValue(profileId, redisKey);
      if (isStale?.()) return;
      if (res.success && res.data) {
        setInfo(res.data);
      } else {
        setError(res.error || 'Failed to inspect key value');
      }
    } catch (e: any) {
      if (isStale?.()) return;
      setError(e.message || 'Error occurred inspecting value');
    } finally {
      if (!isStale?.()) setLoading(false);
    }
  };

  if (!redisKey) {
    return (
      <div className="empty-state full">
        <div className="es-icon">
          <Database size={22} />
        </div>
        <h2>Redis inspector</h2>
        <p>Select a key from the sidebar to inspect its type, TTL, and value.</p>
      </div>
    );
  }

  const ttlText = (ttl: number) =>
    ttl === -1 ? 'No expiry' : ttl === -2 ? 'Expired / missing' : `${ttl}s`;

  let content: React.ReactNode = null;
  if (info && info.exists !== false) {
    try {
      if (info.type === 'hash') {
        const obj = JSON.parse(info.value);
        content = (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(obj).map(([f, v]) => (
                <tr key={f}>
                  <td className="dim">{f}</td>
                  <td>{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      } else if (info.type === 'zset') {
        const list = JSON.parse(info.value) as Array<{ member: string; score: number }>;
        content = (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Score</th>
                <th>Member</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item, idx) => (
                <tr key={idx}>
                  <td className="accent">{item.score}</td>
                  <td>{item.member}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      } else if (info.type === 'list' || info.type === 'set') {
        const list = JSON.parse(info.value) as string[];
        content = (
          <table className="kv-table">
            <thead>
              <tr>
                <th>{info.type === 'list' ? 'Index' : '#'}</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item, idx) => (
                <tr key={idx}>
                  <td className="dim">{idx}</td>
                  <td>{item}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      } else {
        content = <div className="value-raw">{info.value}</div>;
      }
    } catch {
      content = <div className="value-raw">{info.value}</div>;
    }
  }

  const missing = info && info.exists === false;

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="inspector-key">
          <span className="tree-icon">
            <KeyRound size={15} />
          </span>
          <h2>{redisKey}</h2>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => loadValue()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <div className="inspector-body">
        {loading && (
          <div className="load-center">
            <span className="spinner lg" /> Loading value…
          </div>
        )}

        {error && (
          <div className="alert error">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        {!loading && missing && (
          <div className="alert error">
            <AlertTriangle size={14} />
            <span>This key does not exist (it may have expired).</span>
          </div>
        )}

        {!loading && info && info.exists !== false && (
          <>
            <div className="meta-row">
              <div className="meta-card">
                <span className="meta-label">Type</span>
                <span className="meta-value">
                  <span className="badge type">{info.type.toUpperCase()}</span>
                </span>
              </div>
              <div className="meta-card">
                <span className="meta-label">TTL</span>
                <span className="meta-value">{ttlText(info.ttl)}</span>
              </div>
            </div>

            <div className="value-block-head">
              <h3>Value{info.type !== 'string' ? ' (tabular)' : ''}</h3>
              <span className="status-pill">
                <ShieldCheck size={13} /> Read-only
              </span>
            </div>

            {info.truncated && (
              <div className="alert" style={{ background: 'var(--amber-soft)', color: 'var(--amber)', marginBottom: 10 }}>
                <AlertTriangle size={14} />
                <span>Preview truncated to the first 100 elements.</span>
              </div>
            )}

            {content}
          </>
        )}
      </div>
    </div>
  );
};
